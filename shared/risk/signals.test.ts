import { describe, expect, it } from 'vitest';
import { runSignals, type RiskContext } from './signals';
import type { Shipment } from '../types/shipment';

function ship(over: Partial<Shipment> = {}): Shipment {
  return {
    id: 'a', mawbReference: 'M', description: 'camisa', hsCode: '9901000100',
    quantity: 1, unit: 'PCE', customsValueUsd: 100, currency: 'USD',
    originCountry: 'CN', guideId: 'g1',
    consignee: { name: 'Juan Perez', rfc: 'PERJ800101AAA', address: 'Calle 1' },
    sender: { name: 'S' }, platform: { commercialName: 'P' },
    ...over,
  } as Shipment;
}

const emptyCtx: RiskContext = { nameCounts: {}, addressCounts: {}, monthlyHistoryNames: new Set() };

describe('runSignals', () => {
  it('flags missing/invalid ID length (not 13 or 18)', () => {
    const r = runSignals(ship({ consignee: { name: 'x', rfc: 'SHORT' } }), emptyCtx);
    expect(r.find((f) => f.id === 'id')?.flagged).toBe(true);
  });
  it('accepts an 18-char CURP', () => {
    const r = runSignals(ship({ consignee: { name: 'x', rfc: 'AERA790828HBSRBR04' } }), emptyCtx);
    expect(r.find((f) => f.id === 'id')?.flagged).toBe(false);
  });
  it('flags quantity > 10', () => {
    expect(runSignals(ship({ quantity: 11 }), emptyCtx).find((f) => f.id === 'cantidad')?.flagged).toBe(true);
  });
  it('flags value < $1 and > $2500', () => {
    expect(runSignals(ship({ customsValueUsd: 0.5 }), emptyCtx).find((f) => f.id === 'monto')?.flagged).toBe(true);
    expect(runSignals(ship({ customsValueUsd: 3000 }), emptyCtx).find((f) => f.id === 'monto')?.flagged).toBe(true);
    expect(runSignals(ship({ customsValueUsd: 100 }), emptyCtx).find((f) => f.id === 'monto')?.flagged).toBe(false);
  });
  it('flags duplicate consignee name and duplicate address from context', () => {
    const ctx: RiskContext = { nameCounts: { 'juan perez': 3 }, addressCounts: { 'calle 1': 2 }, monthlyHistoryNames: new Set() };
    const r = runSignals(ship(), ctx);
    expect(r.find((f) => f.id === 'consignatarios')?.flagged).toBe(true);
    expect(r.find((f) => f.id === 'direcciones')?.flagged).toBe(true);
  });
  it('flags prohibited goods and piracy', () => {
    const r = runSignals(ship({ description: 'maquillaje marca Gucci' }), emptyCtx);
    expect(r.find((f) => f.id === 'prohibidos')?.flagged).toBe(true);
    expect(r.find((f) => f.id === 'pirateria')?.flagged).toBe(true);
  });
  it('flags repeat importer found in monthly history', () => {
    const ctx: RiskContext = { nameCounts: {}, addressCounts: {}, monthlyHistoryNames: new Set(['juan perez']) };
    expect(runSignals(ship(), ctx).find((f) => f.id === 'bbdd')?.flagged).toBe(true);
  });
});
