import { Router } from 'express';
import { query } from '../db/pool';
import { requireAuth, requireRole } from '../auth/middleware';
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

// POST /api/manifests/:id/client — associate a client to a manifest
manifestsRouter.post('/:id/client', requireAuth, requireRole('admin', 'capturista'), async (req, res) => {
  const { id } = req.params;
  const { clientId } = req.body ?? {};
  if (!clientId) { res.status(400).json({ error: 'clientId is required' }); return; }

  const existing = await query('SELECT id FROM manifests WHERE id=$1', [id]);
  if (existing.rows.length === 0) { res.status(404).json({ error: 'Manifest not found' }); return; }

  const clientCheck = await query('SELECT id FROM clients WHERE id=$1', [clientId]);
  if (clientCheck.rows.length === 0) { res.status(404).json({ error: 'Client not found' }); return; }

  await query('UPDATE manifests SET client_id=$1 WHERE id=$2', [clientId, id]);
  await recordAudit({
    userId: req.user!.userId,
    action: 'LINK_CLIENT',
    entity: 'manifest',
    entityId: id,
    after: { clientId },
    ip: req.ip,
  });
  res.json({ ok: true });
});
