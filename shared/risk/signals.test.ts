import { describe, expect, it } from 'vitest';
import { runSignals, type RiskContext } from './signals';
import type { Shipment } from '../types/shipment';

function ship(over: Partial<Shipment> = {}): Shipment {
  return {
    id: 'a', mawbReference: 'M', description: 'camisa', hsCode: '9901000100',
    quantity: 1, unit: 'PCE', customsValueUsd: 100, currency: 'USD',
    originCountry: 'CN', guideId: 'g1',
    consignee: { name: 'Juan Perez', rfc: 'PERJ800101AA8', address: 'Calle 1' },
    sender: { name: 'S' }, platform: { commercialName: 'P' },
    ...over,
  } as Shipment;
}

const emptyCtx: RiskContext = { nameCounts: {}, addressCounts: {}, monthlyHistoryCounts: {} };

describe('runSignals', () => {
  it('flags missing/invalid ID length (not 13 or 18)', () => {
    const r = runSignals(ship({ consignee: { name: 'x', rfc: 'SHORT' } }), emptyCtx);
    expect(r.find((f) => f.id === 'id')?.flagged).toBe(true);
  });
  it('accepts an 18-char CURP', () => {
    const r = runSignals(ship({ consignee: { name: 'x', rfc: 'AERA790828HBSRBR04' } }), emptyCtx);
    expect(r.find((f) => f.id === 'id')?.flagged).toBe(false);
  });
  it('flags a shape-valid RFC with a wrong check digit (checksum validation)', () => {
    const r = runSignals(ship({ consignee: { name: 'x', rfc: 'PERJ800101AAA' } }), emptyCtx);
    const idSig = r.find((f) => f.id === 'id');
    expect(idSig?.flagged).toBe(true);
    expect(idSig?.incidence).toBe('RFC/CURP inválido');
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
    const ctx: RiskContext = { nameCounts: { 'juan perez': 3 }, addressCounts: { 'calle 1': 2 }, monthlyHistoryCounts: {} };
    const r = runSignals(ship(), ctx);
    expect(r.find((f) => f.id === 'consignatarios')?.flagged).toBe(true);
    expect(r.find((f) => f.id === 'direcciones')?.flagged).toBe(true);
  });
  it('flags prohibited goods and piracy', () => {
    const r = runSignals(ship({ description: 'maquillaje marca Gucci' }), emptyCtx);
    expect(r.find((f) => f.id === 'prohibidos')?.flagged).toBe(true);
    expect(r.find((f) => f.id === 'pirateria')?.flagged).toBe(true);
  });
  it('flags bbdd when monthly operations exceed 3 (Ficha 124: history + current > 3)', () => {
    // 3 prior ops in other manifests + 1 current = 4 total → >3 → fires
    const ctx: RiskContext = { nameCounts: { 'juan perez': 1 }, addressCounts: {}, monthlyHistoryCounts: { 'juan perez': 3 } };
    expect(runSignals(ship(), ctx).find((f) => f.id === 'bbdd')?.flagged).toBe(true);
  });
  it('does NOT flag bbdd at 3 or fewer monthly operations', () => {
    // 2 prior + 1 current = 3 total → not >3 → no longer fires on the first repeat
    const ctx: RiskContext = { nameCounts: { 'juan perez': 1 }, addressCounts: {}, monthlyHistoryCounts: { 'juan perez': 2 } };
    expect(runSignals(ship(), ctx).find((f) => f.id === 'bbdd')?.flagged).toBe(false);
  });
});
