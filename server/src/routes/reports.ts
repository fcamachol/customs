import { Router, type Request, type Response, type NextFunction } from 'express';
import { createHash } from 'node:crypto';
import { query } from '../db/pool';
import { requireAuth } from '../auth/middleware';
import { recordAudit, stableStringify } from '../services/audit';
import { computeLock } from '../services/manifestLock';
import {
  assertManifestAccess,
  loadShipments,
  buildRiskScreenRows,
  buildReportRowsForManifest,
  layoutRowsFor,
} from '../services/reportData';
import type { ReportsBundle } from '../../../shared/types/reports';

export const reportsRouter = Router();

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

// Minimal in-memory per-user rate limiter for this PII route (no external dependency).
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 60;
const hits = new Map<string, number[]>();
function rateLimit(req: Request, res: Response, next: NextFunction): void {
  const key = req.user?.userId ?? req.ip ?? 'anon';
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_MAX) { res.status(429).json({ error: 'Demasiadas solicitudes; intente de nuevo en un momento.' }); return; }
  recent.push(now);
  hits.set(key, recent);
  next();
}

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

reportsRouter.get('/:id/reports.json', requireAuth, rateLimit, async (req, res, next) => {
 try {
  res.setHeader('Cache-Control', 'no-store, private');

  if (!(await assertManifestAccess(req.params.id, req.user!))) { res.status(403).json({ error: 'Forbidden' }); return; }

  const meta = await query<{ prevalidation: { status?: string } | null; file_id: string | null; risk_stale: boolean }>(
    'SELECT prevalidation, file_id, risk_stale FROM manifests WHERE id=$1', [req.params.id]);
  if (!meta.rows.length) { res.status(404).json({ error: 'Not found' }); return; }

  const loaded = await loadShipments(req.params.id);
  const risk = buildRiskScreenRows(loaded);
  const report = await buildReportRowsForManifest(req.params.id, loaded);
  const layout = layoutRowsFor(loaded);

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
  const contentHash = createHash('sha256').update(stableStringify({ risk, report, layout })).digest('hex');

  const bundle: ReportsBundle = {
    risk,
    report,
    layout,
    lock: computeLock(meta.rows[0]),
    riskStale: !!meta.rows[0].risk_stale,
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
      entity: 'manifest',
      entityId: req.params.id,
      after: { role: req.user!.role, shipmentCount: loaded.length, revealedFields, contentHash },
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
