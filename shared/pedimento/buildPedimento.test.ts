import { describe, expect, it } from 'vitest';
import { buildPedimento } from './buildPedimento';
import { prevalidatePedimento } from './prevalidate';
import type { Shipment } from '../types/shipment';

function ship(over: Partial<Shipment>): Shipment {
  return {
    id: '1', mawbReference: '369-94268462', description: 'TRAJE', hsCode: '99010001',
    quantity: 1, unit: '6', customsValueUsd: 120.5, currency: 'USD', originCountry: 'CHN', guideId: '369-94268462',
    consignee: { name: 'Juan Perez', rfc: 'TOMM020922D40', address: 'Calle 1' },
    sender: { name: 'SHEIN HK' }, platform: { commercialName: 'SHEIN', countryOfOrigin: 'CHN' }, ...over,
  } as Shipment;
}

describe('buildPedimento', () => {
  it('aggregates header totals and builds partidas with correct observation', () => {
    const ped = buildPedimento([ship({ customsValueUsd: 100 }), ship({ id: '2', customsValueUsd: 50 })], {
      numeroPedimento: '258516535001684',
      importer: { rfc: 'ADM130509UQ0', name: 'ADMERCE SA DE CV', fiscalAddress: 'CDMX' },
      agent: { patente: '1653', name: 'GUZMOR', agentRfc: 'GUMM710831UYA', agencyRfc: 'GLG1502247K9' },
      tipoCambio: 20.45, customsEntryCode: '4', customsClearanceCode: '850',
      entryDate: '2025-04-04', paymentDate: '2025-04-05',
    });
    expect(ped.partidas).toHaveLength(2);
    expect(ped.header.valorDolares).toBeCloseTo(150);
    expect(ped.header.totalBultos).toBe(2);
    expect(ped.partidas[0].observation).toMatch(/^GUIA .+ VALOR 100.00 USD NOMBRE JUAN PEREZ RFC-CURP TOMM020922D40$/);
    expect(ped.partidas[0].paisVendedor).toBe('CHN');
    expect(ped.partidas[0].contribuciones).toEqual([]);
  });

  it('regression: forces generic fraction even when real hsCode is provided', () => {
    const ped = buildPedimento([ship({ hsCode: '8517.13.0001', customsValueUsd: 150 })], {
      numeroPedimento: '258516535001684',
      importer: { rfc: 'ADM130509UQ0', name: 'ADMERCE SA DE CV', fiscalAddress: 'CDMX' },
      agent: { patente: '1653', name: 'GUZMOR', agentRfc: 'GUMM710831UYA', agencyRfc: 'GLG1502247K9' },
      tipoCambio: 20.45, customsEntryCode: '4', customsClearanceCode: '850',
      entryDate: '2025-04-04', paymentDate: '2025-04-05',
    });
    expect(ped.partidas[0].fraccion).toBe('99010001');
    expect(prevalidatePedimento(ped).status).toBe('APPROVED');
  });
});
