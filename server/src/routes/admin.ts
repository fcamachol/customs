import { Router, type NextFunction, type Request, type Response } from 'express';
import { unlink } from 'node:fs/promises';
import { withTransaction } from '../db/tx';
import { requireAuth, requireRole } from '../auth/middleware';
import { recordAudit } from '../services/audit';
import { isDemoMode } from '../auth/roles';

export const adminRouter = Router();

/**
 * demoOnly — first gate on the reset endpoint. When DEMO_MODE !== 'true' the route
 * responds 404 so a non-demo deployment does not even reveal the feature's existence.
 * Placed before requireAuth so the 404 is returned regardless of credentials.
 */
function demoOnly(_req: Request, res: Response, next: NextFunction): void {
  if (!isDemoMode()) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  next();
}

/**
 * The Sistema de Operaciones surface, in FK-safe order — PRD-02 §8.5's gap, closed.
 *
 * WHY THIS LIST HAD TO EXIST. `demo-reset` predates the operations system: it wiped manifests, their
 * cascade and the files table, and nothing else. Every table added from PRD-02 onwards — casos,
 * prealertas, the freeze layer, the contingency engine's records, trips, plans, PODs, invoices,
 * carriers, convenios — survived the reset, so a "pristine" demo started with yesterday's trucks on
 * today's board and the operator had no way to tell whether what they saw was seeded or real. That is
 * a demo tool telling a lie about state, which is the one thing this codebase is built not to do.
 *
 * TRUNCATE, NOT DELETE, AND THAT IS LOAD-BEARING. `operacion_eventos` carries a BEFORE UPDATE OR
 * DELETE trigger that makes the ledger append-only (migration 1700003900000); a `DELETE` against it
 * raises. `TRUNCATE` does not fire row-level triggers, which is exactly how `test/helpers/db.ts`
 * resets the same table, and it is legitimate here for the same reason: this is a whole-table reset
 * under an explicit demo gate, not an attempt to erase one inconvenient row.
 *
 * THE ORDER IS FK ORDER AND THE LIST IS EXPLICIT — no `CASCADE`. One statement truncates them
 * together, so no intermediate state ever violates a constraint. Explicit rather than cascading
 * because CASCADE would silently reach whatever a future migration attaches, and a reset that quietly
 * grows its own blast radius is how a survivor table (`clients`, `users`) eventually stops surviving.
 * If a new ops table is added and not listed here, Postgres refuses the statement by name — a loud
 * failure in a test instead of a quiet leftover in a demo.
 *
 * THIS MUST RUN BEFORE `DELETE FROM files`. `operacion_evidencias.file_id` is ON DELETE RESTRICT (a
 * field-captured photo must not be deletable out from under its event), so with any campo evidence on
 * file the old ordering would have failed the whole request.
 *
 * NOT TRUNCATED, deliberately: `integracion_cursores`. Those rows are seeded by migration and are the
 * scheduler's watermark, not demo data — removing them does not reset the tick, it breaks it.
 */
const TABLAS_OPERACIONES = [
  'operacion_eventos',
  'operacion_evidencias',
  'operacion_guias',
  'operacion_holds',
  'retenciones',
  'riesgo_requerimientos',
  'replan_acciones',
  'replan_evaluaciones',
  'prealerta_adjuntos',
  'prealertas',
  'despacho_partidas',
  'despachos',
  'plan_publicaciones',
  'pods',
  'factura_partidas',
  'facturas',
  'client_tarifas',
  'client_direcciones',
  'transportista_tarifas',
  'transportista_convenios',
  'transportista_unidades',
  'transportistas',
  'convenios',
  'operaciones',
  'vuelos',
] as const;

