// Static ISO-3166 / ISO-4217 / weight-unit catalogs for ingestion normalization.
// Code-with-name-fallback (Phase A): prefer an ISO code, else map a Spanish/English name.

const norm = (s: string): string =>
  (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

// alpha-2 → accepted names (Spanish + English). Extend as real feeds require.
const COUNTRY_NAMES: Record<string, string[]> = {
  CN: ['china', 'porcelana'],
  MX: ['mexico', 'estados unidos mexicanos'],
  US: ['estados unidos', 'estados unidos de america', 'usa', 'united states'],
  CA: ['canada'],
  VN: ['vietnam'],
  KR: ['corea del sur', 'corea', 'south korea'],
  JP: ['japon', 'japan'],
  DE: ['alemania', 'germany'],
  ES: ['espana', 'spain'],
  GB: ['reino unido', 'united kingdom'],
  HK: ['hong kong'],
};
const COUNTRY_CODES = new Set(Object.keys(COUNTRY_NAMES));
const COUNTRY_BY_NAME: Record<string, string> = {};
for (const [code, names] of Object.entries(COUNTRY_NAMES)) for (const n of names) COUNTRY_BY_NAME[norm(n)] = code;

export function resolveCountry(codeOrName: string): string | null {
  const raw = (codeOrName ?? '').trim();
  if (!raw) return null;
  const upper = raw.toUpperCase();
  if (upper.length === 2 && COUNTRY_CODES.has(upper)) return upper;
  return COUNTRY_BY_NAME[norm(raw)] ?? null;
}

const CURRENCY_NAMES: Record<string, string[]> = {
  USD: ['dolar estadounidense', 'dolar', 'us dollar', 'dolares'],
  MXN: ['peso mexicano', 'pesos'],
  EUR: ['euro'],
  CAD: ['dolar canadiense'],
};
const CURRENCY_CODES = new Set(Object.keys(CURRENCY_NAMES));
const CURRENCY_BY_NAME: Record<string, string> = {};
for (const [code, names] of Object.entries(CURRENCY_NAMES)) for (const n of names) CURRENCY_BY_NAME[norm(n)] = code;

export function resolveCurrency(codeOrName: string): string | null {
  const raw = (codeOrName ?? '').trim();
  if (!raw) return null;
  const upper = raw.toUpperCase();
  if (upper.length === 3 && CURRENCY_CODES.has(upper)) return upper;
  return CURRENCY_BY_NAME[norm(raw)] ?? null;
}

// unit token → kg multiplier.
const WEIGHT_FACTORS: Record<string, number> = {
  mg: 0.000001,
  g: 0.001, gr: 0.001, gram: 0.001, grams: 0.001, gramo: 0.001, gramos: 0.001,
  kg: 1, kgs: 1, kilogramo: 1, kilogramos: 1, kilo: 1, kilos: 1,
  t: 1000, ton: 1000, tonelada: 1000, toneladas: 1000,
  lb: 0.453592, lbs: 0.453592, libra: 0.453592, libras: 0.453592, pound: 0.453592,
  oz: 0.0283495, onza: 0.0283495, onzas: 0.0283495, ounce: 0.0283495,
};

export function weightFactorToKg(unit: string): number | null {
  const u = norm(unit);
  if (!u) return null;
  return WEIGHT_FACTORS[u] ?? null;
}
