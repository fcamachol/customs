import { randomUUID } from 'node:crypto';
import type { Shipment } from '../types/shipment';
import { resolveHeader } from './headerSynonyms';
import { parseNumber, toKg } from './normalize';

export interface ParseResult { shipments: Shipment[]; unmappedHeaders: string[]; }

function cleanCell(v: unknown): string {
  return String(v ?? '').replace(/\s*\n\s*/g, ' ').trim();
}

function blankShipment(mawb: string): Shipment {
  return {
    id: randomUUID(), mawbReference: mawb,
    description: '', hsCode: '', quantity: 0, unit: '', customsValueUsd: 0,
    currency: '', originCountry: '', guideId: '',
    consignee: { name: '', rfc: '' }, sender: { name: '' }, platform: { commercialName: '' },
  } as Shipment;
}

export function parseManifestRows(rows: Record<string, unknown>[], mawb: string): ParseResult {
  const unmapped = new Set<string>();
  const shipments = rows.map((row) => {
    const s: any = blankShipment(mawb);
    for (const [rawHeader, raw] of Object.entries(row)) {
      const path = resolveHeader(rawHeader);
      if (!path) { unmapped.add(rawHeader); continue; }
      let value = cleanCell(raw);
      if (path === 'core.originCountry') value = value.toUpperCase();
      if (path === 'core.quantity') { s.quantity = parseNumber(value); continue; }
      if (path === 'core.customsValueUsd') { s.customsValueUsd = parseNumber(value); continue; }
      if (path === 'core.unitPrice') { s.unitPrice = parseNumber(value); continue; }
      if (path === 'core.weight') { s.weight = parseNumber(value); continue; }
      if (path === 'core.appliedRate') { s.appliedRate = parseNumber(value); continue; }
      const [group, key] = path.split('.');
      if (group === 'core') s[key] = value;
      else s[group][key] = value;
    }
    if (s.weight != null) s.weightKg = toKg(s.weight, s.weightUnit ?? '');
    return s as Shipment;
  });
  return { shipments, unmappedHeaders: [...unmapped] };
}
