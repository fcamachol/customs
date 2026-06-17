import { Router } from 'express';
import { query } from '../db/pool';
import { requireAuth } from '../auth/middleware';

export const recordsRouter = Router();

recordsRouter.get('/', requireAuth, async (req, res) => {
  const q = `%${(req.query.q as string) ?? ''}%`;
  const { rows } = await query(
    `SELECT id, mawb_reference AS "mawbReference", client_name AS "clientName", created_at AS "createdAt"
     FROM manifests WHERE mawb_reference ILIKE $1 OR client_name ILIKE $1 ORDER BY created_at DESC`, [q]);
  res.json(rows);
});

recordsRouter.get('/:id', requireAuth, async (req, res) => {
  const { rows } = await query(
    `SELECT m.id, m.mawb_reference AS "mawbReference", m.client_name AS "clientName",
            m.pedimento, m.prevalidation, m.file_id AS "pedimentoFileId",
            (SELECT count(*)::int FROM shipments s WHERE s.manifest_id=m.id) AS "shipmentCount"
     FROM manifests m WHERE m.id=$1`, [req.params.id]);
  if (!rows.length) { res.status(404).json({ error: 'Not found' }); return; }
  const r = rows[0];
  res.json({
    ...r,
    artifacts: {
      riskAnalysis: `/api/records/${r.id}/risk.xlsx`,
      pedimentoPdf: r.pedimentoFileId ? `/api/files/${r.pedimentoFileId}` : null,
      report: `/api/records/${r.id}/report.xlsx`,
    },
  });
});
