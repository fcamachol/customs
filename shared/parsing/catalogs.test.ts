import { describe, expect, it } from 'vitest';
import { resolveCountry, resolveCurrency, weightFactorToKg } from './catalogs';

describe('resolveCountry', () => {
  it('passes through a known ISO code', () => expect(resolveCountry('CN')).toBe('CN'));
  it('maps a Spanish name', () => expect(resolveCountry('Porcelana')).toBe('CN'));
  it('maps México', () => expect(resolveCountry('México')).toBe('MX'));
  it('is accent/case-insensitive', () => expect(resolveCountry('mexico')).toBe('MX'));
  it('returns null for unknown', () => expect(resolveCountry('XX')).toBeNull());
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
