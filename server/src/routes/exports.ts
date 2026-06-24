import { Router } from 'express';
import * as XLSX from 'xlsx';
import { query } from '../db/pool';
import { requireAuth } from '../auth/middleware';
import { recordAudit } from '../services/audit';
import { saveFile, readFileById } from '../storage/files';
import {
  assertManifestAccess,
  resolvePedimentoAccess,
  loadShipments,
  loadPedimentoScope,
  layoutRowsFor,
  buildRiskXlsxRows,
  buildReportRowsForPedimento,
  subsetForCoverage,
} from '../services/reportData';

// risk.xlsx stays PER-MANIFEST (shipment-scoped). report.xlsx + layout.xlsx are PER-PEDIMENTO — each
// subdivisión is its own customs submission over its covered-guía subset, with its own cached report.
export const exportsRouter = Router();
export const pedimentoExportsRouter = Router();

function workbook(rows: Record<string, unknown>[]): Buffer {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Hoja1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

function send(res: any, buf: Buffer, name: string) {
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
}

exportsRouter.get('/:id/risk.xlsx', requireAuth, async (req, res) => {
  if (!(await assertManifestAccess(req.params.id, req.user!))) { res.status(403).json({ error: 'Forbidden' }); return; }

  // Serve stored artifact if available
  const { rows: mRows } = await query<{ risk_file_id: string | null }>(
    'SELECT risk_file_id FROM manifests WHERE id=$1', [req.params.id]);
  const riskFileId = mRows[0]?.risk_file_id ?? null;
  if (riskFileId) {
    const stored = await readFileById(riskFileId);
    if (stored) {
      await recordAudit({ userId: req.user!.userId, action: 'EXPORT_RISK', entity: 'manifest', entityId: req.params.id, ip: req.ip });
      send(res, stored.bytes, stored.originalName);
      return;
    }
  }

  // Fallback: regenerate (no stored file yet)
  const rows = await loadShipments(req.params.id);
  send(res, workbook(buildRiskXlsxRows(rows)), 'Analisis_de_Riesgo.xlsx');
  await recordAudit({ userId: req.user!.userId, action: 'EXPORT_RISK', entity: 'manifest', entityId: req.params.id, ip: req.ip });
});

// Per-PEDIMENTO Layout: the covered-guía subset of this subdivisión.
pedimentoExportsRouter.get('/:pedimentoId/layout.xlsx', requireAuth, async (req, res) => {
  const access = await resolvePedimentoAccess(req.params.pedimentoId, req.user!);
  if (!access.found) { res.status(404).json({ error: 'Not found' }); return; }
  if (!access.allowed) { res.status(403).json({ error: 'Forbidden' }); return; }

  const scope = await loadPedimentoScope(req.params.pedimentoId);
  if (!scope) { res.status(404).json({ error: 'Not found' }); return; }
  const subset = subsetForCoverage(await loadShipments(scope.manifestId), scope.coveredGuias);
  // Audit before send so the request completes only after the audit row commits (avoids an
  // audit INSERT racing the next test's TRUNCATE; also the access is durably logged either way).
  await recordAudit({ userId: req.user!.userId, action: 'EXPORT_LAYOUT', entity: 'pedimento', entityId: req.params.pedimentoId, ip: req.ip });
  send(res, workbook(layoutRowsFor(subset)), 'LayOut_sistema.xlsx');
});

// Per-PEDIMENTO Reporte General: built over the covered-guía subset + this pedimento's import_data,
// cached on pedimentos.report_file_id (busted on this pedimento's import-data / client-platform change).
pedimentoExportsRouter.get('/:pedimentoId/report.xlsx', requireAuth, async (req, res) => {
  const access = await resolvePedimentoAccess(req.params.pedimentoId, req.user!);
  if (!access.found) { res.status(404).json({ error: 'Not found' }); return; }
  if (!access.allowed) { res.status(403).json({ error: 'Forbidden' }); return; }

  // Serve stored artifact if available
  const { rows: pRows } = await query<{ report_file_id: string | null }>(
    'SELECT report_file_id FROM pedimentos WHERE id=$1', [req.params.pedimentoId]);
  const reportFileId = pRows[0]?.report_file_id ?? null;
  if (reportFileId) {
    const stored = await readFileById(reportFileId);
    if (stored) {
      await recordAudit({ userId: req.user!.userId, action: 'EXPORT_REPORT', entity: 'pedimento', entityId: req.params.pedimentoId, ip: req.ip });
      send(res, stored.bytes, stored.originalName);
      return;
    }
  }

  // Generate + persist (shared builder — identical rows to the on-screen Reporte General)
  const scope = await loadPedimentoScope(req.params.pedimentoId);
  if (!scope) { res.status(404).json({ error: 'Not found' }); return; }
  const reportRows = await buildReportRowsForPedimento(scope, await loadShipments(scope.manifestId));
  const buf = workbook(reportRows);

  // Persist report artifact on this pedimento row
  const reportFile = await saveFile({
    kind: 'report',
    originalName: 'Reporte_General.xlsx',
    bytes: buf,
    uploadedBy: req.user!.userId,
  });
  await query('UPDATE pedimentos SET report_file_id=$1 WHERE id=$2', [reportFile.id, req.params.pedimentoId]);

  // Audit before send (see EXPORT_LAYOUT note above).
  await recordAudit({ userId: req.user!.userId, action: 'EXPORT_REPORT', entity: 'pedimento', entityId: req.params.pedimentoId, ip: req.ip });
  send(res, buf, 'Reporte_General.xlsx');
});
