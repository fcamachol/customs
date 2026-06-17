import { describe, expect, it } from 'vitest';
import { parseManifestRows } from './manifestParser';

const rows = [
  {
    'RFC': 'TOMM020922D40',
    'Nombre denominación o razón social': 'Juan Pérez',
    'Domicilio': 'Calle 1\nDepto 2',
    'Descripción de la mercancía': 'TRAJE',
    'Cantidad de la mercancía': '1',
    'Valor en Aduana declarado': '120.5',
    'Moneda': 'USD',
    'País de procedencia': 'cn',
    'No. de guía aérea o documento de transporte': '369-94268462',
    'Remitente Nombre': 'SHEIN HK',
    'Nombre comercial': 'SHEIN',
  },
];

describe('parseManifestRows', () => {
  it('maps known columns into a Shipment and uppercases country', () => {
    const out = parseManifestRows(rows, 'MAWB-1');
    expect(out.shipments[0].consignee.rfc).toBe('TOMM020922D40');
    expect(out.shipments[0].consignee.address).toBe('Calle 1 Depto 2');
    expect(out.shipments[0].originCountry).toBe('CN');
    expect(out.shipments[0].sender.name).toBe('SHEIN HK');
    expect(out.shipments[0].platform.commercialName).toBe('SHEIN');
  });
  it('reports unmapped headers instead of dropping silently', () => {
    const out = parseManifestRows([{ 'Columna Rara': 'x', 'RFC': 'AAA010101AAA' }], 'M');
    expect(out.unmappedHeaders).toContain('Columna Rara');
  });
});
