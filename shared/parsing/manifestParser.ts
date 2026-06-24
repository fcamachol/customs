import { randomUUID } from 'node:crypto';
import type { Shipment } from '../types/shipment';
import { resolveHeader } from './headerSynonyms';
import { parseNumber, toKg } from './normalize';
import { classifyTaxId } from './taxId';
import { resolveCountry } from './catalogs';

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

export function mapRowToShipment(row: Record<string, unknown>): Shipment {
  const s: any = blankShipment('');
  for (const [rawHeader, raw] of Object.entries(row)) {
    const path = resolveHeader(rawHeader);
    if (!path) continue;
    let value = cleanCell(raw);
    if (path === 'core.originCountry') value = value.toUpperCase();
    if (path === 'core.quantity') { s.quantity = parseNumber(value); continue; }
    if (path === 'core.customsValueUsd') { s.customsValueUsd = parseNumber(value); continue; }
    if (path === 'core.unitPrice') { s.unitPrice = parseNumber(value); continue; }
    if (path === 'core.weight') { s.weight = parseNumber(value); continue; }
    if (path === 'core.appliedRate') { s.appliedRate = parseNumber(value); continue; }
    if (path === 'consignee.taxId') {
      // Generic ID column: route an 18-char CURP to curp, otherwise treat as RFC.
      if (classifyTaxId(value) === 'curp') s.consignee.curp = value;
      else s.consignee.rfc = value;
      continue;
    }
    const [group, key] = path.split('.');
    if (group === 'core') s[key] = value;
    else s[group][key] = value;
  }
  if (s.weight != null) s.weightKg = toKg(s.weight, s.weightUnit ?? '');
  // país de procedencia: explicit column, else sender country code/name.
  const proc = s.procedenceCountry || s.sender?.countryCode || s.sender?.countryName || '';
  const resolvedProc = resolveCountry(proc);
  s.procedenceCountry = resolvedProc ?? (proc ? String(proc).toUpperCase() : '');
  // país de origen (platform): normalize to the ANAM clave, else keep uppercased raw.
  const origin = s.platform?.countryOfOrigin || '';
  if (origin) {
    const resolvedOrigin = resolveCountry(origin);
    s.platform.countryOfOrigin = resolvedOrigin ?? String(origin).toUpperCase();
  }
  return s as Shipment;
}

export function parseManifestRows(rows: Record<string, unknown>[], mawb: string): ParseResult {
  const unmapped = new Set<string>();
  const shipments = rows.map((row) => {
    for (const rawHeader of Object.keys(row)) if (!resolveHeader(rawHeader)) unmapped.add(rawHeader);
    const s = mapRowToShipment(row);
    return { ...s, mawbReference: mawb };
  });
  return { shipments, unmappedHeaders: [...unmapped] };
}
