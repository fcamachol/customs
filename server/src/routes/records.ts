import { Router } from 'express';
import { query } from '../db/pool';
import { requireAuth } from '../auth/middleware';
import { canSeeAll } from '../auth/access';
import { computeLock } from '../services/manifestLock';

export const recordsRouter = Router();

recordsRouter.get('/', requireAuth, async (req, res) => {
  const q = `%${(req.query.q as string) ?? ''}%`;
  const params: unknown[] = [q];
  let ownership = '';
  if (!canSeeAll(req.user!.role)) {
    params.push(req.user!.userId);
    ownership = ` AND created_by = $${params.length}`;
  }
  const { rows } = await query(
    `SELECT id, mawb_reference AS "mawbReference", client_name AS "clientName", created_at AS "createdAt"
     FROM manifests WHERE (mawb_reference ILIKE $1 OR client_name ILIKE $1)${ownership} ORDER BY created_at DESC`, params);
  res.json(rows);
});

recordsRouter.get('/:id', requireAuth, async (req, res) => {
  const { rows } = await query(
    `SELECT m.id, m.mawb_reference AS "mawbReference", m.client_name AS "clientName",
            m.pedimento, m.prevalidation, m.file_id AS "pedimentoFileId", m.created_by AS "createdBy",
            m.import_data AS "importData", m.import_data_version AS "importDataVersion", m.risk_stale AS "riskStale",
            (SELECT count(*)::int FROM shipments s WHERE s.manifest_id=m.id) AS "shipmentCount"
     FROM manifests m WHERE m.id=$1`, [req.params.id]);
  if (!rows.length) { res.status(404).json({ error: 'Not found' }); return; }
  if (!canSeeAll(req.user!.role) && rows[0].createdBy !== req.user!.userId) {
    res.status(403).json({ error: 'Forbidden' }); return;
  }
  const r = rows[0];
  // Carries import-data (business data) — keep it out of shared caches.
  res.setHeader('Cache-Control', 'no-store, private');
  res.json({
    ...r,
    riskStale: !!r.riskStale,
    lock: computeLock({ prevalidation: r.prevalidation, file_id: r.pedimentoFileId }),
    artifacts: {
      riskAnalysis: `/api/records/${r.id}/risk.xlsx`,
      pedimentoPdf: r.pedimentoFileId ? `/api/files/${r.pedimentoFileId}` : null,
      report: `/api/records/${r.id}/report.xlsx`,
    },
  });
});
