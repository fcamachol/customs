import { Router } from 'express';
import { query } from '../db/pool';
import { requireAuth } from '../auth/middleware';
import { recordAudit } from '../services/audit';
import { scoreManifest } from '../../../shared/risk/classify';
import { deleteManifestHistory, loadHistoryNames, recordNames } from '../services/monthlyHistory';
import type { Shipment } from '../../../shared/types/shipment';

export const riskRouter = Router();

riskRouter.post('/:id/risk', requireAuth, async (req, res) => {
  const period: string = req.body?.period ?? new Date().toISOString().slice(0, 7);
  const { rows } = await query<{ id: string; data: Shipment }>(
    'SELECT id, data FROM shipments WHERE manifest_id=$1', [req.params.id]);
  const shipments = rows.map((r) => r.data);

  await deleteManifestHistory(req.params.id);
  const history = await loadHistoryNames(period, req.params.id);
  const scored = scoreManifest(shipments, history);

  for (const sc of scored) {
    await query('UPDATE shipments SET risk_score=$1, risk_color=$2, risk_incidences=$3 WHERE id=$4',
      [sc.score, sc.color, JSON.stringify(sc.incidences), sc.shipment.id]);
  }
  await recordNames(shipments.map((s) => s.consignee.name), period, req.params.id);

  const summary = {
    analizados: scored.length,
    aprobados: scored.filter((s) => s.color === 'verde').length,
    validarEnPrevio: scored.filter((s) => s.color === 'amarillo').length,
    rojos: scored.filter((s) => s.color === 'rojo').length,
  };
  await recordAudit({ userId: req.user!.userId, action: 'RUN_RISK', entity: 'manifest', entityId: req.params.id, after: summary, ip: req.ip });

  res.json({
    rows: scored.map((s) => ({
      mwb: s.shipment.mawbReference,
      guide: s.shipment.guideId,
      consignee: s.shipment.consignee.name,
      senderCity: s.shipment.sender.address ?? '',
      senderCountry: s.shipment.platform.countryOfOrigin ?? s.shipment.originCountry,
      resultado: s.color,
      motivo: s.incidences.join('; '),
    })),
    summary,
  });
});
