import { Router } from 'express';
import { query } from '../db/pool';
import { requireAuth } from '../auth/middleware';
import { canSeeAll } from '../auth/access';
import { computeLock } from '../services/manifestLock';
import type { SubStatus } from '../../../shared/pedimento/subStatus';
import { computeCoverage } from '../../../shared/pedimento/coverage';
import { loadShipments } from '../services/reportData';

export const recordsRouter = Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCORED_COLORS = ['verde', 'amarillo', 'rojo'];

interface PedimentoRow {
  id: string;
  manifest_id: string;
  numero_pedimento: string | null;
  subdivision_ordinal: number | null;
  is_last_subdivision: boolean | null;
  sibling_numeros: string[] | null;
  covered_guias: string[] | null;
  file_id: string | null;
  pedimento_scan: { verdict?: string } | null;
  prevalidation: { status?: string } | null;
  import_data: Record<string, unknown> | null;
  import_data_version: number;
  sub_status: SubStatus;
  pedimento_reconciliation: Record<string, unknown> | null;
}

const PEDIMENTO_COLS = `id, manifest_id, numero_pedimento, subdivision_ordinal, is_last_subdivision,
  sibling_numeros, covered_guias, file_id, pedimento_scan, prevalidation, import_data, import_data_version, sub_status,
  pedimento_reconciliation`;

/** Coverage input for a pedimentos row (numero + declared siblings + covered guías). */
function coverageInput(p: PedimentoRow) {
  return {
    numeroPedimento: p.numero_pedimento ?? '',
    coveredGuias: p.covered_guias ?? [],
    siblings: p.sibling_numeros ?? [],
    isLast: p.is_last_subdivision ?? false,
    ordinal: p.subdivision_ordinal,
  };
}

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
    `SELECT m.id, m.mawb_reference AS "mawbReference", m.client_name AS "clientName", m.created_at AS "createdAt"
     FROM manifests m WHERE ${clauses.join(' AND ')} ORDER BY m.created_at DESC`, params);

  // Coverage replaces the old manifest-column status. Pull every matching manifest's pedimentos
  // rows and guías in one query each, group them, and derive coverage per manifest (no N+1).
  // guideId is a top-level plaintext field on shipments.data — no decryption needed.
  const ids = rows.map((r) => r.id);
  const pedByManifest = new Map<string, PedimentoRow[]>();
  const guiasByManifest = new Map<string, string[]>();
  if (ids.length) {
    const [peds, guias] = await Promise.all([
      query<PedimentoRow>(
        `SELECT ${PEDIMENTO_COLS} FROM pedimentos WHERE manifest_id = ANY($1)`, [ids]),
      query<{ manifest_id: string; guia: string }>(
        `SELECT manifest_id, data->>'guideId' AS guia FROM shipments WHERE manifest_id = ANY($1)`,
        [ids]),
    ]);
    for (const p of peds.rows) {
      const list = pedByManifest.get(p.manifest_id) ?? [];
      list.push(p);
      pedByManifest.set(p.manifest_id, list);
    }
    for (const g of guias.rows) {
      if (!g.guia) continue; // skip null/empty guía values
      const list = guiasByManifest.get(g.manifest_id) ?? [];
      list.push(g.guia);
      guiasByManifest.set(g.manifest_id, list);
    }
  }

  const summaries = rows.map((r) => {
    const peds = pedByManifest.get(r.id) ?? [];
    const manifestGuias = guiasByManifest.get(r.id) ?? [];
    const coverage = computeCoverage(manifestGuias, peds.map(coverageInput));
    return {
      id: r.id,
      mawbReference: r.mawbReference,
      clientName: r.clientName,
      createdAt: r.createdAt,
      coverageStatus: coverage.status,
      expectedCount: coverage.expectedCount,
      uploadedCount: peds.length,
    };
  });
  res.json(summaries);
});

