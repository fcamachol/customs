import { Router } from 'express';
import * as XLSX from 'xlsx';
import { query } from '../db/pool';
import { requireAuth } from '../auth/middleware';
import { recordAudit } from '../services/audit';
import { saveFile, readFileById } from '../storage/files';
import {
  assertManifestAccess,
  loadShipments,
  layoutRowsFor,
  buildRiskXlsxRows,
  buildReportRowsForManifest,
} from '../services/reportData';

export const exportsRouter = Router();

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

exportsRouter.get('/:id/layout.xlsx', requireAuth, async (req, res) => {
  if (!(await assertManifestAccess(req.params.id, req.user!))) { res.status(403).json({ error: 'Forbidden' }); return; }
  const rows = await loadShipments(req.params.id);
  send(res, workbook(layoutRowsFor(rows)), 'LayOut_sistema.xlsx');
  await recordAudit({ userId: req.user!.userId, action: 'EXPORT_LAYOUT', entity: 'manifest', entityId: req.params.id, ip: req.ip });
});

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

exportsRouter.get('/:id/report.xlsx', requireAuth, async (req, res) => {
  if (!(await assertManifestAccess(req.params.id, req.user!))) { res.status(403).json({ error: 'Forbidden' }); return; }

  // Serve stored artifact if available
  const { rows: mRows } = await query<{ report_file_id: string | null }>(
    'SELECT report_file_id FROM manifests WHERE id=$1', [req.params.id]);
  const reportFileId = mRows[0]?.report_file_id ?? null;
  if (reportFileId) {
    const stored = await readFileById(reportFileId);
    if (stored) {
      await recordAudit({ userId: req.user!.userId, action: 'EXPORT_REPORT', entity: 'manifest', entityId: req.params.id, ip: req.ip });
      send(res, stored.bytes, stored.originalName);
      return;
    }
  }

  // Generate + persist (shared builder — identical rows to the on-screen Reporte General)
  const rows = await loadShipments(req.params.id);
  const reportRows = await buildReportRowsForManifest(req.params.id, rows);
  const buf = workbook(reportRows);

  // Persist report artifact
  const reportFile = await saveFile({
    kind: 'report',
    originalName: 'Reporte_General.xlsx',
    bytes: buf,
    uploadedBy: req.user!.userId,
  });
  await query('UPDATE manifests SET report_file_id=$1 WHERE id=$2', [reportFile.id, req.params.id]);

  send(res, buf, 'Reporte_General.xlsx');
  await recordAudit({ userId: req.user!.userId, action: 'EXPORT_REPORT', entity: 'manifest', entityId: req.params.id, ip: req.ip });
});
