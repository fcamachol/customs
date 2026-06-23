import { Router } from 'express';
import { query } from '../db/pool';
import { requireAuth, requireRole } from '../auth/middleware';
import { recordAudit } from '../services/audit';
import { scoreManifest, rulesetVersionFor } from '../../../shared/risk/classify';
import type { Thresholds } from '../../../shared/risk/ruleset';
import { deleteManifestHistory, loadHistoryCounts, recordNames } from '../services/monthlyHistory';
import { buildRiskWorkbook } from '../services/artifacts';
import { saveFile } from '../storage/files';
import type { Shipment } from '../../../shared/types/shipment';
import { decryptShipment } from '../crypto/fieldCrypto';

export const riskRouter = Router();

/** Load a config value from the config table; returns undefined when key not found */
async function loadConfig<T>(key: string): Promise<T | undefined> {
  const { rows } = await query<{ value: T }>('SELECT value FROM config WHERE key=$1', [key]);
  return rows[0]?.value;
}

riskRouter.post('/:id/risk', requireAuth, requireRole('admin', 'capturista'), async (req, res) => {
  const period: string = req.body?.period ?? new Date().toISOString().slice(0, 7);
  const { rows } = await query<{ id: string; data: Shipment }>(
    'SELECT id, data FROM shipments WHERE manifest_id=$1', [req.params.id]);
  const shipments = rows.map((r) => decryptShipment(r.data));

  // Load optional catalog overrides from config (fallback to built-in defaults when unset)
  const prohibitedKeywords = await loadConfig<string[]>('prohibited');
  const piracyBrands = await loadConfig<string[]>('piracy_brands');
  // D4 / RF-24: admin-configurable thresholds (umbrales) from the validation_params catalog
  const thresholds = await loadConfig<Partial<Record<keyof Thresholds, unknown>>>('validation_params');

  await deleteManifestHistory(req.params.id);
  const history = await loadHistoryCounts(period, req.params.id);
  const scoreOptions = { prohibitedKeywords, piracyBrands, thresholds };
  const scored = scoreManifest(shipments, history, scoreOptions);

  for (const sc of scored) {
    await query('UPDATE shipments SET risk_score=$1, risk_color=$2, risk_incidences=$3 WHERE id=$4',
      [sc.score, sc.color, JSON.stringify(sc.incidences), sc.shipment.id]);
  }
  await recordNames(shipments.map((s) => s.consignee.name), period, req.params.id);

  // PRD 3-bucket mapping (D2): aprobados=verde, noIdentificados=amarillo, validarEnPrevio=rojo
  const summary = {
    analizados: scored.length,
    aprobados: scored.filter((s) => s.color === 'verde').length,
    noIdentificados: scored.filter((s) => s.color === 'amarillo').length,
    validarEnPrevio: scored.filter((s) => s.color === 'rojo').length,
  };

  // Load branding config for XLS header
  const branding = await loadConfig<{ companyName?: string; rfc?: string }>('branding');

  // Build and persist the risk XLSX artifact
  const riskRows = scored.map((s) => ({
    Guia: s.shipment.guideId,
    Destinatario: s.shipment.consignee.name,
    Resultado: s.color,
    Motivo: s.incidences.join('; '),
  }));
  const riskBuffer = buildRiskWorkbook(riskRows, branding);
  const riskFile = await saveFile({
    kind: 'risk_analysis',
    originalName: 'Analisis_de_Riesgo.xlsx',
    bytes: riskBuffer,
    uploadedBy: req.user!.userId,
  });
  // Clear risk_stale: the persisted score now matches the current data again.
  await query('UPDATE manifests SET risk_file_id=$1, ruleset_version=$2, risk_stale=false WHERE id=$3', [riskFile.id, rulesetVersionFor(scoreOptions), req.params.id]);

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
