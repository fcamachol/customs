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
  it('normalizes comma decimal value from a real-shaped row', () => {
    const { shipments } = parseManifestRows(
      [{ 'Valor total declarado': '0,79', 'Número de productos': '3', 'Peso': '500', 'Unidad de peso': 'gramo', 'Destinatario (CNNE)': 'Juan' }],
      '369-1');
    expect(shipments[0].customsValueUsd).toBe(0.79);
    expect(shipments[0].quantity).toBe(3);
    expect(shipments[0].weightKg).toBe(0.5);
    expect(shipments[0].consignee.name).toBe('Juan');
  });
});
