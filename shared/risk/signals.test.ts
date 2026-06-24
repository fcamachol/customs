import { describe, expect, it } from 'vitest';
import { runSignals, type RiskContext, gradeSignals, type EntityContext } from './signals';
import type { Shipment } from '../types/shipment';
import { RULESET } from './ruleset';
import { scoreManifest } from './classify';

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

// ─── gradeSignals — graded, entity-aware signals (Task 5) ───────────────────

function gradeShip(over: Partial<Shipment> & { name: string; rfc?: string; curp?: string; address?: string }): Shipment {
  const { name, rfc, curp, address, ...rest } = over;
  return {
    id: 'x', mawbReference: 'M', description: 'camisa', hsCode: '6109',
    quantity: 1, unit: 'PCE', customsValueUsd: 100, currency: 'USD', originCountry: 'CN', guideId: 'g',
    consignee: { name, rfc: rfc ?? '', curp, address }, sender: { name: 'S' }, platform: { commercialName: 'P' },
    ...rest,
  } as Shipment;
}
const ctx = (over: Partial<EntityContext> = {}): EntityContext => ({
  thresholds: RULESET.thresholds, weights: RULESET.weights,
  addressDistinctConsignees: {}, monthlyNameCount: {}, ...over,
});

describe('gradeSignals', () => {
  it('a normal repeat buyer (same name+address, in-band) fires NOTHING', () => {
    const codes = gradeSignals(gradeShip({ name: 'Repeat', rfc: 'PERJ800101AA8', address: 'a' }), ctx());
    expect(codes).toEqual([]);
  });

  it('prohibited hit fires full weight and forces rojo', () => {
    const codes = gradeSignals(gradeShip({ name: 'A', rfc: 'PERJ800101AA8', description: 'pastilla' }), ctx());
    const p = codes.find((c) => c.signalId === 'prohibidos')!;
    expect(p.points).toBe(RULESET.weights.prohibidos);
    expect(p.forcesBand).toBe('rojo');
  });

  it('Ficha-124 bbdd fires only when monthly name count > 3, graded by excess', () => {
    // monthlyNameCount is keyed by norm(consignee.name) — NOT by entityKey — so that
    // it aligns with the name-keyed monthly_history loaded from the DB.
    // norm('A') === 'a'
    const none = gradeSignals(gradeShip({ name: 'A', rfc: 'PERJ800101AA8' }), ctx({ monthlyNameCount: { a: 3 } }));
    expect(none.find((c) => c.signalId === 'bbdd')).toBeUndefined();
    const fires = gradeSignals(gradeShip({ name: 'A', rfc: 'PERJ800101AA8' }), ctx({ monthlyNameCount: { a: 6 } }));
    expect(fires.find((c) => c.signalId === 'bbdd')!.points).toBeGreaterThan(0);
  });

  it('direcciones fires on many distinct entities at one address, not on a single repeat buyer', () => {
    const single = gradeSignals(gradeShip({ name: 'A', rfc: 'PERJ800101AA8', address: 'shared' }),
      ctx({ addressDistinctConsignees: { shared: 1 } }));
    expect(single.find((c) => c.signalId === 'direcciones')).toBeUndefined();
    const smurf = gradeSignals(gradeShip({ name: 'A', rfc: 'PERJ800101AA8', address: 'shared' }),
      ctx({ addressDistinctConsignees: { shared: 5 } }));
    expect(smurf.find((c) => c.signalId === 'direcciones')!.points).toBeGreaterThan(0);
  });

  // ─── F13: agregado — cross-row aggregate value by consignee ────────────────
  it('agregado fires when entityValueTotal for one RFC sums above $2,500', () => {
    // Two rows of $2,499 each for the same RFC → total $4,998 → fires
    const s = gradeShip({ name: 'A', rfc: 'PERJ800101AA8', customsValueUsd: 2499 });
    const ek = 'PERJ800101AA8'; // entityKey uses cleanId → uppercase
    const codes = gradeSignals(s, ctx({ entityValueTotal: { [ek]: 4998 } }));
    const ag = codes.find((c) => c.signalId === 'agregado');
    expect(ag).toBeDefined();
    expect(ag!.points).toBeGreaterThan(0);
    expect(ag!.evidence).toMatchObject({ entityTotal: 4998, cap: 2500 });
  });

  it('agregado does NOT fire when two distinct RFCs each sum to $2,499', () => {
    // RFC A total $2,499 — under cap — no fire
    const sA = gradeShip({ name: 'Ana', rfc: 'PERJ800101AA8', customsValueUsd: 2499 });
    const ekA = 'PERJ800101AA8';
    const codesA = gradeSignals(sA, ctx({ entityValueTotal: { [ekA]: 2499 } }));
    expect(codesA.find((c) => c.signalId === 'agregado')).toBeUndefined();

    // RFC B total $2,499 — also under cap — no fire
    const sB = gradeShip({ name: 'Bob', rfc: 'ADM130509UQ0', customsValueUsd: 2499 });
    const ekB = 'ADM130509UQ0';
    const codesB = gradeSignals(sB, ctx({ entityValueTotal: { [ekB]: 2499 } }));
    expect(codesB.find((c) => c.signalId === 'agregado')).toBeUndefined();
  });
});

