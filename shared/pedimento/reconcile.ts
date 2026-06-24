import type { ExpectedPedimento } from '../types/reports';

export interface ExpectedShipment {
  guideId: string;
  customsValueUsd: number;
  consignee: { name: string; rfc?: string | null; curp?: string | null };
}

export function buildExpectedFromManifest(shipments: ExpectedShipment[]): { expected: ExpectedPedimento; warnings: string[] } {
  const byGuia = new Map<string, { valueUsd: number; consigneeName: string; id: string; names: Set<string>; ids: Set<string> }>();
  for (const s of shipments) {
    const id = (s.consignee.curp ?? s.consignee.rfc ?? '') as string;
    const existing = byGuia.get(s.guideId);
    if (!existing) {
      byGuia.set(s.guideId, { valueUsd: s.customsValueUsd, consigneeName: s.consignee.name, id, names: new Set([s.consignee.name]), ids: new Set([id]) });
    } else {
      existing.valueUsd += s.customsValueUsd;
      existing.names.add(s.consignee.name);
      existing.ids.add(id);
    }
  }
  const warnings: string[] = [];
  const lines = [...byGuia.entries()].map(([guia, e]) => {
    if (e.names.size > 1) warnings.push(`Guía ${guia}: múltiples destinatarios en el manifiesto (${[...e.names].join(', ')})`);
    if (e.ids.size > 1) warnings.push(`Guía ${guia}: múltiples RFC/CURP en el manifiesto`);
    return { guia, valueUsd: Math.round(e.valueUsd * 100) / 100, consigneeName: e.consigneeName, id: e.id };
  });
  return { expected: { header: {}, lines }, warnings };
}
