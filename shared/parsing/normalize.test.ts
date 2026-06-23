import { describe, it, expect } from 'vitest';
import { parseNumber, toKg, convertWeight, parseManifestDate, parseNumberStrict } from './normalize';

describe('parseNumber', () => {
  it('parses comma decimals', () => { expect(parseNumber('0,79')).toBe(0.79); });
  it('parses dot decimals', () => { expect(parseNumber('8.95')).toBe(8.95); });
  it('strips thousands separators', () => { expect(parseNumber('1.234,50')).toBe(1234.5); });
  it('handles blank', () => { expect(parseNumber('')).toBe(0); });
});
describe('toKg', () => {
  it('converts grams to kg', () => { expect(toKg(500, 'gramo')).toBe(0.5); });
  it('keeps kg', () => { expect(toKg(2, 'KG')).toBe(2); });
});

describe('parseNumberStrict', () => {
  it('parses a plain number', () => expect(parseNumberStrict('120.5')).toEqual({ ok: true, value: 120.5 }));
  it('parses a comma decimal', () => expect(parseNumberStrict('0,79')).toEqual({ ok: true, value: 0.79 }));
  it('rejects non-numeric', () => expect(parseNumberStrict('N/A')).toEqual({ ok: false, code: 'not_a_number' }));
  it('rejects empty', () => expect(parseNumberStrict('')).toEqual({ ok: false, code: 'not_a_number' }));
  it('flags ambiguous thousands/decimal "1,000"', () =>
    expect(parseNumberStrict('1,000')).toEqual({ ok: false, code: 'ambiguous_locale' }));
  it('accepts unambiguous grouped "1,234.50"', () =>
    expect(parseNumberStrict('1,234.50')).toEqual({ ok: true, value: 1234.5 }));
});

describe('convertWeight', () => {
  it('grams to kg', () => expect(convertWeight(245, 'gramo')).toEqual({ ok: true, kg: 0.245 }));
  it('lb to kg', () => { const r = convertWeight(1, 'lb'); expect(r.ok && Math.abs(r.kg - 0.453592) < 1e-6).toBe(true); });
  it('fails unknown unit', () => expect(convertWeight(1, 'cubits')).toEqual({ ok: false }));
});

describe('parseManifestDate', () => {
  it('parses an Excel serial number', () => expect(parseManifestDate(45000)).toEqual({ ok: true, iso: '2023-03-15' }));
  it('parses an ISO string', () => expect(parseManifestDate('2024-01-31')).toEqual({ ok: true, iso: '2024-01-31' }));
  it('parses dd/mm/yyyy', () => expect(parseManifestDate('31/01/2024')).toEqual({ ok: true, iso: '2024-01-31' }));
  it('fails on garbage', () => expect(parseManifestDate('not a date')).toEqual({ ok: false }));
});
