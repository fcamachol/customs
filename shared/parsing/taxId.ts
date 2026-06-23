// Single source of truth for Mexican tax-ID (RFC / CURP) shape + check-digit validation.
//
// The manifest "ID" column is generic — it may carry an RFC (12–13 chars) or a CURP
// (18 chars). `classifyTaxId` decides which so the parser can route it to the right field.
// `isRfcChecksumValid` / `isCurpChecksumValid` verify the official dígito verificador
// (SAT for RFC, RENAPO for CURP). NOTE: the RFC *homonymy* code (the 2 chars before the
// check digit) is derived from the legal name and cannot be verified from the RFC alone —
// recomputing it is a documented follow-on; here we verify the name-independent check digit.

export const RFC_RE = /^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$/; // 12–13 chars
export const CURP_RE = /^[A-Z]{4}[0-9]{6}[HM][A-Z]{5}[A-Z0-9]{2}$/; // 18 chars

export const cleanId = (raw: string): string => (raw ?? '').toUpperCase().replace(/\s/g, '');

export type TaxIdKind = 'rfc' | 'curp' | 'unknown';

export function classifyTaxId(raw: string): TaxIdKind {
  const v = cleanId(raw);
  if (CURP_RE.test(v)) return 'curp';
  if (RFC_RE.test(v)) return 'rfc';
  return 'unknown';
}

// RFC value table: 0-9→0-9, A-N→10-23, &→24, O-Z→25-36, space→37, Ñ→38.
const RFC_DICT = '0123456789ABCDEFGHIJKLMN&OPQRSTUVWXYZ ';
const rfcValue = (c: string): number => (c === 'Ñ' ? 38 : RFC_DICT.indexOf(c));

export function isRfcChecksumValid(raw: string): boolean {
  const v = cleanId(raw);
  if (!RFC_RE.test(v)) return false;
  const check = v.slice(-1);
  const base = v.slice(0, -1).padStart(12, ' '); // morales (11) get a leading space
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += rfcValue(base[i]) * (13 - i);
  const d = 11 - (sum % 11);
  const expected = d === 11 ? '0' : d === 10 ? 'A' : String(d);
  return expected === check;
}

// CURP value table: 0-9→0-9, A-N→10-23, Ñ→24, O-Z→25-36.
const CURP_DICT = '0123456789ABCDEFGHIJKLMNÑOPQRSTUVWXYZ';

export function isCurpChecksumValid(raw: string): boolean {
  const v = cleanId(raw);
  if (!CURP_RE.test(v)) return false;
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += CURP_DICT.indexOf(v[i]) * (18 - i);
  const d = (10 - (sum % 10)) % 10;
  return String(d) === v[17];
}

export interface TaxIdValidation {
  kind: TaxIdKind;
  shapeValid: boolean;
  checksumValid: boolean;
}

export function validateTaxId(raw: string): TaxIdValidation {
  const kind = classifyTaxId(raw);
  const shapeValid = kind !== 'unknown';
  const checksumValid =
    kind === 'rfc' ? isRfcChecksumValid(raw) : kind === 'curp' ? isCurpChecksumValid(raw) : false;
  return { kind, shapeValid, checksumValid };
}

export function isValidTaxIdStrict(raw: string): boolean {
  const r = validateTaxId(raw);
  return r.shapeValid && r.checksumValid;
}
