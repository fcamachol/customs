import { Router } from 'express';
import { query } from '../db/pool';
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
