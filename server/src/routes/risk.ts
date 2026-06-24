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
import { scoreLegacyParity } from '../../../shared/risk/legacyParity';
import type { DeniedPartyEntry } from '../../../shared/risk/lists';
import { validate } from '../validation/middleware';
import { riskBody } from '../validation/schemas';

export const riskRouter = Router();

/** Load a config value from the config table; returns undefined when key not found */
async function loadConfig<T>(key: string): Promise<T | undefined> {
  const { rows } = await query<{ value: T }>('SELECT value FROM config WHERE key=$1', [key]);
  return rows[0]?.value;
}

riskRouter.post('/:id/risk', requireAuth, requireRole('admin', 'capturista'), validate({ body: riskBody }), async (req, res) => {
  const period: string = req.body.period ?? new Date().toISOString().slice(0, 7);
  const { rows } = await query<{ id: string; data: Shipment }>(
    'SELECT id, data FROM shipments WHERE manifest_id=$1', [req.params.id]);
  const shipments = rows.map((r) => decryptShipment(r.data));

  // Load optional catalog overrides from config (fallback to built-in defaults when unset)
  const prohibitedKeywords = await loadConfig<string[]>('prohibited');
  const piracyBrands = await loadConfig<string[]>('piracy_brands');
  // D4 / RF-24: admin-configurable thresholds (umbrales) from the validation_params catalog
  const thresholds = await loadConfig<Partial<Record<keyof Thresholds, unknown>>>('validation_params');
  // F18: OFAC/BIS/EU/UN sanctions screening list. Loaded from config key `denied_parties`.
  // Shipments are decrypted above before scoreManifest so IDs are available in plaintext here.
  // TODO(F20): when blind-index tokenization lands, coordinate ID keying with F20's token derivation.
  const deniedParties = await loadConfig<DeniedPartyEntry[]>('denied_parties');

  await deleteManifestHistory(req.params.id);
  const history = await loadHistoryCounts(period, req.params.id);
  const scoreOptions = { prohibitedKeywords, piracyBrands, thresholds, deniedParties };
  const scored = scoreManifest(shipments, history, scoreOptions);

  // FIX: use rows[i].id (table PK) not sc.shipment.id (data JSON field) — they can differ.
  for (const [i, sc] of scored.entries()) {
    await query(
      'UPDATE shipments SET risk_score=$1, risk_color=$2, risk_incidences=$3, risk_reasons=$4, ruleset_hash=$5 WHERE id=$6',
      [sc.score, sc.color, JSON.stringify(sc.incidences), JSON.stringify(sc.reasons), sc.ruleset_hash, rows[i].id],
    );
  }
  await recordNames(shipments.map((s) => s.consignee.name), period, req.params.id);

  // PRD 3-bucket mapping (D2): aprobados=verde, noIdentificados=amarillo, validarEnPrevio=rojo, sinDatos=gris
  const summary = {
    analizados: scored.length,
    aprobados: scored.filter((s) => s.color === 'verde').length,
    noIdentificados: scored.filter((s) => s.color === 'amarillo').length,
    validarEnPrevio: scored.filter((s) => s.color === 'rojo').length,
    sinDatos: scored.filter((s) => s.color === 'gris').length,
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

  // Legacy parity: build the set of normalized consignee names from the monthly history keys
  // (history is Record<normalizedName, count> — the keys are already normalized)
  const monthlyDbNames = new Set(Object.keys(history));
  const legacyRows = scoreLegacyParity(shipments, monthlyDbNames);

  res.json({
    rows: scored.map((s, i) => ({
      mwb: s.shipment.mawbReference,
      guide: s.shipment.guideId,
      consignee: s.shipment.consignee.name,
      senderCity: s.shipment.sender.address ?? '',
      senderCountry: s.shipment.platform.countryOfOrigin ?? s.shipment.originCountry,
      resultado: s.color,
      resultadoLegacy: legacyRows[i].resultado,
      motivo: s.incidences.join('; '),
    })),
    summary,
  });
});
