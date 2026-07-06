import { Router } from 'express';
import { query } from '../db/pool';
import { withTransaction } from '../db/tx';
import { deleteFileById } from '../storage/files';
import { requireAuth, requireRole } from '../auth/middleware';
import { recordAudit } from '../services/audit';
import { canSeeAll } from '../auth/access';
import { nextSubStatus } from '../../../shared/pedimento/subStatus';
import type { SubStatus } from '../../../shared/pedimento/subStatus';

export const pedimentoLifecycleRouter = Router();

pedimentoLifecycleRouter.post(
  '/:id/finalize',
  requireAuth,
  requireRole('admin', 'capturista'),
  async (req, res, next) => {
    try {
      const { id } = req.params;

      const { rows } = await query<{
        sub_status: SubStatus;
        created_by: string;
      }>(
        `SELECT p.sub_status, m.created_by
           FROM pedimentos p
           JOIN manifests m ON m.id = p.manifest_id
          WHERE p.id = $1`,
        [id],
      );

      if (!rows.length) {
        res.status(404).json({ error: 'Pedimento not found' });
        return;
      }

      const { sub_status: current, created_by } = rows[0];

      // Per-row ownership guard (mirrors records.ts). Currently unreachable since canSeeAll() is true for all roles; will engage if a read-only (canSeeAll=false) role is added.
      if (!canSeeAll(req.user!.role) && created_by !== req.user!.userId) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }

      const t = nextSubStatus(current, 'finalize');
      if (!t.ok) {
        res.status(409).json({ error: t.reason });
        return;
      }

      await query(
        'UPDATE pedimentos SET sub_status=$1 WHERE id=$2',
        [t.next, id],
      );

      await recordAudit({
        userId: req.user!.userId,
        action: 'FINALIZE_PEDIMENTO',
        entity: 'pedimento',
        entityId: id,
        before: { subStatus: current },
        after: { subStatus: t.next },
        ip: req.ip,
      });

      res.json({ subStatus: t.next });
    } catch (err) {
      next(err);
    }
  },
);

pedimentoLifecycleRouter.post(
  '/:id/reopen',
  requireAuth,
  requireRole('admin', 'capturista'),
  async (req, res, next) => {
    try {
      const { id } = req.params;

      const { rows } = await query<{
        sub_status: SubStatus;
        created_by: string;
      }>(
        `SELECT p.sub_status, m.created_by
           FROM pedimentos p
           JOIN manifests m ON m.id = p.manifest_id
          WHERE p.id = $1`,
        [id],
      );

      if (!rows.length) {
        res.status(404).json({ error: 'Pedimento not found' });
        return;
      }

      const { sub_status: current, created_by } = rows[0];

      // Per-row ownership guard (mirrors records.ts). Currently unreachable since canSeeAll() is true for all roles; will engage if a read-only (canSeeAll=false) role is added.
      if (!canSeeAll(req.user!.role) && created_by !== req.user!.userId) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }

      const t = nextSubStatus(current, 'reopen');
      if (!t.ok) {
        res.status(409).json({ error: t.reason });
        return;
      }

      await query(
        'UPDATE pedimentos SET sub_status=$1 WHERE id=$2',
        [t.next, id],
      );

      await recordAudit({
        userId: req.user!.userId,
        action: 'REOPEN_PEDIMENTO',
        entity: 'pedimento',
        entityId: id,
        before: { subStatus: current },
        after: { subStatus: t.next },
        ip: req.ip,
      });

      res.json({ subStatus: t.next });
    } catch (err) {
      next(err);
    }
  },
);

// Hard-delete a pedimento (row + scans + stored files) before it is finalized. Deleting the row
// frees both dedup gates — the global unique número and the per-manifest guía-overlap gate reading
// covered_guias — so the corrected PDF can be re-uploaded. Finalized (cargado) pedimentos must be
// reopened first. See docs/superpowers/specs/2026-07-06-wizard-delete-pedimento-design.md.
pedimentoLifecycleRouter.delete(
  '/:id',
  requireAuth,
  requireRole('admin', 'capturista'),
  async (req, res, next) => {
    try {
      const { id } = req.params;

      const { rows } = await query<{
        numero_pedimento: string | null;
        sub_status: SubStatus;
        covered_guias: string[] | null;
        file_id: string | null;
        report_file_id: string | null;
        manifest_id: string;
        created_by: string;
      }>(
        `SELECT p.numero_pedimento, p.sub_status, p.covered_guias, p.file_id,
                p.report_file_id, p.manifest_id, m.created_by
           FROM pedimentos p
           JOIN manifests m ON m.id = p.manifest_id
          WHERE p.id = $1`,
        [id],
      );

      if (!rows.length) {
        res.status(404).json({ error: 'Pedimento not found' });
        return;
      }

      const row = rows[0];

      // Per-row ownership guard (mirrors finalize/reopen). Currently unreachable since canSeeAll() is true for all roles; will engage if a read-only (canSeeAll=false) role is added.
      if (!canSeeAll(req.user!.role) && row.created_by !== req.user!.userId) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }

      if (row.sub_status === 'cargado') {
        res.status(409).json({
          error: 'No se puede eliminar un pedimento finalizado. Reábralo primero.',
        });
        return;
      }

      // Delete the dedup-critical rows atomically: the scans keyed by this pedimento's file_id and
      // the pedimento row itself. The stored files (DB row + disk blob) are cleaned up after the
      // commit as best-effort side work.
      await withTransaction(async (q) => {
        if (row.file_id) {
          await q('DELETE FROM pedimento_scans WHERE file_id=$1', [row.file_id]);
        }
        await q('DELETE FROM pedimentos WHERE id=$1', [id]);
      });

      await recordAudit({
        userId: req.user!.userId,
        action: 'DELETE_PEDIMENTO',
        entity: 'pedimento',
        entityId: id,
        before: {
          numeroPedimento: row.numero_pedimento,
          subStatus: row.sub_status,
          coveredGuias: row.covered_guias,
          fileId: row.file_id,
          manifestId: row.manifest_id,
        },
        ip: req.ip,
      });

      // Best-effort file cleanup (files row + disk blob); failures are logged, not surfaced.
      if (row.file_id) await deleteFileById(row.file_id);
      if (row.report_file_id) await deleteFileById(row.report_file_id);

      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);
