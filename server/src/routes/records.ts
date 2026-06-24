import { Router } from 'express';
import { query } from '../db/pool';
import { requireAuth } from '../auth/middleware';
import { canSeeAll } from '../auth/access';
import { computeLock } from '../services/manifestLock';
import { computeSeguimientoStatus } from '../../../shared/pedimento/seguimientoStatus';

export const recordsRouter = Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCORED_COLORS = ['verde', 'amarillo', 'rojo'];

recordsRouter.get('/', requireAuth, async (req, res) => {
  const q = `%${(req.query.q as string) ?? ''}%`;
  const params: unknown[] = [q];
  // Built up dynamically; every user value is parameterized. Unknown/malformed
  // filter values are ignored (treated as absent), mirroring how `q` is handled.
  const clauses: string[] = ['(m.mawb_reference ILIKE $1 OR m.client_name ILIKE $1)'];

  if (!canSeeAll(req.user!.role)) {
    params.push(req.user!.userId);
    clauses.push(`m.created_by = $${params.length}`);
  }

  const clientName = (req.query.clientName as string | undefined)?.trim();
  if (clientName) {
    params.push(clientName);
    clauses.push(`m.client_name = $${params.length}`);
  }

  const platformId = (req.query.platformId as string | undefined)?.trim();
  if (platformId && UUID_RE.test(platformId)) {
    params.push(platformId);
    clauses.push(`m.platform_id = $${params.length}`);
  }

  const dateFrom = (req.query.dateFrom as string | undefined)?.trim();
  if (dateFrom && DATE_RE.test(dateFrom)) {
    params.push(dateFrom);
    clauses.push(`m.created_at >= $${params.length}`);
  }

  const dateTo = (req.query.dateTo as string | undefined)?.trim();
  if (dateTo && DATE_RE.test(dateTo)) {
    params.push(dateTo);
    clauses.push(`m.created_at < ($${params.length}::date + 1)`);
  }

  // Risk result is per-shipment; a manifest matches a color if it CONTAINS a
  // shipment of that color. "gris" (Sin evaluar) = no scored shipments.
  const result = (req.query.result as string | undefined)?.trim();
  if (result && SCORED_COLORS.includes(result)) {
    params.push(result);
    clauses.push(`EXISTS (SELECT 1 FROM shipments s WHERE s.manifest_id = m.id AND s.risk_color = $${params.length})`);
  } else if (result === 'gris') {
    clauses.push(`NOT EXISTS (SELECT 1 FROM shipments s WHERE s.manifest_id = m.id AND s.risk_color IN ('verde','amarillo','rojo'))`);
  }

  const { rows } = await query(
    `SELECT m.id, m.mawb_reference AS "mawbReference", m.client_name AS "clientName", m.created_at AS "createdAt",
            m.import_data AS "importData", m.prevalidation, m.file_id AS "fileId", m.pedimento_scan AS "pedimentoScan"
     FROM manifests m WHERE ${clauses.join(' AND ')} ORDER BY m.created_at DESC`, params);
  // Derive the Seguimiento status/lock for the two-tab work queue (no dedicated status column).
  const summaries = rows.map((r) => {
    const { status, locked, scanVerdict } = computeSeguimientoStatus({
      importData: r.importData,
      prevalidationStatus: r.prevalidation?.status ?? null,
      fileId: r.fileId,
      scanVerdict: r.pedimentoScan?.verdict ?? null,
    });
    return {
      id: r.id,
      mawbReference: r.mawbReference,
      clientName: r.clientName,
      createdAt: r.createdAt,
      status,
      locked,
      scanVerdict,
    };
  });
  res.json(summaries);
});

recordsRouter.get('/:id', requireAuth, async (req, res) => {
  const { rows } = await query(
    `SELECT m.id, m.mawb_reference AS "mawbReference", m.client_name AS "clientName",
            m.pedimento, m.prevalidation, m.file_id AS "pedimentoFileId", m.created_by AS "createdBy",
            m.import_data AS "importData", m.import_data_version AS "importDataVersion", m.risk_stale AS "riskStale",
            (SELECT count(*)::int FROM shipments s WHERE s.manifest_id=m.id) AS "shipmentCount"
     FROM manifests m WHERE m.id=$1`, [req.params.id]);
  if (!rows.length) { res.status(404).json({ error: 'Not found' }); return; }
  if (!canSeeAll(req.user!.role) && rows[0].createdBy !== req.user!.userId) {
    res.status(403).json({ error: 'Forbidden' }); return;
  }
  const r = rows[0];
  // Carries import-data (business data) — keep it out of shared caches.
  res.setHeader('Cache-Control', 'no-store, private');
  res.json({
    ...r,
    riskStale: !!r.riskStale,
    lock: computeLock({ prevalidation: r.prevalidation, file_id: r.pedimentoFileId }),
    artifacts: {
      riskAnalysis: `/api/records/${r.id}/risk.xlsx`,
      pedimentoPdf: r.pedimentoFileId ? `/api/files/${r.pedimentoFileId}` : null,
      report: `/api/records/${r.id}/report.xlsx`,
    },
  });
});
