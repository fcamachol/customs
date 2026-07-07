import { randomUUID } from 'node:crypto';
import type { Shipment } from '../types/shipment';
import { resolveHeader } from './headerSynonyms';
import { parseNumber, toKg } from './normalize';
import { classifyTaxId } from './taxId';
import { resolveCountry } from './catalogs';

// mapRowToShipment is an internal mapper; the only sanctioned manifest entry point is validateManifest.

function cleanCell(v: unknown): string {
  // A guía / ID column that Excel typed as a number arrives here as a JS number (xlsx reads raw
  // cell values). guideId is the join key for the entire pipeline, so a corrupted stringification
  // silently breaks pedimento↔manifest matching. Stringify whole numbers via BigInt: this keeps
  // every digit of long identifiers and never falls back to scientific notation the way String()
  // does for values ≥ 1e21 (String(1e21) === '1e+21'). Non-integer numbers (weights, declared
  // values) keep full String() precision for the strict numeric parsers downstream.
  //
  // Leading zeros are NOT recoverable here: a General-format numeric cell ("0012345") already lost
  // them when Excel stored it as the number 12345. They survive only when the source column is
  // text-formatted, in which case the cell reaches us as a string and takes the branch below.
  if (typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v)) {
    return BigInt(v).toString();
  }
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

export function mapRowToShipment(row: Record<string, unknown>, extraMappings?: Record<string, string>): Shipment {
  const s: any = blankShipment('');
  for (const [rawHeader, raw] of Object.entries(row)) {
    const path = resolveHeader(rawHeader, extraMappings);
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

