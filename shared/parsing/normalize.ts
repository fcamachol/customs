/**
 * Parse a human-entered number that may use comma decimals or dot/space thousands separators.
 *
 * INTERNAL PRE-FILL ONLY: This is a lenient parser used only inside mapRowToShipment for initial mapping.
 * It MUST NOT be used as a validation gate. All required numerics are re-validated with parseNumberStrict
 * at the boundary (validateManifest), which rejects ambiguous inputs like "1,000" and non-numeric values.
 */
export function parseNumber(raw: string): number {
  const s = String(raw ?? '').trim();
  if (!s) return 0;
  let t = s.replace(/[^\d.,-]/g, '');
  const lastComma = t.lastIndexOf(','), lastDot = t.lastIndexOf('.');
  if (lastComma > lastDot) t = t.replace(/\./g, '').replace(',', '.'); // comma is decimal
  else t = t.replace(/,/g, '');                                        // dot is decimal
  const n = Number(t);
  return Number.isFinite(n) ? n : 0;
}

export function toKg(value: number, unit: string): number {
  const u = (unit ?? '').trim().toLowerCase();
  if (u.startsWith('g')) return value / 1000;          // gramo/g/grams
  return value;                                         // kg default
}

// Strict number parsing: never silently coerces. Returns discriminated result with error codes.
import { weightFactorToKg } from './catalogs';

export type NumberResult = { ok: true; value: number } | { ok: false; code: 'not_a_number' | 'ambiguous_locale' };

// Strict variant of parseNumber: never silently coerces. Flags locale-ambiguous inputs
// like "1,000" where the comma could be a thousands separator OR a decimal point.
export function parseNumberStrict(raw: string): NumberResult {
  const s = String(raw ?? '').trim();
  if (!s) return { ok: false, code: 'not_a_number' };
  const cleaned = s.replace(/[^\d.,-]/g, '');
  if (!/\d/.test(cleaned)) return { ok: false, code: 'not_a_number' };
  const lastComma = cleaned.lastIndexOf(','), lastDot = cleaned.lastIndexOf('.');
  // Ambiguous: exactly one comma, no dot, and exactly 3 digits after the comma → could be 1.000 or 1000.
  if (lastComma !== -1 && lastDot === -1) {
    const after = cleaned.slice(lastComma + 1);
    const commas = (cleaned.match(/,/g) ?? []).length;
    if (commas === 1 && /^\d{3}$/.test(after)) return { ok: false, code: 'ambiguous_locale' };
  }
  let t = cleaned;
  if (lastComma > lastDot) t = t.replace(/\./g, '').replace(',', '.');
  else t = t.replace(/,/g, '');
  const n = Number(t);
  return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, code: 'not_a_number' };
}

export function convertWeight(value: number, unit: string): { ok: true; kg: number } | { ok: false } {
  const factor = weightFactorToKg(unit);
  if (factor === null) return { ok: false };
  return { ok: true, kg: value * factor };
}

// Excel serial epoch is 1899-12-30 (accounts for the Lotus 1900 leap-year bug).
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
const iso = (d: Date): string => d.toISOString().slice(0, 10);

export type DateResult = { ok: true; iso: string; ambiguous?: true } | { ok: false };

export function parseManifestDate(raw: unknown): DateResult {
  if (raw == null || raw === '') return { ok: false };
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return { ok: true, iso: iso(new Date(EXCEL_EPOCH + raw * 86400000)) };
  }
  const s = String(raw).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) { const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])); return Number.isNaN(d.getTime()) ? { ok: false } : { ok: true, iso: iso(d) }; }
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/); // dd/mm/yyyy (assumed reading)
  if (m) {
    const day = +m[1], month = +m[2], year = +m[3];
    const d = new Date(Date.UTC(year, month - 1, day));
    if (Number.isNaN(d.getTime()) || month > 12) return { ok: false };
    // Ambiguous with a mm/dd reading only when both numbers could be a month (<=12) and swapping them changes the date.
    const ambiguous = day <= 12 && day !== month;
    return ambiguous ? { ok: true, iso: iso(d), ambiguous: true } : { ok: true, iso: iso(d) };
  }
  return { ok: false };
}
