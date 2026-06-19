import { describe, expect, it } from 'vitest';
import { buildReportRows } from './reportBuilder';
import { LAYOUT_HEADERS } from './layoutExport';

const baseShipment: any = {
  id: 's1',
  mawbReference: '369-1',
  guideId: 'g1',
  description: 'TRAJE',
  hsCode: '99010001',
  quantity: 1,
  unit: '6',
  customsValueUsd: 120,
  currency: 'USD',
  originCountry: 'CN',
  consignee: { name: 'Juan', rfc: 'TOMM020922D40' },
  sender: { name: '' },
  platform: { commercialName: '' },
};

describe('buildReportRows', () => {
  it('merges shipment + risk + pedimento partida + client into one row (legacy shape)', () => {
    const rows = buildReportRows({
      shipments: [{ ...baseShipment }],
      riskByGuide: { g1: { color: 'rojo', incidences: ['Piratería (Nike)'] } },
    });
    expect(rows[0].Resultado).toBe('rojo');
    expect(rows[0].Motivo).toBe('Piratería (Nike)');
  });

  it('output row contains all 34 LAYOUT_HEADERS plus Resultado and Motivo (36 cols total)', () => {
    const rows = buildReportRows({
      shipments: [{ ...baseShipment }],
      riskByGuide: { g1: { color: 'verde', incidences: [] } },
    });
    for (const h of LAYOUT_HEADERS) {
      expect(rows[0]).toHaveProperty(h);
    }
    expect(rows[0]).toHaveProperty('Resultado');
    expect(rows[0]).toHaveProperty('Motivo');
    expect(Object.keys(rows[0])).toHaveLength(LAYOUT_HEADERS.length + 2); // 34 + Resultado + Motivo
  });

  it('overlays importData fields into the correct columns', () => {
    const rows = buildReportRows({
      shipments: [{ ...baseShipment }],
      riskByGuide: {},
      importData: {
        patente: 'AA3456',
        tasaImportacion: '0%',
        claveAduanaEntrada: 'ADN',
        claveAduanaDespacho: 'LAX',
        cveT1: 'T1-2024-001',
      },
    });
    expect(rows[0]['Patente AA']).toBe('AA3456');
    expect(rows[0]['Tasa global o cuota aplicada']).toBe('0%');
    expect(rows[0]['Clave de Aduana de entrada']).toBe('ADN');
    expect(rows[0]['Clave de Aduana de despacho']).toBe('LAX');
    expect(rows[0]['No. de registro T1']).toBe('T1-2024-001');
    expect(rows[0]['No. pedimento']).toBe('T1-2024-001');
  });

  it('overlays client remitente and platform fields', () => {
    const rows = buildReportRows({
      shipments: [{ ...baseShipment }],
      riskByGuide: {},
      client: {
        name: 'Remitente SA',
        tax_id: 'RFC123',
        address: 'Calle 1',
        phone: '5551234',
        email: 'r@r.com',
        platform: {
          commercialName: 'MiPlataforma',
          countryOfOrigin: 'MX',
          legalName: 'Plataforma SA de CV',
          email: 'plat@plat.com',
        },
      },
    });
    expect(rows[0]['Remitente Nombre/razón social']).toBe('Remitente SA');
    expect(rows[0]['Remitente Id fiscal']).toBe('RFC123');
    expect(rows[0]['Remitente Domicilio']).toBe('Calle 1');
    expect(rows[0]['Remitente Teléfono']).toBe('5551234');
    expect(rows[0]['Remitente Correo']).toBe('r@r.com');
    expect(rows[0]['Plataforma Nombre comercial']).toBe('MiPlataforma');
    expect(rows[0]['Plataforma País de origen']).toBe('MX');
    expect(rows[0]['Plataforma Razón social']).toBe('Plataforma SA de CV');
    expect(rows[0]['Plataforma Correo']).toBe('plat@plat.com');
  });
});