// ─── F14: fuzzy entity resolution — in-manifest clustering ──────────────────
// These tests use scoreManifest to verify that typo variants cluster correctly.

function makeShip(i: number, name: string, rfc?: string): Shipment {
  return {
    id: String(i), mawbReference: 'M', description: 'camisa', hsCode: '6109',
    quantity: 1, unit: 'PCE', customsValueUsd: 100, currency: 'USD',
    originCountry: 'CN', guideId: `g${i}`,
    consignee: { name, rfc: rfc ?? '', address: 'Calle 1' },
    sender: { name: 'S' }, platform: { commercialName: 'P' },
  } as Shipment;
}

describe('F14: fuzzy entity resolution', () => {
  it('bbdd fires when typo variants push cluster monthly count > 3 (in-manifest)', () => {
    // 4 shipments for typo variants of the same name, no ID.
    // Without fuzzy: each name has count 1 → no bbdd fires.
    // With fuzzy clustering: all 4 collapse to canonical → count 4 > 3 → bbdd fires.
    const ships = [
      makeShip(1, 'Juan Perez'),
      makeShip(2, 'Juan Peres'),  // 1-char typo
      makeShip(3, 'Juan Perex'),  // 1-char typo
      makeShip(4, 'Juan Perey'),  // 1-char typo
    ];
    const scored = scoreManifest(ships, {});
    // At least some shipments should fire bbdd (cluster count ≥ 4 > threshold 3)
    const bbddCount = scored.filter((s) =>
      s.reasons.some((r) => r.signalId === 'bbdd')
    ).length;
    expect(bbddCount).toBeGreaterThan(0);
  });

  it('bbdd does NOT fire for genuinely distinct people (even with same first name)', () => {
    // 4 completely different people → no clustering → no bbdd
    const ships = [
      makeShip(1, 'Carlos Fernandez'),
      makeShip(2, 'Carlos Rodriguez'),
      makeShip(3, 'Carlos Martinez'),
      makeShip(4, 'Carlos Herrera'),
    ];
    const scored = scoreManifest(ships, {});
    // No bbdd should fire (each is a distinct entity)
    const bbddCount = scored.filter((s) =>
      s.reasons.some((r) => r.signalId === 'bbdd')
    ).length;
    expect(bbddCount).toBe(0);
  });

  it('smurfing (direcciones) counts ID-less typo variants at same address as one entity', () => {
    // 3 typo variants of same name (no RFC), same address → should be 1 distinct entity
    // → smurfing should NOT fire (only 1 distinct consignee at address, not 3).
    // Without fuzzy: 3 distinct name-keys → count=3 ≥ threshold=3 → smurfing fires.
    // With fuzzy: all 3 collapse to 1 canonical → count=1 → smurfing does NOT fire.
    const ships = [
      makeShip(1, 'Ana Lopez'),
      makeShip(2, 'Ana Lopex'),  // 1-char typo of Ana Lopez
      makeShip(3, 'Ana Lopaz'),  // 1-char typo of Ana Lopez
    ];
    const scored = scoreManifest(ships, {});
    // All three share 'Calle 1'. With fuzzy, they are 1 entity → direcciones should NOT fire.
    const smurfCount = scored.filter((s) =>
      s.reasons.some((r) => r.signalId === 'direcciones')
    ).length;
    expect(smurfCount).toBe(0);
  });

  it('RFC/CURP distinct holders are NEVER merged by fuzzy clustering', () => {
    // Two people with valid RFCs but similar names: must stay distinct
    const ships = [
      makeShip(1, 'Juan Perez', 'PERJ800101AA8'),
      makeShip(2, 'Juan Peres', 'ADM130509UQ0'),  // different RFC
      makeShip(3, 'Juan Perex', 'PERJ800101AA8'),  // same RFC as ship 1
      makeShip(4, 'Juan Perey', 'ADM130509UQ0'),   // same RFC as ship 2
    ];
    const scored = scoreManifest(ships, {});
    // Ships 1 & 3 share an RFC → entityKey = RFC → counted together (2 shipments)
    // Ships 2 & 4 share a different RFC → entityKey = RFC → counted together (2 shipments)
    // Neither group has count > 3, so no bbdd should fire
    const bbddCount = scored.filter((s) =>
      s.reasons.some((r) => r.signalId === 'bbdd')
    ).length;
    expect(bbddCount).toBe(0);
  });
});
