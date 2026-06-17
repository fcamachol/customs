import { Router } from 'express';
import * as XLSX from 'xlsx';
import { query } from '../db/pool';
import { requireAuth } from '../auth/middleware';
import { recordAudit } from '../services/audit';
import { toLayoutRows } from '../../../shared/export/layoutExport';
import { buildReportRows } from '../../../shared/export/reportBuilder';
import type { Shipment } from '../../../shared/types/shipment';

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

async function loadShipments(manifestId: string): Promise<{ data: Shipment; risk_color: string | null }[]> {
  const { rows } = await query<{ data: Shipment; risk_color: string | null }>(
    'SELECT data, risk_color FROM shipments WHERE manifest_id=$1', [manifestId]);
  return rows;
}

exportsRouter.get('/:id/layout.xlsx', requireAuth, async (req, res) => {
  const rows = await loadShipments(req.params.id);
  send(res, workbook(toLayoutRows(rows.map((r) => r.data))), 'LayOut_sistema.xlsx');
  await recordAudit({ userId: req.user!.userId, action: 'EXPORT_LAYOUT', entity: 'manifest', entityId: req.params.id });
});

exportsRouter.get('/:id/risk.xlsx', requireAuth, async (req, res) => {
  const rows = await loadShipments(req.params.id);
  const out = rows.map((r) => ({ Guia: r.data.guideId, Destinatario: r.data.consignee.name, Resultado: r.risk_color ?? '' }));
  send(res, workbook(out), 'Analisis_de_Riesgo.xlsx');
  await recordAudit({ userId: req.user!.userId, action: 'EXPORT_RISK', entity: 'manifest', entityId: req.params.id });
});

exportsRouter.get('/:id/report.xlsx', requireAuth, async (req, res) => {
  const m = await query(`SELECT client_name FROM manifests WHERE id=$1`, [req.params.id]);
  const rows = await loadShipments(req.params.id);
  const reportRows = buildReportRows({
    shipments: rows.map((r) => r.data),
    riskByGuide: Object.fromEntries(rows.map((r) => [r.data.guideId, { color: r.risk_color ?? '', incidences: [] }])),
    client: { name: m.rows[0]?.client_name ?? '' },
  });
  send(res, workbook(reportRows), 'Reporte_General.xlsx');
  await recordAudit({ userId: req.user!.userId, action: 'EXPORT_REPORT', entity: 'manifest', entityId: req.params.id });
});
