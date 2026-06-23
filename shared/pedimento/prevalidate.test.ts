import { describe, expect, it } from 'vitest';
import { isValidTaxId, prevalidatePedimento } from './prevalidate';
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
      description: 'TRAJE', valorAduanaUsd: 120, contribuciones: [{ concepto: 'IVA', tasa: 19, importe: 22 }],
      observation: 'GUIA 1 VALOR 120.00 USD NOMBRE X RFC-CURP TOMM020922D40',
    }],
  };
}

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
});
