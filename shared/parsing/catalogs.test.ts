import { describe, expect, it } from 'vitest';
import {
  resolveCountry,
  resolveCurrency,
  weightFactorToKg,
  ANAM_COUNTRY_OPTIONS,
  countryDisplayName,
} from './catalogs';

describe('resolveCountry', () => {
  it('passes through a known ISO code', () => expect(resolveCountry('CN')).toBe('CN'));
  it('maps a Spanish name', () => expect(resolveCountry('Porcelana')).toBe('CN'));
  it('maps México', () => expect(resolveCountry('México')).toBe('MX'));
  it('is accent/case-insensitive', () => expect(resolveCountry('mexico')).toBe('MX'));
  it('maps an English alias', () => expect(resolveCountry('Germany')).toBe('DE'));
  it('maps a multiword name', () => expect(resolveCountry('Estados Unidos')).toBe('US'));
  it('returns null for unknown', () => expect(resolveCountry('XX')).toBeNull());
});

describe('ANAM país catalog', () => {
  it('exposes a non-empty option list', () => expect(ANAM_COUNTRY_OPTIONS.length).toBeGreaterThan(200));
  it('uses clave as value and labels with the clave', () => {
    const cn = ANAM_COUNTRY_OPTIONS.find((o) => o.value === 'CN');
    expect(cn).toEqual({ value: 'CN', label: 'China (CN)' });
  });
  it('has unique claves', () => {
    const codes = ANAM_COUNTRY_OPTIONS.map((o) => o.value);
    expect(new Set(codes).size).toBe(codes.length);
  });
  it('is sorted by Spanish name', () => {
    const labels = ANAM_COUNTRY_OPTIONS.map((o) => o.label);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b, 'es')));
  });
});

describe('countryDisplayName', () => {
  it('maps a clave to the Spanish name', () => expect(countryDisplayName('CN')).toBe('China'));
  it('is case-insensitive on the clave', () => expect(countryDisplayName('mx')).toBe('México'));
  it('falls back to the raw value when unknown', () => expect(countryDisplayName('FOO')).toBe('FOO'));
  it('returns empty string for empty input', () => expect(countryDisplayName('')).toBe(''));
});

describe('resolveCurrency', () => {
  it('passes through a known code', () => expect(resolveCurrency('USD')).toBe('USD'));
  it('maps the Spanish name', () => expect(resolveCurrency('Dólar estadounidense')).toBe('USD'));
  it('returns null for unknown', () => expect(resolveCurrency('Quatloos')).toBeNull());
});

describe('weightFactorToKg', () => {
  it('grams', () => expect(weightFactorToKg('gramo')).toBe(0.001));
  it('kg', () => expect(weightFactorToKg('kg')).toBe(1));
  it('lb', () => expect(weightFactorToKg('lb')).toBeCloseTo(0.453592));
  it('oz', () => expect(weightFactorToKg('oz')).toBeCloseTo(0.0283495));
  it('returns null for unknown', () => expect(weightFactorToKg('cubits')).toBeNull());
});
