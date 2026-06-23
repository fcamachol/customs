import { describe, expect, it } from 'vitest';
import {
  classifyTaxId,
  isCurpChecksumValid,
  isRfcChecksumValid,
  isValidTaxIdStrict,
  validateTaxId,
} from './taxId';

describe('classifyTaxId', () => {
  it('classifies an 18-char CURP as curp', () => {
    expect(classifyTaxId('AERA790828HBSRBR04')).toBe('curp');
  });
  it('classifies a 13/12-char RFC as rfc', () => {
    expect(classifyTaxId('PERJ800101AA8')).toBe('rfc'); // persona física
    expect(classifyTaxId('ADM130509UQ0')).toBe('rfc'); // persona moral
  });
  it('classifies junk as unknown', () => {
    expect(classifyTaxId('SHORT')).toBe('unknown');
    expect(classifyTaxId('')).toBe('unknown');
  });
  it('ignores case and whitespace', () => {
    expect(classifyTaxId(' aera790828hbsrbr04 ')).toBe('curp');
  });
});

describe('isCurpChecksumValid', () => {
  it('accepts a CURP with a correct verification digit', () => {
    expect(isCurpChecksumValid('AERA790828HBSRBR04')).toBe(true);
  });
  it('rejects a CURP with a wrong verification digit (audit bypass #6)', () => {
    expect(isCurpChecksumValid('AERA790828HBSRBR99')).toBe(false);
  });
  it('rejects a non-CURP shape', () => {
    expect(isCurpChecksumValid('PERJ800101AA8')).toBe(false);
  });
});

describe('isRfcChecksumValid', () => {
  it('accepts RFCs with a correct check digit', () => {
    expect(isRfcChecksumValid('PERJ800101AA8')).toBe(true); // persona física
    expect(isRfcChecksumValid('ADM130509UQ0')).toBe(true); // persona moral
    expect(isRfcChecksumValid('GUMM710831UYA')).toBe(true);
  });
  it('rejects an RFC with a wrong check digit (audit bypass #5)', () => {
    expect(isRfcChecksumValid('PERJ800101AAA')).toBe(false); // shape ok, checksum wrong
    expect(isRfcChecksumValid('XXXX010101AAA')).toBe(false);
  });
});

describe('validateTaxId / isValidTaxIdStrict', () => {
  it('reports kind, shape and checksum validity together', () => {
    expect(validateTaxId('AERA790828HBSRBR04')).toEqual({ kind: 'curp', shapeValid: true, checksumValid: true });
    expect(validateTaxId('PERJ800101AAA')).toEqual({ kind: 'rfc', shapeValid: true, checksumValid: false });
    expect(validateTaxId('SHORT')).toEqual({ kind: 'unknown', shapeValid: false, checksumValid: false });
  });
  it('strict validation requires both shape and checksum', () => {
    expect(isValidTaxIdStrict('AERA790828HBSRBR04')).toBe(true);
    expect(isValidTaxIdStrict('PERJ800101AA8')).toBe(true);
    expect(isValidTaxIdStrict('PERJ800101AAA')).toBe(false);
  });
});
