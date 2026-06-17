import type { Shipment } from '../types/shipment';

export interface ReportInput {
  shipments: Shipment[];
  riskByGuide: Record<string, { color: string; incidences: string[] }>;
  client: { name: string; taxId?: string };
}

export function buildReportRows(input: ReportInput): Record<string, string>[] {
  return input.shipments.map((s) => {
    const r = input.riskByGuide[s.guideId] ?? { color: '', incidences: [] };
    return {
      Guia: s.guideId,
      Destinatario: s.consignee.name,
      ValorUSD: String(s.customsValueUsd),
      Resultado: r.color,
      Motivo: r.incidences.join('; '),
      Cliente: input.client.name,
      ClienteIdFiscal: input.client.taxId ?? '',
    };
  });
}
