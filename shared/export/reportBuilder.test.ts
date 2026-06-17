import { describe, expect, it } from 'vitest';
import { buildReportRows } from './reportBuilder';

describe('buildReportRows', () => {
  it('merges shipment + risk + pedimento partida + client into one row', () => {
    const rows = buildReportRows({
      shipments: [{ guideId: 'g1', consignee: { name: 'Juan' }, customsValueUsd: 120 } as any],
      riskByGuide: { g1: { color: 'rojo', incidences: ['Piratería (Nike)'] } },
      client: { name: 'Cliente A', taxId: 'C1' },
    });
    expect(rows[0].Guia).toBe('g1');
    expect(rows[0].Resultado).toBe('rojo');
    expect(rows[0].Cliente).toBe('Cliente A');
  });
});
