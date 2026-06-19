import { Router } from 'express';
import * as XLSX from 'xlsx';
import { query } from '../db/pool';
import { requireAuth } from '../auth/middleware';
import { canSeeAll } from '../auth/access';
import { recordAudit } from '../services/audit';
import type { Claims } from '../auth/token';
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

// Returns true if the user may access the given manifest (admin/autoridad always; capturista only own).
async function assertManifestAccess(manifestId: string, user: Claims): Promise<boolean> {
  if (canSeeAll(user.role)) return true;
  const { rows } = await query<{ created_by: string | null }>(
    'SELECT created_by FROM manifests WHERE id=$1', [manifestId]);
  return rows.length > 0 && rows[0].created_by === user.userId;
}

async function loadShipments(manifestId: string): Promise<{ data: Shipment; risk_color: string | null; risk_incidences: string[] | null }[]> {
  const { rows } = await query<{ data: Shipment; risk_color: string | null; risk_incidences: string[] | null }>(
    'SELECT data, risk_color, risk_incidences FROM shipments WHERE manifest_id=$1', [manifestId]);
  return rows;
}

exportsRouter.get('/:id/layout.xlsx', requireAuth, async (req, res) => {
  if (!(await assertManifestAccess(req.params.id, req.user!))) { res.status(403).json({ error: 'Forbidden' }); return; }
  const rows = await loadShipments(req.params.id);
  send(res, workbook(toLayoutRows(rows.map((r) => r.data))), 'LayOut_sistema.xlsx');
  await recordAudit({ userId: req.user!.userId, action: 'EXPORT_LAYOUT', entity: 'manifest', entityId: req.params.id, ip: req.ip });
});

exportsRouter.get('/:id/risk.xlsx', requireAuth, async (req, res) => {
  if (!(await assertManifestAccess(req.params.id, req.user!))) { res.status(403).json({ error: 'Forbidden' }); return; }
  const rows = await loadShipments(req.params.id);
  const out = rows.map((r) => ({ Guia: r.data.guideId, Destinatario: r.data.consignee.name, Resultado: r.risk_color ?? '' }));
  send(res, workbook(out), 'Analisis_de_Riesgo.xlsx');
  await recordAudit({ userId: req.user!.userId, action: 'EXPORT_RISK', entity: 'manifest', entityId: req.params.id, ip: req.ip });
});

exportsRouter.get('/:id/report.xlsx', requireAuth, async (req, res) => {
  if (!(await assertManifestAccess(req.params.id, req.user!))) { res.status(403).json({ error: 'Forbidden' }); return; }
  const m = await query(
    `SELECT m.import_data, c.name, c.tax_id, c.address, c.phone, c.email, c.platform
     FROM manifests m
     LEFT JOIN clients c ON c.id = m.client_id
     WHERE m.id = $1`,
    [req.params.id],
  );
  const manifest = m.rows[0] ?? {};
  const rows = await loadShipments(req.params.id);
  const reportRows = buildReportRows({
    shipments: rows.map((r) => r.data),
    riskByGuide: Object.fromEntries(rows.map((r) => [r.data.guideId, { color: r.risk_color ?? '', incidences: r.risk_incidences ?? [] }])),
    importData: manifest.import_data ?? undefined,
    client: manifest.name ? {
      name: manifest.name,
      tax_id: manifest.tax_id ?? undefined,
      address: manifest.address ?? undefined,
      phone: manifest.phone ?? undefined,
      email: manifest.email ?? undefined,
      platform: manifest.platform ?? undefined,
    } : undefined,
  });
  send(res, workbook(reportRows), 'Reporte_General.xlsx');
  await recordAudit({ userId: req.user!.userId, action: 'EXPORT_REPORT', entity: 'manifest', entityId: req.params.id, ip: req.ip });
});
