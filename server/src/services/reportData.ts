import { query } from '../db/pool';
import { canSeeAll } from '../auth/access';
import type { Claims } from '../auth/token';
import { decryptShipment } from '../crypto/fieldCrypto';
import { toLayoutRows } from '../../../shared/export/layoutExport';
import { buildReportRows } from '../../../shared/export/reportBuilder';
import { countryDisplayName } from '../../../shared/parsing/catalogs';
import { traducirDescripcion } from '../../../shared/i18n/descripcionEs';
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

/**
 * Resolve a pedimento → its manifest and apply the same access rule as assertManifestAccess.
 * Returns the manifest_id when access is granted, or null (not found OR forbidden — the caller
 * distinguishes via the `found` flag) so the route can answer 404 vs 403 correctly.
 */
export async function resolvePedimentoAccess(
  pedimentoId: string,
  user: Claims,
): Promise<{ found: boolean; allowed: boolean; manifestId: string | null }> {
  const { rows } = await query<{ manifest_id: string; created_by: string | null }>(
    `SELECT p.manifest_id, m.created_by
       FROM pedimentos p JOIN manifests m ON m.id = p.manifest_id
      WHERE p.id = $1`,
    [pedimentoId],
  );
  if (!rows.length) return { found: false, allowed: false, manifestId: null };
  const allowed = canSeeAll(user.role) || rows[0].created_by === user.userId;
  return { found: true, allowed, manifestId: rows[0].manifest_id };
}

/** Load + decrypt all shipments for a manifest (PII decrypted; safe to score/export). */
export async function loadShipments(manifestId: string): Promise<LoadedShipment[]> {
  const { rows } = await query<LoadedShipment>(
    'SELECT data, risk_color, risk_incidences FROM shipments WHERE manifest_id=$1', [manifestId]);
  return rows.map((r) => ({ ...r, data: decryptShipment(r.data) }));
}

/** Rows for the downloadable Análisis de Riesgo workbook (compliance artifact). */
export function buildRiskXlsxRows(loaded: LoadedShipment[]): Record<string, string>[] {
  return loaded.map((r) => ({
    Guia: r.data.guideId,
    Destinatario: r.data.consignee.name,
    'Descripción de la mercancía': traducirDescripcion(r.data.description ?? ''),
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
    description: traducirDescripcion(r.data.description ?? ''),
    resultado: (r.risk_color ?? 'gris') as RiskResultado,
    motivo: (r.risk_incidences ?? []).join('; '),
  }));
}

/** Fetch the client/platform overlay (Remitente + Plataforma blocks) for a manifest's report. */
async function clientOverlay(manifestId: string) {
  const m = await query(
    `SELECT c.name, c.tax_id, c.address, c.phone, c.email,
            p.commercial_name, p.country_of_origin, p.legal_name, p.email AS platform_email, p.url AS platform_url
     FROM manifests m
     LEFT JOIN clients c ON c.id = m.client_id
     LEFT JOIN client_platforms p ON p.id = m.platform_id
     WHERE m.id = $1`,
    [manifestId],
  );
  const manifest = m.rows[0] ?? {};
  if (!manifest.name) return undefined;
  return {
    name: manifest.name as string,
    tax_id: manifest.tax_id ?? undefined,
    address: manifest.address ?? undefined,
    phone: manifest.phone ?? undefined,
    email: manifest.email ?? undefined,
    // Always pass a platform object so the client-platform is authoritative over
    // any platform embedded in individual shipments. When platform_id is null all
    // four fields are empty strings, which clears the Plataforma block.
    platform: {
      commercialName: manifest.commercial_name ?? '',
      countryOfOrigin: countryDisplayName(manifest.country_of_origin ?? ''),
      legalName: manifest.legal_name ?? '',
      email: manifest.platform_email ?? '',
      url: manifest.platform_url ?? '',
    },
  };
}

/** D3: enrich CNNE RFC/CURP from the validated-RFCs catalog, scoped to the given consignee keys. */
async function validatedRfcsFor(loaded: LoadedShipment[]): Promise<Record<string, { rfc?: string; curp?: string; name?: string }>> {
  const keys = Array.from(
    new Set(
      loaded
        .map((r) => (r.data.consignee.rfc || r.data.consignee.curp || '').trim().toUpperCase())
        .filter(Boolean),
    ),
  );
  if (keys.length === 0) return {};
  const { rows: rfcRows } = await query<{ id_ref: string; rfc: string | null; curp: string | null; name: string | null }>(
    'SELECT id_ref, rfc, curp, name FROM validated_rfcs WHERE upper(btrim(id_ref)) = ANY($1)', [keys]);
  return Object.fromEntries(
    rfcRows.map((r) => [r.id_ref.trim().toUpperCase(), { rfc: r.rfc ?? undefined, curp: r.curp ?? undefined, name: r.name ?? undefined }]),
  );
}

/** Shared assembler: build the Reporte General rows over a shipment subset + import_data + overlay. */
async function reportRows(
  manifestId: string,
  loaded: LoadedShipment[],
  importData: Record<string, unknown> | undefined,
): Promise<Record<string, string>[]> {
  return buildReportRows({
    shipments: loaded.map((r) => r.data),
    riskByGuide: Object.fromEntries(loaded.map((r) => [r.data.guideId, { color: r.risk_color ?? '', incidences: r.risk_incidences ?? [] }])),
    importData,
    validatedRfcs: await validatedRfcsFor(loaded),
    client: await clientOverlay(manifestId),
  });
}

/** A pedimento subdivision: its manifest, its covered-guía subset, and its captured import_data. */
export interface PedimentoReportScope {
  manifestId: string;
  coveredGuias: string[];
  importData: Record<string, unknown> | undefined;
}

/** Load a pedimento's report scope (manifest + covered_guias + import_data). Null if not found. */
export async function loadPedimentoScope(pedimentoId: string): Promise<PedimentoReportScope | null> {
  const { rows } = await query<{ manifest_id: string; covered_guias: string[] | null; import_data: Record<string, unknown> | null }>(
    'SELECT manifest_id, covered_guias, import_data FROM pedimentos WHERE id=$1', [pedimentoId]);
  if (!rows.length) return null;
  return {
    manifestId: rows[0].manifest_id,
    coveredGuias: rows[0].covered_guias ?? [],
    importData: rows[0].import_data ?? undefined,
  };
}

/** Narrow a manifest's shipments to a pedimento's covered-guía subset (empty subset → no rows). */
export function subsetForCoverage(loaded: LoadedShipment[], coveredGuias: string[]): LoadedShipment[] {
  if (!coveredGuias.length) return [];
  const set = new Set(coveredGuias);
  return loaded.filter((s) => set.has(s.data.guideId));
}

/**
 * Build the Reporte General rows for one PEDIMENTO (subdivisión): its covered-guía shipment subset +
 * its own captured import_data + the manifest's client/platform overlay + D3 validated-RFC enrichment.
 * Each subdivision is its own customs submission, so a shipment NOT in covered_guias is absent here.
 * Pass pre-loaded manifest shipments to avoid a second decrypt.
 */
export async function buildReportRowsForPedimento(
  scope: PedimentoReportScope,
  loadedManifest: LoadedShipment[],
): Promise<Record<string, string>[]> {
  const subset = subsetForCoverage(loadedManifest, scope.coveredGuias);
  return reportRows(scope.manifestId, subset, scope.importData);
}

export const layoutRowsFor = (loaded: LoadedShipment[]): Record<string, string>[] =>
  toLayoutRows(loaded.map((r) => r.data));
