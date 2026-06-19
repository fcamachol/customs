import { Router } from 'express';
import { query } from '../db/pool';
import { requireAuth } from '../auth/middleware';
import { recordAudit } from '../services/audit';
import { parseManifestRows } from '../../../shared/parsing/manifestParser';

export const manifestsRouter = Router();

manifestsRouter.post('/', requireAuth, async (req, res) => {
  const { mawbReference, clientName, rows } = req.body ?? {};
  if (!mawbReference || !Array.isArray(rows)) { res.status(400).json({ error: 'mawbReference and rows[] required' }); return; }
  const { shipments, unmappedHeaders } = parseManifestRows(rows, mawbReference);
  const m = await query(`INSERT INTO manifests (mawb_reference, client_name, created_by) VALUES ($1,$2,$3) RETURNING id`, [mawbReference, clientName ?? null, req.user!.userId]);
  const manifestId = m.rows[0].id;
  for (const s of shipments) {
    await query(`INSERT INTO shipments (id, manifest_id, data) VALUES ($1,$2,$3)`, [s.id, manifestId, JSON.stringify(s)]);
  }
  await recordAudit({ userId: req.user!.userId, action: 'UPLOAD_MANIFEST', entity: 'manifest', entityId: manifestId, after: { mawbReference, shipmentCount: shipments.length }, ip: req.ip });
  res.status(201).json({ manifestId, shipmentCount: shipments.length, unmappedHeaders });
});
