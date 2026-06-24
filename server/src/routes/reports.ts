import { Router } from 'express';
import { createHash } from 'node:crypto';
import { query } from '../db/pool';
import { requireAuth } from '../auth/middleware';
import { recordAudit, stableStringify } from '../services/audit';
import { computeLock } from '../services/manifestLock';
import type { SubStatus } from '../../../shared/pedimento/subStatus';
import { piiReportLimiter } from '../middleware/rateLimit';
import {
  assertManifestAccess,
  resolvePedimentoAccess,
  loadShipments,
  loadPedimentoScope,
  buildRiskScreenRows,
  buildReportRowsForPedimento,
  subsetForCoverage,
  layoutRowsFor,
} from '../services/reportData';
import type { RiskBundle, PedimentoReportsBundle } from '../../../shared/types/reports';

// Risk stays PER-MANIFEST (shipment-scoped, pedimento-independent); report + layout are PER-PEDIMENTO
// (each subdivisión is its own customs submission over its covered-guía subset). The endpoints are
// split along that seam: reportsRouter mounts the manifest-level risk bundle, pedimentoReportsRouter
// the per-pedimento report+layout (which carries consignee PII and the fail-closed audit).
export const reportsRouter = Router();
export const pedimentoReportsRouter = Router();

// Consignee identity PII → layout/report column headers. Masked for the read-only `autoridad`
// role unless explicitly revealed (LFPDPPP data-minimization; on-screen viewing is higher-frequency
// than a file download, so it defaults to least-data).
const PII_COLUMNS: Record<string, string> = {
  rfc: 'Consignatario RFC',
  curp: 'Consignatario CURP',
  passport: 'Consignatario No. pasaporte',
  foreignTaxId: 'Consignatario ID Fiscal país residencia',
  socialSecurity: 'Consignatario No. Seguridad Social',
};
const PII_FIELD_NAMES = Object.keys(PII_COLUMNS);
const MASK = '•••••';

function parseReveal(raw: unknown): Set<string> {
  if (raw == null) return new Set();
  const list = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  if (list.includes('all')) return new Set(PII_FIELD_NAMES);
  return new Set(list.filter((f) => PII_FIELD_NAMES.includes(f)));
}

/** Mask the configured PII columns in-place on a row array, except the revealed fields. */
function redactRows(rows: Record<string, string>[], reveal: Set<string>): boolean {
  let masked = false;
  for (const field of PII_FIELD_NAMES) {
    if (reveal.has(field)) continue;
    const col = PII_COLUMNS[field];
    for (const row of rows) {
      if (row[col] != null && row[col] !== '') { row[col] = MASK; masked = true; }
    }
  }
  return masked;
}

// Per-MANIFEST risk bundle (Análisis de Riesgo screen + stale banner). No identity PII columns, so
// no redaction here; the audit is best-effort (the report/layout fail-closed audit lives below).
reportsRouter.get('/:id/reports.json', requireAuth, async (req, res, next) => {
 try {
  res.setHeader('Cache-Control', 'no-store, private');

  if (!(await assertManifestAccess(req.params.id, req.user!))) { res.status(403).json({ error: 'Forbidden' }); return; }

  const meta = await query<{ risk_stale: boolean }>('SELECT risk_stale FROM manifests WHERE id=$1', [req.params.id]);
  if (!meta.rows.length) { res.status(404).json({ error: 'Not found' }); return; }

  const loaded = await loadShipments(req.params.id);
  const risk = buildRiskScreenRows(loaded);

  const generatedAt = new Date().toISOString();
  const contentHash = createHash('sha256').update(stableStringify({ risk })).digest('hex');

  await recordAudit({
    userId: req.user!.userId,
    action: 'VIEW_RISK',
    entity: 'manifest',
    entityId: req.params.id,
    after: { role: req.user!.role, shipmentCount: loaded.length, contentHash },
    ip: req.ip,
  });

  const bundle: RiskBundle = { risk, riskStale: !!meta.rows[0].risk_stale, generatedAt, contentHash };
  res.json(bundle);
 } catch (err) {
  next(err);
 }
});

// Per-PEDIMENTO report + layout bundle (Reporte General / Layout for one subdivisión). Built over the
// pedimento's covered-guía subset + its own import_data. Carries consignee PII → redaction + the
// FAIL-CLOSED PII audit live here.
pedimentoReportsRouter.get('/:pedimentoId/reports.json', requireAuth, piiReportLimiter, async (req, res, next) => {
 try {
  res.setHeader('Cache-Control', 'no-store, private');

  const access = await resolvePedimentoAccess(req.params.pedimentoId, req.user!);
  if (!access.found) { res.status(404).json({ error: 'Not found' }); return; }
  if (!access.allowed) { res.status(403).json({ error: 'Forbidden' }); return; }

  const scope = await loadPedimentoScope(req.params.pedimentoId);
  if (!scope) { res.status(404).json({ error: 'Not found' }); return; }

  // Lock is derived from the pedimento's lifecycle sub_status (cargado = finalized, immutable).
  const lockRow = await query<{ sub_status: SubStatus }>(
    'SELECT sub_status FROM pedimentos WHERE id=$1', [req.params.pedimentoId]);

  const loadedManifest = await loadShipments(scope.manifestId);
  const subset = subsetForCoverage(loadedManifest, scope.coveredGuias);
  const report = await buildReportRowsForPedimento(scope, loadedManifest);
  const layout = layoutRowsFor(subset);

  // Server-side redaction (only the read-only authority role; capturista/admin see full parity).
  const isAuthority = req.user!.role === 'autoridad';
  const reveal = isAuthority ? parseReveal(req.query.reveal) : new Set<string>(PII_FIELD_NAMES);
  let masked = false;
  if (isAuthority) {
    // Mask both row sets — avoid `||` short-circuit which would skip the second call.
    const maskedReport = redactRows(report, reveal);
    const maskedLayout = redactRows(layout, reveal);
    masked = maskedReport || maskedLayout;
  }
  const revealedFields = isAuthority ? PII_FIELD_NAMES.filter((f) => reveal.has(f)) : [];

  const generatedAt = new Date().toISOString();
  const contentHash = createHash('sha256').update(stableStringify({ report, layout })).digest('hex');

  const bundle: PedimentoReportsBundle = {
    report,
    layout,
    lock: computeLock({ sub_status: lockRow.rows[0]?.sub_status }),
    masked,
    generatedAt,
    contentHash,
  };

  // Fail-closed audit: this returns consignee PII. The access MUST be durably logged before the
  // bundle is delivered (mirrors the consolidated authority export). No audit ⇒ no data.
  try {
    await recordAudit({
      userId: req.user!.userId,
      action: revealedFields.length ? 'REVEAL_PII' : 'VIEW_REPORTS',
      entity: 'pedimento',
      entityId: req.params.pedimentoId,
      after: { role: req.user!.role, shipmentCount: subset.length, revealedFields, contentHash },
      ip: req.ip,
    });
  } catch (err) {
    next(err);
    return;
  }

  res.json(bundle);
 } catch (err) {
  next(err);
 }
});
