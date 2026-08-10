import { Router, type Request, type Response, type NextFunction } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { query } from '../db/pool';
import { refreshVuelosPendientes } from '../services/vuelosService';
import { runAgoraSweep, type SweepSummary } from '../services/agoraSweep';
import {
  runRequerimientosSweep,
  type RequerimientosTickSummary,
} from '../services/requerimientosService';
import { evaluarPendientes } from '../services/replanService';

export const opsRouter = Router();

/**
 * The scheduler entry point — resolves PRD-02 `Q14`.
 *
 * This repository has no in-process scheduler (no node-cron, no setInterval) and deliberately does
 * not gain one here. Instead an external caller pokes this endpoint on a schedule: a Coolify
 * scheduled task, which adds no dependency, survives restarts, cannot double-fire across replicas,
 * and leaves its own execution record outside the application — which is itself worth having when
 * the whole product is about auditability.
 *
 * Authenticated by a shared secret rather than a JWT because the caller is a machine with no session.
 * Fails closed when the secret is unset.
 *
 * Suggested cadence: every 5 minutes. `refreshVuelosPendientes` only polls casos still in motion and
 * skips any flight queried in the last 4 minutes, so a tighter cadence costs money on a metered
 * provider without buying freshness.
 *
 * FOUR INDEPENDENT PHASES run per tick — flights, the AGORA prealerta sweep, the risk requirements,
 * then the contingency engine — each behind its own try/catch and, where it has one, its own cursor
 * row. None can abort another: they answer different questions ("did the plan move?", "did a webhook
 * get dropped?", "did a client's deadline run out?", "does the plan still make sense?") and a provider
 * outage on one side is no reason to stop asking the others.
 *
 * The ORDER is load-bearing, not alphabetical. Each phase produces facts the next one reads, so the
 * whole chain resolves within a single tick instead of leaking a cycle of latency per hop:
 *
 *   1. Flights first, because they produce the delay/cancellation facts the contingency engine reacts
 *      to — a delay detected at 10:00 becomes an exclusion at 10:00, not five minutes later.
 *   2. The AGORA sweep next, so a prealerta recovered from a dropped webhook is evaluated in the same
 *      tick it arrives.
 *   3. The risk requirements next, because expiry is a WRITE the engine reads: it opens the CT-4
 *      `riesgo` hold and walks `estado_documental` to `riesgo_vencido`. Running it before phase 4
 *      means a deadline that ran out at 09:58 is reflected in the dispatch plan on this tick.
 *   4. The contingency engine last, so it sees everything the first three just wrote.
 *
 * Phases 3 and 4 both touch `riesgo` holds and deliberately do not collide: each checks for an already
 * active hold of that tipo on the caso before inserting (requerimientosService reuses it, replanService
 * skips the action and records `omitido`), so the freeze is opened exactly once regardless of order.
 */
