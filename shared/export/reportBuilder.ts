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
  };
}

export interface ReportInput {
  shipments: Shipment[];
  riskByGuide: Record<string, { color: string; incidences: string[] }>;
  importData?: ImportData;
  client?: ClientData;
}

export function buildReportRows(input: ReportInput): Record<string, string>[] {
  const layoutRows = toLayoutRows(input.shipments);

  return layoutRows.map((row, i) => {
    const shipment = input.shipments[i];
    const r = input.riskByGuide[shipment.guideId] ?? { color: '', incidences: [] };

    // Start with the full 34-column layout row
    const out: Record<string, string> = { ...row };

    // Overlay import_data fields (authoritative)
    if (input.importData) {
      const d = input.importData;
      if (d.patente != null) out['Patente AA'] = d.patente;
      if (d.tasaImportacion != null) out['Tasa global o cuota aplicada'] = d.tasaImportacion;
      if (d.claveAduanaEntrada != null) out['Clave de Aduana de entrada'] = d.claveAduanaEntrada;
      if (d.claveAduanaDespacho != null) out['Clave de Aduana de despacho'] = d.claveAduanaDespacho;
      const t1 = d.cveT1;
      if (t1 != null) {
        out['No. de registro T1'] = t1;
        out['No. pedimento'] = t1;
      }
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
      }
    }

    // Append risk columns
    out['Resultado'] = r.color;
    out['Motivo'] = r.incidences.join('; ');

    return out;
  });
}
