import { Router, type Request, type Response, type NextFunction } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { query } from '../db/pool';
import { refreshVuelosPendientes } from '../services/vuelosService';

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
    const vuelos = await refreshVuelosPendientes(
      Math.min(Number(req.query.limit ?? 100) || 100, 500),
    );

    // Record the run on the cursor row so a silently dead scheduler is visible as a stale
    // `last_run_at` rather than as an absence of evidence.
    const errores = vuelos.filter((v) => v.status === 'error_proveedor');
    await query(
      `UPDATE integracion_cursores
          SET last_run_at = now(),
              last_error = $2,
              consecutive_errors = CASE WHEN $2 IS NULL THEN 0 ELSE consecutive_errors + 1 END,
              updated_at = now()
        WHERE fuente = 'vuelos'`,
      [null, errores.length ? `${errores.length} operaciones con error de proveedor` : null],
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
        detalle: vuelos,
      },
    });
  } catch (err) {
    next(err);
  }
});
