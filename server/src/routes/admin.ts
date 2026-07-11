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
 * POST /api/admin/demo-reset — wipe operational data (manifests + everything derived
 * from them, plus every stored file row/blob — including never-referenced rows left
 * by abandoned uploads) so a demo can restart from a pristine DB. Preserves users, clients,
 * platforms, catalogs, header mappings, compliance config, validated RFCs, and the
 * append-only audit log (which instead gains a DEMO_RESET trace).
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
          `SELECT (SELECT count(*) FROM manifests)::int  AS manifests,
                  (SELECT count(*) FROM pedimentos)::int AS pedimentos,
                  (SELECT count(*) FROM shipments)::int  AS shipments`,
        );
        const { manifests, pedimentos, shipments } = counts.rows[0] as {
          manifests: number; pedimentos: number; shipments: number;
        };

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

        return { manifests, pedimentos, shipments, files: removedFiles.rowCount ?? 0, storagePaths };
      });

      const deleted = {
        manifests: result.manifests,
        pedimentos: result.pedimentos,
        shipments: result.shipments,
        files: result.files,
      };

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