/**
 * POST /api/admin/demo-reset — wipe operational data (manifests + everything derived
 * from them, the whole Sistema de Operaciones surface, plus every stored file row/blob —
 * including never-referenced rows left by abandoned uploads) so a demo can restart from a
 * pristine DB. Preserves users, clients, platforms, catalogs, header mappings, compliance
 * config, validated RFCs, the scheduler cursors, and the append-only audit log (which
 * instead gains a DEMO_RESET trace).
 *
 * RELATIONSHIP TO `RESET_DATA_KEEP_USERS` (`server/scripts/resetData.ts`, run by
 * `docker-entrypoint.sh` on every boot while the flag is `true`): they are two different tools and
 * neither is changed by the other. The boot script truncates EVERY public table except `users` and
 * `pgmigrations` by enumerating `pg_tables`, so it needs no list and already covered these tables;
 * it is the operator's one-shot "start this deployment over", gated on an env var that has to be
 * unset again by hand. This endpoint is the in-app, DEMO_MODE-gated, authenticated, audited reset
 * that keeps clients and catalogs — the thing a person clicks between demos. Nothing here touches
 * boot behaviour.
 *
 * Gates: DEMO_MODE=true (else 404) + role admin/super_admin (else 403).
 */
adminRouter.post(
  '/demo-reset',
  demoOnly,
  requireAuth,
  requireRole('admin', 'super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await withTransaction(async (q) => {
        // Counts for the response/audit payload, taken in ONE statement so they all
        // come from the same snapshot as each other (under READ COMMITTED, separate
        // statements could undercount vs. the DELETE below).
        const counts = await q(
          `SELECT (SELECT count(*) FROM manifests)::int    AS manifests,
                  (SELECT count(*) FROM pedimentos)::int   AS pedimentos,
                  (SELECT count(*) FROM shipments)::int    AS shipments,
                  (SELECT count(*) FROM operaciones)::int  AS operaciones,
                  (SELECT count(*) FROM prealertas)::int   AS prealertas,
                  (SELECT count(*) FROM despachos)::int    AS despachos,
                  (SELECT count(*) FROM pods)::int         AS pods,
                  (SELECT count(*) FROM facturas)::int     AS facturas,
                  (SELECT count(*) FROM transportistas)::int AS transportistas,
                  (SELECT count(*) FROM convenios)::int    AS convenios`,
        );
        const opsCounts = counts.rows[0] as Record<string, number>;

        // The operations surface first — see TABLAS_OPERACIONES for why TRUNCATE, why this order,
        // and why this has to precede the `files` delete (operacion_evidencias.file_id is RESTRICT).
        await q(`TRUNCATE ${TABLAS_OPERACIONES.join(', ')} RESTART IDENTITY`);

        // One delete drives the cascade. ON DELETE CASCADE FKs remove shipments,
        // pedimentos, pedimento_scans, manifest_staging_rows, and monthly_history rows
        // that carry a manifest_id — all in this statement.
        await q(`DELETE FROM manifests`);

        // Manifest-derived rows WITHOUT a cascade path, removed explicitly:
        // - monthly_history aggregates with a NULL manifest_id (legacy rows the FK missed)
        await q(`DELETE FROM monthly_history`);
        // - ALL files rows. Every FK into files (manifests.risk_file_id/source_file_id,
        //   pedimentos.file_id/report_file_id, pedimento_scans.file_id) is ON DELETE SET
        //   NULL, so referenced rows survive the cascade; and saveFile() commits BEFORE
        //   the referencing row is attached, so abandoned uploads leave never-referenced
        //   rows+blobs. Both kinds are demo debris — wipe the table and keep the paths
        //   for post-commit blob cleanup.
        const removedFiles = await q(`DELETE FROM files RETURNING storage_path`);
        const storagePaths: string[] = removedFiles.rows.map(
          (r: { storage_path: string }) => r.storage_path,
        );

        return { ...opsCounts, files: removedFiles.rowCount ?? 0, storagePaths };
      });

      const { storagePaths, ...deleted } = result;

      // Post-commit best-effort blob cleanup. Ordering constraint: this MUST run before
      // recordAudit — the files rows are already gone, so if the audit insert threw first
      // and the unlinks were skipped, every blob would be permanently orphaned. A
      // filesystem hiccup never fails the request; the DB reset already committed.
      await Promise.allSettled(
        result.storagePaths.map(async (p) => {
          try {
            await unlink(p);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
              console.warn(`[demo-reset] failed to unlink ${p}:`, err instanceof Error ? err.message : err);
            }
          }
        }),
      );

      // DEMO_RESET audit event through the hash-chain helper (keeps the chain valid).
      await recordAudit({
        userId: req.user!.userId,
        action: 'DEMO_RESET',
        entity: 'system',
        after: deleted,
        ip: req.ip,
      });

      res.json({ deleted });
    } catch (err) {
      next(err);
    }
  },
);
