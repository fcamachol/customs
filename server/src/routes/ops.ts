import { Router, type Request, type Response, type NextFunction } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { query } from '../db/pool';
import { refreshVuelosPendientes } from '../services/vuelosService';
import { runAgoraSweep, type SweepSummary } from '../services/agoraSweep';

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
 * TWO INDEPENDENT PHASES run per tick — flights, then the AGORA prealerta sweep — each with its own
 * cursor row and its own error accounting. Neither can abort the other: they answer different
 * questions ("did the plan move?" vs "did a webhook get dropped?") and a provider outage on one side
 * is no reason to stop asking the other.
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
    });
  } catch (err) {
    next(err);
  }
});
