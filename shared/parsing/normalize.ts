// Parse a human-entered number that may use comma decimals or dot/space thousands separators.
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
