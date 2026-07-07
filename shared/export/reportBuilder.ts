import type { Shipment } from '../types/shipment';
import { toLayoutRows } from './layoutExport';

export interface ImportData {
  cveT1?: string;
  patente?: string;
  agenteAduanal?: string;
  tasaImportacion?: string;
  fechaEntrada?: string;
  claveAduanaEntrada?: string;
  claveAduanaDespacho?: string;
  /** No. de registro — COMPLEMENTO 1 del identificador EM del pedimento (e.g. "147"). */
  noRegistro?: string;
  /** No. de pedimento — consecutivo del NUM. PEDIMENTO (e.g. "6001719"). */
  noPedimento?: string;
}

/** ISO yyyy-mm-dd → dd/mm/yyyy (pedimento presentation); any other shape passes through. */
function toDisplayDate(v: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : v;
}

export interface ClientData {
  name: string;
  tax_id?: string;
  address?: string;
  phone?: string;
  email?: string;
  platform?: {
    commercialName?: string;
    countryOfOrigin?: string;
    legalName?: string;
    email?: string;
    url?: string;
  };
}

/** D3: validated RFC/CURP for a CNNE, keyed by the manifest ID (rfc/curp/id del CNNE). */
export interface ValidatedRfc {
  rfc?: string;
  curp?: string;
  name?: string;
}

export interface ReportInput {
  shipments: Shipment[];
  riskByGuide: Record<string, { color: string; incidences: string[] }>;
  importData?: ImportData;
  client?: ClientData;
  /** D3 enrichment: lookup of validated RFC/CURP keyed by normalized consignee ID */
  validatedRfcs?: Record<string, ValidatedRfc>;
}

export function buildReportRows(input: ReportInput): Record<string, string>[] {
  const layoutRows = toLayoutRows(input.shipments);

  return layoutRows.map((row, i) => {
    const shipment = input.shipments[i];
    const r = input.riskByGuide[shipment.guideId] ?? { color: '', incidences: [] };

    // Start with the full 34-column layout row
    const out: Record<string, string> = { ...row };

    // D3: enrich the CNNE RFC/CURP from the validated-RFCs catalog when the manifest only carried
    // an ID. Lookup by the consignee's id (rfc/curp/id), normalized; only fills empty cells.
    if (input.validatedRfcs) {
      const key = (shipment.consignee.rfc || shipment.consignee.curp || '').trim().toUpperCase();
      const hit = key ? input.validatedRfcs[key] : undefined;
      if (hit) {
        if (hit.rfc && !out['Consignatario RFC']) out['Consignatario RFC'] = hit.rfc;
        if (hit.curp && !out['Consignatario CURP']) out['Consignatario CURP'] = hit.curp;
      }
    }

    // Overlay import_data fields (authoritative)
    if (input.importData) {
      const d = input.importData;
      if (d.patente != null) out['Patente AA'] = d.patente;
      if (d.tasaImportacion != null) out['Tasa global o cuota aplicada'] = d.tasaImportacion;
      if (d.claveAduanaEntrada != null) out['Clave de Aduana de entrada'] = d.claveAduanaEntrada;
      if (d.claveAduanaDespacho != null) out['Clave de Aduana de despacho'] = d.claveAduanaDespacho;
      // No. de registro = identificador EM (complemento 1); No. pedimento = consecutivo del
      // NUM. PEDIMENTO. The Clave T1 is a régimen flag, not a registry/pedimento number.
      if (d.noRegistro != null) out['No. de registro T1'] = d.noRegistro;
      if (d.noPedimento != null) out['No. pedimento'] = d.noPedimento;
      // Fecha de arribo = ENTRADA of the pedimento's FECHAS block (captured as fechaEntrada).
      if (d.fechaEntrada) out['Fecha de arribo a territorio nacional'] = toDisplayDate(d.fechaEntrada);
    }

    // Overlay client Remitente block (authoritative)
    if (input.client) {
      const c = input.client;
      out['Remitente Nombre/razón social'] = c.name;
      if (c.tax_id != null) out['Remitente Id fiscal'] = c.tax_id;
      if (c.address != null) out['Remitente Domicilio'] = c.address;
      if (c.phone != null) out['Remitente Teléfono'] = c.phone;
      if (c.email != null) out['Remitente Correo'] = c.email;

      // Overlay client Plataforma block (authoritative)
      if (c.platform) {
        const p = c.platform;
        if (p.commercialName != null) out['Plataforma Nombre comercial'] = p.commercialName;
        if (p.countryOfOrigin != null) out['Plataforma País de origen'] = p.countryOfOrigin;
        if (p.legalName != null) out['Plataforma Razón social'] = p.legalName;
        if (p.email != null) out['Plataforma Correo'] = p.email;
        if (p.url != null) out['Plataforma URL'] = p.url;
      }
    }

    // Append risk columns
    out['Resultado'] = r.color;
    out['Motivo'] = r.incidences.join('; ');

    return out;
  });
}
