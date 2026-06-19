import { describe, it, expect } from 'vitest';
import { parseNumber, toKg } from './normalize';

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
