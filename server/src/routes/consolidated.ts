import { Router, type Response } from 'express';
import * as XLSX from 'xlsx';
import { query } from '../db/pool';
import { requireAuth, requireRole } from '../auth/middleware';
import { recordAudit } from '../services/audit';
import { decryptConsignee } from '../crypto/fieldCrypto';
import type { Shipment } from '../../../shared/types/shipment';

export const consolidatedRouter = Router();

function workbook(rows: Record<string, unknown>[]): Buffer {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Hoja1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

function send(res: Response, buf: Buffer, name: string) {
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
}

consolidatedRouter.get(
  '/consolidated.xlsx',
  requireAuth,
  requireRole('autoridad', 'admin'),
  async (req, res, next) => {
    const { period, date, start, end, clientId, client } = req.query as Record<string, string | undefined>;

    if (!period && !date && !(start && end)) {
      res.status(400).json({ error: 'Provide ?period=YYYY-MM, ?date=YYYY-MM-DD, or ?start=&end= (RF-23)' });
      return;
    }

    let rangeStart: string;
    let rangeEnd: string;
    let label: string;

    if (start && end) {
      // RF-23: explicit date range [start, end] inclusive of the end day.
      const s = new Date(start + 'T00:00:00Z');
      const e = new Date(end + 'T00:00:00Z');
      if (isNaN(s.getTime()) || isNaN(e.getTime())) { res.status(400).json({ error: 'Invalid start/end' }); return; }
      if (e < s) { res.status(400).json({ error: 'end must be >= start' }); return; }
      rangeStart = s.toISOString();
      const next = new Date(e);
      next.setUTCDate(next.getUTCDate() + 1); // half-open: include the whole end day
      rangeEnd = next.toISOString();
      label = `${start}_${end}`;
    } else if (date) {
      // Daily: half-open range [date, date + 1 day)
      const d = new Date(date + 'T00:00:00Z');
      if (isNaN(d.getTime())) { res.status(400).json({ error: 'Invalid date' }); return; }
      rangeStart = d.toISOString();
      const next = new Date(d);
      next.setUTCDate(next.getUTCDate() + 1);
      rangeEnd = next.toISOString();
      label = date;
    } else {
      // Monthly: half-open range [first of month, first of next month)
      const match = /^(\d{4})-(\d{2})$/.exec(period!);
      if (!match) { res.status(400).json({ error: 'Invalid period, expected YYYY-MM' }); return; }
      const year = parseInt(match[1], 10);
      const month = parseInt(match[2], 10);
      rangeStart = new Date(Date.UTC(year, month - 1, 1)).toISOString();
      rangeEnd = new Date(Date.UTC(year, month, 1)).toISOString();
      label = period!;
    }

    // RF-23: optional client filter — by client_id (catalog) or client_name (free text, case-insensitive).
    const params: unknown[] = [rangeStart, rangeEnd];
    let clientFilter = '';
    if (clientId) {
      params.push(clientId);
      clientFilter = ` AND m.client_id = $${params.length}`;
    } else if (client) {
      params.push(client);
      clientFilter = ` AND m.client_name ILIKE '%' || $${params.length} || '%'`;
    }

    // F20a fix: select the full data jsonb and decrypt PII in JS —
    // SQL JSON operators cannot decrypt AES-GCM ciphertext, so extracting
    // s.data->'consignee'->>'name' via SQL would leak "v1:…" ciphertext into
    // the authority-facing workbook. We decrypt consignee in JS before building rows.
    const { rows } = await query<{
      mawb: string;
      client_name: string;
      data: Shipment;
      risk_color: string | null;
    }>(
      `SELECT
         m.mawb_reference AS mawb,
         m.client_name,
         s.data,
         s.risk_color
       FROM shipments s
       JOIN manifests m ON m.id = s.manifest_id
       WHERE m.created_at >= $1 AND m.created_at < $2${clientFilter}
       ORDER BY m.created_at, s.data->>'guideId'`,
      params,
    );

    const sheetRows = rows.map((r) => {
      const consignee = decryptConsignee(r.data.consignee);
      return {
        MAWB: r.mawb,
        Cliente: r.client_name,
        Guia: r.data.guideId,
        Consignatario: consignee.name,
        Valor: r.data.customsValueUsd ?? 0,
        Resultado: r.risk_color ?? '',
        Valida: r.risk_color === 'verde',
      };
    });

    const buf = workbook(sheetRows);

    // Fail-closed audit: this is an AUTHORITY download in a compliance system.
    // The audit row MUST be durably written BEFORE the file is delivered.
    // If the audit write fails, do NOT deliver the file — surface a 500 so the
    // access is never silently unlogged (no audit ⇒ no export).
    try {
      await recordAudit({
        userId: req.user!.userId,
        action: 'EXPORT_CONSOLIDATED',
        ip: req.ip,
      });
    } catch (err) {
      next(err);
      return;
    }

    send(res, buf, `Consolidado_${label}.xlsx`);
  },
);
