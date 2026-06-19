import { Router } from 'express';
import { query } from '../db/pool';
import { requireAuth, requireRole } from '../auth/middleware';
import { recordAudit } from '../services/audit';
import { buildPedimento } from '../../../shared/pedimento/buildPedimento';
import { prevalidatePedimento } from '../../../shared/pedimento/prevalidate';
import type { Shipment } from '../../../shared/types/shipment';
import { decryptShipment } from '../crypto/fieldCrypto';

export const pedimentoRouter = Router();

function validatePedimentoInput(body: unknown): string | null {
  if (!body || typeof body !== 'object') return 'Missing request body';
  const b = body as Record<string, unknown>;
  for (const field of ['numeroPedimento', 'tipoCambio', 'customsEntryCode', 'customsClearanceCode', 'entryDate', 'paymentDate']) {
    if (b[field] === undefined || b[field] === null || b[field] === '') return `Missing field: ${field}`;
  }
  const importer = b.importer as Record<string, unknown> | undefined;
  if (!importer || typeof importer !== 'object') return 'Missing field: importer';
  for (const field of ['rfc', 'name', 'fiscalAddress']) {
    if (importer[field] === undefined || importer[field] === null || importer[field] === '') return `Missing field: importer.${field}`;
  }
  const agent = b.agent as Record<string, unknown> | undefined;
  if (!agent || typeof agent !== 'object') return 'Missing field: agent';
  for (const field of ['patente', 'name', 'agentRfc', 'agencyRfc']) {
    if (agent[field] === undefined || agent[field] === null || agent[field] === '') return `Missing field: agent.${field}`;
  }
  return null;
}

pedimentoRouter.post('/:id/pedimento', requireAuth, requireRole('admin', 'capturista'), async (req, res, next) => {
  try {
    const validationError = validatePedimentoInput(req.body);
    if (validationError) { res.status(400).json({ error: validationError }); return; }
    const { rows } = await query<{ data: Shipment }>('SELECT data FROM shipments WHERE manifest_id=$1', [req.params.id]);
    if (!rows.length) { res.status(400).json({ error: 'No shipments for manifest' }); return; }
    const ped = buildPedimento(rows.map((r) => decryptShipment(r.data)), req.body);
    const prevalidation = prevalidatePedimento(ped);
    await query('UPDATE manifests SET pedimento=$1, prevalidation=$2 WHERE id=$3',
      [JSON.stringify(ped), JSON.stringify(prevalidation), req.params.id]);
    await recordAudit({ userId: req.user!.userId, action: 'GENERATE_PEDIMENTO', entity: 'manifest', entityId: req.params.id, after: { numeroPedimento: ped.header.numeroPedimento, status: prevalidation.status }, ip: req.ip });
    res.status(201).json({ pedimento: ped, prevalidation });
  } catch (err) {
    next(err);
  }
});
