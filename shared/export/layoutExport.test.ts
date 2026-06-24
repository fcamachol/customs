import { describe, expect, it } from 'vitest';
import { toLayoutRows, LAYOUT_HEADERS } from './layoutExport';
import type { Shipment } from '../types/shipment';

const s: Shipment = {
  id: '1', mawbReference: '369', description: 'TRAJE', hsCode: '99010001', quantity: 1, unit: '6',
  customsValueUsd: 120, currency: 'USD', originCountry: 'CN', guideId: 'g1', arrivalDate: '2025-04-04',
  customsEntryCode: '4', customsClearanceCode: '850',
  consignee: { name: 'Juan', rfc: 'TOMM020922D40', curp: 'AERA790828HBSRBR04', address: 'Calle 1', phone: '55', email: 'a@b.com' },
  sender: { name: 'SHEIN HK', taxId: 'HK1', address: 'HK', phone: '852', email: 's@x.com' },
  platform: { commercialName: 'SHEIN', countryOfOrigin: 'CN', legalName: 'Shein Ltd', email: 'p@x.com', url: 'https://shein.com' },
} as Shipment;

describe('layoutExport', () => {
  it('emits all 35 headers', () => {
    expect(LAYOUT_HEADERS).toHaveLength(35);
  });
  it('maps a shipment into a 35-field row in order', () => {
    const row = toLayoutRows([s])[0];
    expect(row[LAYOUT_HEADERS[3]]).toBe('TRAJE');            // col 4 descripción
    expect(row[LAYOUT_HEADERS[17]]).toBe('TOMM020922D40');   // col 18 RFC
    expect(row[LAYOUT_HEADERS[25]]).toBe('SHEIN HK');        // col 26 remitente nombre
    expect(row[LAYOUT_HEADERS[30]]).toBe('SHEIN');           // col 31 plataforma nombre comercial
    expect(row[LAYOUT_HEADERS[34]]).toBe('https://shein.com'); // col 35 plataforma URL
  });
  it('injects generic fraction, PCS unit, and N/A RRNA', () => {
    const rows = toLayoutRows([{ ...s, hsCode: '6109100022', unit: 'gramo' }]);
    expect(rows[0]['Fracción arancelaria']).toBe('9901000100');
    expect(rows[0]['Unidad de medida']).toBe('PCS');
    expect(rows[0]['Regulaciones y restricciones no arancelarias']).toBe('N/A');
  });
});
