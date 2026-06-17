import { Router } from 'express';
import { query } from '../db/pool';
import { requireAuth, requireRole } from '../auth/middleware';
import { recordAudit } from '../services/audit';
import { buildPedimento } from '../../../shared/pedimento/buildPedimento';
import { prevalidatePedimento } from '../../../shared/pedimento/prevalidate';
import type { Shipment } from '../../../shared/types/shipment';

export const pedimentoRouter = Router();

pedimentoRouter.post('/:id/pedimento', requireAuth, requireRole('admin', 'capturista'), async (req, res) => {
  const { rows } = await query<{ data: Shipment }>('SELECT data FROM shipments WHERE manifest_id=$1', [req.params.id]);
  if (!rows.length) { res.status(400).json({ error: 'No shipments for manifest' }); return; }
  const ped = buildPedimento(rows.map((r) => r.data), req.body);
  const prevalidation = prevalidatePedimento(ped);
  await query('UPDATE manifests SET pedimento=$1, prevalidation=$2 WHERE id=$3',
    [JSON.stringify(ped), JSON.stringify(prevalidation), req.params.id]);
  await recordAudit({ userId: req.user!.userId, action: 'GENERATE_PEDIMENTO', entity: 'manifest', entityId: req.params.id, after: { numeroPedimento: ped.header.numeroPedimento, status: prevalidation.status } });
  res.status(201).json({ pedimento: ped, prevalidation });
});
