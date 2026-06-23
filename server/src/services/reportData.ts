import { query } from '../db/pool';
import { canSeeAll } from '../auth/access';
import type { Claims } from '../auth/token';
import { decryptShipment } from '../crypto/fieldCrypto';
import { toLayoutRows } from '../../../shared/export/layoutExport';
import { buildReportRows } from '../../../shared/export/reportBuilder';
import type { Shipment } from '../../../shared/types/shipment';
import type { RiskScreenRow, RiskResultado } from '../../../shared/types/reports';

export interface LoadedShipment {
  data: Shipment;
  risk_color: string | null;
  risk_incidences: string[] | null;
}

/** Returns true if the user may access the given manifest (RF-22: all internal roles share visibility). */
export async function assertManifestAccess(manifestId: string, user: Claims): Promise<boolean> {
  if (canSeeAll(user.role)) return true;
  const { rows } = await query<{ created_by: string | null }>(
    'SELECT created_by FROM manifests WHERE id=$1', [manifestId]);
  return rows.length > 0 && rows[0].created_by === user.userId;
}

/** Load + decrypt all shipments for a manifest (PII decrypted; safe to score/export). */
export async function loadShipments(manifestId: string): Promise<LoadedShipment[]> {
  const { rows } = await query<LoadedShipment>(
    'SELECT data, risk_color, risk_incidences FROM shipments WHERE manifest_id=$1', [manifestId]);
  return rows.map((r) => ({ ...r, data: decryptShipment(r.data) }));
}

/** 4-column rows for the downloadable Análisis de Riesgo workbook (compliance artifact). */
export function buildRiskXlsxRows(loaded: LoadedShipment[]): Record<string, string>[] {
  return loaded.map((r) => ({
    Guia: r.data.guideId,
    Destinatario: r.data.consignee.name,
    Resultado: r.risk_color ?? '',
    Motivo: (r.risk_incidences ?? []).join('; '),
  }));
}

/** Richer rows for the on-screen risk table. */
export function buildRiskScreenRows(loaded: LoadedShipment[]): RiskScreenRow[] {
  return loaded.map((r) => ({
    mwb: r.data.mawbReference,
    guide: r.data.guideId,
    consignee: r.data.consignee.name,
    senderCity: r.data.sender.address ?? '',
    senderCountry: r.data.platform.countryOfOrigin ?? r.data.originCountry,
    resultado: (r.risk_color ?? 'gris') as RiskResultado,
    motivo: (r.risk_incidences ?? []).join('; '),
  }));
}

/**
 * Build the 36-column Reporte General rows for a manifest, merging import_data + client overlay +
 * D3 validated-RFC enrichment. Used by both the .xlsx export and the on-screen JSON bundle so the
 * two never diverge. Pass pre-loaded shipments to avoid a second decrypt.
 */
export async function buildReportRowsForManifest(
  manifestId: string,
  loaded: LoadedShipment[],
): Promise<Record<string, string>[]> {
  const m = await query(
    `SELECT m.import_data, c.name, c.tax_id, c.address, c.phone, c.email, c.platform
     FROM manifests m
     LEFT JOIN clients c ON c.id = m.client_id
     WHERE m.id = $1`,
    [manifestId],
  );
  const manifest = m.rows[0] ?? {};

  // D3: enrich the CNNE RFC/CURP from the validated-RFCs catalog, scoped to this manifest's
  // consignee keys (id_ref is UNIQUE → indexed) rather than scanning the whole table.
  const keys = Array.from(
    new Set(
      loaded
        .map((r) => (r.data.consignee.rfc || r.data.consignee.curp || '').trim().toUpperCase())
        .filter(Boolean),
    ),
  );
  let validatedRfcs: Record<string, { rfc?: string; curp?: string; name?: string }> = {};
  if (keys.length > 0) {
    const { rows: rfcRows } = await query<{ id_ref: string; rfc: string | null; curp: string | null; name: string | null }>(
      'SELECT id_ref, rfc, curp, name FROM validated_rfcs WHERE upper(btrim(id_ref)) = ANY($1)', [keys]);
    validatedRfcs = Object.fromEntries(
      rfcRows.map((r) => [r.id_ref.trim().toUpperCase(), { rfc: r.rfc ?? undefined, curp: r.curp ?? undefined, name: r.name ?? undefined }]),
    );
  }

  return buildReportRows({
    shipments: loaded.map((r) => r.data),
    riskByGuide: Object.fromEntries(loaded.map((r) => [r.data.guideId, { color: r.risk_color ?? '', incidences: r.risk_incidences ?? [] }])),
    importData: manifest.import_data ?? undefined,
    validatedRfcs,
    client: manifest.name ? {
      name: manifest.name,
      tax_id: manifest.tax_id ?? undefined,
      address: manifest.address ?? undefined,
      phone: manifest.phone ?? undefined,
      email: manifest.email ?? undefined,
      platform: manifest.platform ?? undefined,
    } : undefined,
  });
}

export const layoutRowsFor = (loaded: LoadedShipment[]): Record<string, string>[] =>
  toLayoutRows(loaded.map((r) => r.data));