recordsRouter.get('/:id', requireAuth, async (req, res) => {
  const { rows } = await query(
    `SELECT m.id, m.mawb_reference AS "mawbReference", m.client_name AS "clientName",
            m.client_id AS "clientId", m.platform_id AS "platformId",
            m.created_by AS "createdBy",
            m.risk_stale AS "riskStale",
            (SELECT count(*)::int FROM shipments s WHERE s.manifest_id=m.id) AS "shipmentCount"
     FROM manifests m WHERE m.id=$1`, [req.params.id]);
  if (!rows.length) { res.status(404).json({ error: 'Not found' }); return; }
  if (!canSeeAll(req.user!.role) && rows[0].createdBy !== req.user!.userId) {
    res.status(403).json({ error: 'Forbidden' }); return;
  }
  const r = rows[0];

  // Pedimentos (subdivisiones) now own the file_id/scan/lock domain. Each row carries its own PDF.
  const peds = await query<PedimentoRow>(
    `SELECT ${PEDIMENTO_COLS} FROM pedimentos WHERE manifest_id=$1 ORDER BY subdivision_ordinal NULLS LAST, created_at`,
    [req.params.id]);
  const pedimentos = peds.rows.map((p) => ({
    id: p.id,
    numeroPedimento: p.numero_pedimento,
    subdivisionOrdinal: p.subdivision_ordinal,
    isLast: p.is_last_subdivision ?? false,
    fileId: p.file_id,
    scanVerdict: p.pedimento_scan?.verdict ?? null,
    lock: computeLock({ sub_status: p.sub_status }),
    // prevalidation (build output) is now per-pedimento (Task 9). Consumers use this to check
    // whether the subdivision has been structurally validated before PDF attachment/signing.
    prevalidation: p.prevalidation ?? null,
    // import_data (capture) is now per-pedimento (Task 8). The frontend capture form reads/writes
    // these per row and posts to POST /api/pedimentos/:id/import-data.
    importData: p.import_data ?? null,
    importDataVersion: p.import_data_version,
    subStatus: p.sub_status,
    coveredGuias: p.covered_guias ?? [],
    pedimentoPdf: p.file_id ? `/api/files/${p.file_id}` : null,
    reconciliation: p.pedimento_reconciliation ?? null,
    // Per-pedimento report artifacts (Task 10): Reporte General + Layout built over this
    // subdivisión's covered-guía subset + its own import_data.
    artifacts: {
      reports: `/api/pedimentos/${p.id}/reports.json`,
      report: `/api/pedimentos/${p.id}/report.xlsx`,
      layout: `/api/pedimentos/${p.id}/layout.xlsx`,
    },
  }));

  const manifestGuias = (await loadShipments(req.params.id)).map((s) => s.data.guideId);
  const coverage = computeCoverage(manifestGuias, peds.rows.map(coverageInput));

  // Legacy top-level pedimentoPdf is now sourced from the pedimentos rows (first attached file),
  // since manifests.file_id is being dropped. Per-pedimento PDFs live in pedimentos[].
  const topPedimentoFileId = peds.rows.find((p) => p.file_id)?.file_id ?? null;

  // Top-level edit lock: aggregate signal — locked only when ALL pedimentos are finalized (cargado).
  // The per-pedimento lock (pedimentos[].lock) is the authoritative gate for capture; this manifest-
  // level field is a convenience indicator for the UI and will be removed in Task 7.
  const lock = computeLock({ sub_status: peds.rows.length > 0 && peds.rows.every((p) => p.sub_status === 'cargado') ? 'cargado' : null });

  // Carries import-data (business data) — keep it out of shared caches.
  res.setHeader('Cache-Control', 'no-store, private');
  res.json({
    ...r,
    riskStale: !!r.riskStale,
    pedimentoFileId: topPedimentoFileId,
    lock,
    pedimentos,
    coverage,
    artifacts: {
      // Risk stays manifest-level. Reporte General + Layout are now per-pedimento (see pedimentos[].artifacts).
      riskAnalysis: `/api/records/${r.id}/risk.xlsx`,
      pedimentoPdf: topPedimentoFileId ? `/api/files/${topPedimentoFileId}` : null,
    },
  });
});