function authorizeTick(req: Request): boolean {
  const expected = process.env.OPS_TICK_TOKEN;
  if (!expected) return false;
  const provided =
    req.header('x-ops-token') ??
    (req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

opsRouter.post('/tick', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!process.env.OPS_TICK_TOKEN) {
      console.error('[ops] OPS_TICK_TOKEN no está configurado — el tick está deshabilitado');
      res.status(503).json({ error: 'Tick no configurado' });
      return;
    }
    if (!authorizeTick(req)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const startedAt = Date.now();

    // ---- Phase 1: flights. Wrapped so a flight-feed outage cannot cost us the prealerta sweep,
    // which is the phase that recovers cargo nobody would otherwise know about.
    let vuelos: Awaited<ReturnType<typeof refreshVuelosPendientes>> = [];
    let vuelosError: string | null = null;
    try {
      vuelos = await refreshVuelosPendientes(Math.min(Number(req.query.limit ?? 100) || 100, 500));
    } catch (err) {
      vuelosError = err instanceof Error ? err.message : String(err);
      console.error('[ops] la fase de vuelos falló:', err);
    }

    // Record the run on the cursor row so a silently dead scheduler is visible as a stale
    // `last_run_at` rather than as an absence of evidence.
    const errores = vuelos.filter((v) => v.status === 'error_proveedor');
    // Every placeholder is cast explicitly: inside a CASE, Postgres cannot infer the type of a bare
    // parameter and fails with 42P08 "could not determine data type".
    await query(
      `UPDATE integracion_cursores
          SET last_run_at = now(),
              last_error = $1::text,
              consecutive_errors = CASE WHEN $1::text IS NULL THEN 0
                                        ELSE consecutive_errors + 1 END,
              updated_at = now()
        WHERE fuente = 'vuelos'`,
      [
        vuelosError
          ? `la fase de vuelos falló: ${vuelosError}`
          : errores.length
            ? `${errores.length} operaciones con error de proveedor`
            : null,
      ],
    );

    // ---- Phase 2: the AGORA reconciliation sweep. The webhook is the fast path and this is the
    // safety net for the deliveries it dropped, so it runs on the same tick — one scheduled poke,
    // both "did the flight move?" and "did we miss a prealerta?".
    //
    // `runAgoraSweep` owns the `agora_prealertas` cursor (it is the only reader of the watermark, so
    // splitting the read here from the write there would be a race waiting to happen) and does not
    // throw for AGORA or network trouble. The try/catch is for the unexpected: a sweep bug must not
    // turn a successful flight phase into a 500 and a scheduler alert.
    let sweep: SweepSummary | { ok: boolean; error: string };
    try {
      sweep = await runAgoraSweep();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[ops] el barrido de prealertas falló:', err);
      sweep = { ok: false, error: message };
    }

    // ---- Phase 3: risk requirements (PRD-02 R18/D13 → CT-4). Two steps inside one call: retry the
    // notifications that never went out because SMTP was unreachable (#22), then expire the deadlines
    // that ran out — and ONLY for requerimientos the client was actually told about. This is the phase
    // that freezes cargo, so it runs before the contingency engine (phase 4), which reads that freeze
    // and the `riesgo_vencido` documental state it produces. Behind its own guard: a bug here must not
    // cost us the flight refresh, and above all must not 500 the tick into a scheduler alert loop.
    let requerimientos: RequerimientosTickSummary | { ok: boolean; error: string };
    try {
      requerimientos = await runRequerimientosSweep();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[ops] el barrido de requerimientos falló:', err);
      requerimientos = { ok: false, error: message };
    }

    // ---- Phase 4: the contingency engine (PRD-02 §8.8, CT-1…CT-7). Runs LAST so it sees everything
    // the earlier phases just wrote — the flight facts from phase 1 and the CT-4 freezes from phase 3.
    // It re-derives the same conclusions every tick by design and writes
    // only what is new (`claveAccion` fingerprints), so a cancelled flight produces one exclusion, not
    // one per cycle. Wrapped like the others: a replanning bug must not turn a successful flight
    // refresh into a 500 and a scheduler alert.
    let replan: Awaited<ReturnType<typeof evaluarPendientes>> = [];
    let replanError: string | null = null;
    try {
      replan = await evaluarPendientes(Math.min(Number(req.query.limit ?? 100) || 100, 500));
    } catch (err) {
      replanError = err instanceof Error ? err.message : String(err);
      console.error('[ops] la fase de contingencias falló:', err);
    }

    // Its own cursor row, for the same reason the flight phase has one: "no contingencies today" and
    // "nothing has evaluated contingencies since Tuesday" must not look identical from the outside.
    await query(
      `UPDATE integracion_cursores
          SET last_run_at = now(),
              last_error = $1::text,
              consecutive_errors = CASE WHEN $1::text IS NULL THEN 0
                                        ELSE consecutive_errors + 1 END,
              updated_at = now()
        WHERE fuente = 'replan'`,
      [replanError ? `la fase de contingencias falló: ${replanError}` : null],
    );

    res.json({
      ok: true,
      durationMs: Date.now() - startedAt,
      vuelos: {
        revisadas: vuelos.length,
        actualizadas: vuelos.filter((v) => v.status === 'actualizado').length,
        sinCambio: vuelos.filter((v) => v.status === 'sin_cambio').length,
        noIdentificadas: vuelos.filter((v) => v.status === 'no_identificado').length,
        sinVueloDeclarado: vuelos.filter((v) => v.status === 'sin_vuelo_declarado').length,
        errores: errores.length,
        ...(vuelosError ? { error: vuelosError } : {}),
        detalle: vuelos,
      },
      sweep,
      requerimientos,
      replan: {
        evaluadas: replan.length,
        conAcciones: replan.filter((r) => r.accionesNuevas > 0).length,
        ejecutadas: replan.reduce((n, r) => n + r.ejecutadas, 0),
        propuestas: replan.reduce((n, r) => n + r.propuestas, 0),
        ...(replanError ? { error: replanError } : {}),
        detalle: replan.filter((r) => r.accionesNuevas > 0),
      },
    });
  } catch (err) {
    next(err);
  }
});
