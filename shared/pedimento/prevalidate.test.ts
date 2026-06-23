import { describe, expect, it } from 'vitest';
import { isValidTaxId, prevalidatePedimento } from './prevalidate';
import { GENERIC_FRACTION_RE, GENERIC_T1_FRACTION, GENERIC_T1_FRACTION_LAYOUT } from './fraction';
import { isValidTaxIdStrict } from '../parsing/taxId';
import type { Pedimento } from '../types/pedimento';

describe('isValidTaxId', () => {
  it('accepts a 13-char RFC and an 18-char CURP (shape only)', () => {
    expect(isValidTaxId('TOMM020922D40')).toBe(true);          // 13
    expect(isValidTaxId('AERA790828HBSRBR04')).toBe(true);     // 18
    expect(isValidTaxId('SHORT')).toBe(false);
  });
});

describe('isValidTaxIdStrict', () => {
  it('also enforces the check digit', () => {
    expect(isValidTaxIdStrict('AERA790828HBSRBR04')).toBe(true);  // valid CURP
    expect(isValidTaxIdStrict('ADM130509UQ0')).toBe(true);        // valid RFC
    expect(isValidTaxIdStrict('PERJ800101AAA')).toBe(false);      // shape ok, checksum wrong
  });
});

function basePedimento(): Pedimento {
  return {
    header: {
      numeroPedimento: '258516535001684', clave: 'T1', regimen: 'IMD', destino: '9',
      tipoCambio: 20.45, pesoBrutoKg: 1, totalBultos: 1, valorDolares: 1, valorAduana: 1, precioPagado: 1,
      customsEntryCode: '4', customsClearanceCode: '850',
      transport: { entrada: '4', arribo: '4', salida: '7' },
      entryDate: '2025-04-04', paymentDate: '2025-04-05', identifiers: {}, observations: 'x',
      importer: { rfc: 'ADM130509UQ0', name: 'X', fiscalAddress: 'Y' },
      agent: { patente: '1653', name: 'A', agentRfc: 'GUMM710831UYA', agencyRfc: 'GLG1502247K9' },
      payment: {},
    },
    partidas: [{
      secuencia: 1, fraccion: '99010001', umc: '6', cantidadUmc: 1, paisVendedor: 'CHN', paisOrigenDestino: 'CHN',
      description: 'TRAJE', valorAduanaUsd: 120, contribuciones: [],
      observation: 'GUIA 1 VALOR 120.00 USD NOMBRE X RFC-CURP TOMM020922D40',
    }],
  };
}

describe('GENERIC_FRACTION_RE', () => {
  it('accepts the canonical generic fraction', () => {
    expect(GENERIC_FRACTION_RE.test(GENERIC_T1_FRACTION)).toBe(true);
  });
  it('accepts 9901 and 9902 variants with trailing digits', () => {
    expect(GENERIC_FRACTION_RE.test('99010001')).toBe(true);
    expect(GENERIC_FRACTION_RE.test('99010099')).toBe(true);
    expect(GENERIC_FRACTION_RE.test('99020001')).toBe(true);
    expect(GENERIC_FRACTION_RE.test('99020099')).toBe(true);
  });
  it('rejects non-9901/9902 fractions', () => {
    expect(GENERIC_FRACTION_RE.test('12345678')).toBe(false);
    expect(GENERIC_FRACTION_RE.test('8517000100')).toBe(false);
    expect(GENERIC_FRACTION_RE.test('99010001')).toBe(true);
  });
});

describe('layout fraction form', () => {
  it('maps 8-char pedimento form to 10-char layout form with same significant digits', () => {
    // GENERIC_T1_FRACTION = '99010001', GENERIC_T1_FRACTION_LAYOUT = '9901000100'
    expect(GENERIC_T1_FRACTION).toBe('99010001');
    expect(GENERIC_T1_FRACTION_LAYOUT).toBe('9901000100');
    expect(GENERIC_T1_FRACTION_LAYOUT.substring(0, 8)).toBe(GENERIC_T1_FRACTION);
  });
});

describe('prevalidatePedimento', () => {
  it('approves a well-formed pedimento', () => {
    expect(prevalidatePedimento(basePedimento()).status).toBe('APPROVED');
  });
  it('rejects a non-15-digit pedimento number', () => {
    const p = basePedimento(); p.header.numeroPedimento = '123';
    const r = prevalidatePedimento(p);
    expect(r.status).toBe('REJECTED');
    expect(r.errors.join(' ')).toMatch(/15/);
  });
  it('rejects a non-9901 fracción', () => {
    const p = basePedimento(); p.partidas[0].fraccion = '12345678';
    expect(prevalidatePedimento(p).status).toBe('REJECTED');
  });
  it('warns (does not reject) on a shape-valid importer RFC with a wrong check digit', () => {
    const p = basePedimento(); p.header.importer.rfc = 'PERJ800101AAA'; // shape ok, checksum wrong
    const r = prevalidatePedimento(p);
    expect(r.status).toBe('APPROVED');
    expect(r.errors.join(' ')).not.toMatch(/importador/i);
    expect(r.warnings.join(' ')).toMatch(/dígito verificador/i);
  });
  it('rejects a T1 partida carrying contributions', () => {
    const p = basePedimento();
    p.partidas[0].contribuciones = [{ concepto: 'IVA', tasa: 19, importe: 22 }];
    const r = prevalidatePedimento(p);
    expect(r.status).toBe('REJECTED');
    expect(r.errors.join(' ')).toMatch(/contribuci/i);
  });
});
