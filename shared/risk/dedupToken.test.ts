/**
 * F20b: Dedup-token injection tests.
 *
 * Validates that:
 *  1. The default-identity path (no nameTokenFn) behaves exactly as before.
 *  2. Injecting a nameTokenFn that is BEHAVIOR-IDENTICAL to identity (i.e. returns the
 *     same normalized value) produces the same band/score on any fixture.
 *  3. Injecting a nameTokenFn that stubs HMAC-style tokenization (e.g. uppercases)
 *     still preserves dedup COLLISION STRUCTURE — two shipments whose consignee
 *     names normalize to the same value still trigger bbdd together (because
 *     tokenFn(norm(a)) === tokenFn(norm(b)) when norm(a) === norm(b)).
 *  4. EntityContext exposes a nameToken helper and ScoreOptions accepts nameTokenFn.
 */

import { describe, expect, it } from 'vitest';
import { scoreManifest } from './classify';
import { gradeSignals, entityKey, norm } from './signals';
import type { EntityContext } from './signals';
import type { Shipment } from '../types/shipment';
import { RULESET } from './ruleset';

// ─── helpers ────────────────────────────────────────────────────────────────

function ship(over: Partial<Shipment> & { name: string; rfc?: string }): Shipment {
  const { name, rfc, ...rest } = over;
  return {
    id: 'x', mawbReference: 'M', description: 'camisa', hsCode: '6109',
    quantity: 1, unit: 'PCE', customsValueUsd: 100, currency: 'USD', originCountry: 'CN', guideId: 'g',
    consignee: { name, rfc: rfc ?? 'PERJ800101AA8', address: 'a' },
    sender: { name: 'S' }, platform: { commercialName: 'P' }, ...rest,
  } as Shipment;
}

const baseCtx = (over: Partial<EntityContext> = {}): EntityContext => ({
  thresholds: RULESET.thresholds,
  weights: RULESET.weights,
  addressDistinctConsignees: {},
  monthlyNameCount: {},
  ...over,
});

/** Stub tokenizer: uppercases the normalized value (collision-preserving but not identity). */
const upperTokenFn = (n: string): string => n.toUpperCase();

// ─── 1. ScoreOptions accepts nameTokenFn without error ──────────────────────

describe('F20b: nameTokenFn injection', () => {
  it('scoreManifest accepts nameTokenFn in options without error', () => {
    const s = ship({ name: 'Ana' });
    expect(() => scoreManifest([s], {}, { nameTokenFn: (n) => n })).not.toThrow();
  });

  it('identity nameTokenFn produces identical result to omitting it', () => {
    const s = ship({ name: 'Ana' });
    const withoutFn = scoreManifest([s], {})[0];
    const withIdentityFn = scoreManifest([s], {}, { nameTokenFn: (n) => n })[0];
    expect(withIdentityFn.band).toBe(withoutFn.band);
    expect(withIdentityFn.score).toBe(withoutFn.score);
    expect(withIdentityFn.reasons.map((r) => r.signalId)).toEqual(withoutFn.reasons.map((r) => r.signalId));
  });

  // ─── 2. Default-identity back-compat: no regression on bbdd dedup ─────────

  it('default (no nameTokenFn): bbdd fires when 4+ ops for same normalized name', () => {
    // 3 prior ops + 1 current = 4 → > 3 threshold → fires
    const s = ship({ name: 'Juan Pérez' }); // norm → 'juan perez'
    const history = { 'juan perez': 3 };
    const out = scoreManifest([s], history);
    const bbdd = out[0].reasons.find((r) => r.signalId === 'bbdd');
    expect(bbdd).toBeDefined();
    expect(bbdd!.points).toBeGreaterThan(0);
  });

  it('default (no nameTokenFn): bbdd does NOT fire at exactly 3 ops total', () => {
    const s = ship({ name: 'Juan Pérez' }); // norm → 'juan perez'
    const history = { 'juan perez': 2 }; // 2 prior + 1 current = 3 → not >3
    const out = scoreManifest([s], history);
    expect(out[0].reasons.find((r) => r.signalId === 'bbdd')).toBeUndefined();
  });

  // ─── 3. Token injection preserves collision structure ────────────────────

  it('uppercase stub tokenFn: two accent variants of same name still collide in bbdd', () => {
    // norm('Juan Pérez') === norm('juan perez') === 'juan perez'
    // upperTokenFn('juan perez') === 'JUAN PEREZ' for both → same key → collision preserved
    const s1 = ship({ name: 'Juan Pérez' });
    const s2 = ship({ name: 'JUAN PEREZ' });
    // Confirm both normalize to the same base before tokenization
    expect(norm('Juan Pérez')).toBe(norm('JUAN PEREZ'));

    // Build manifest with 4 instances of the name (enough to fire bbdd)
    const manifest = [s1, s1, s1, s2]; // 4 shipments, same normalized name
    const out = scoreManifest(manifest, {}, { nameTokenFn: upperTokenFn });
    // All 4 entries share the same token → monthly count = 4 > 3 → bbdd fires
    expect(out.every((r) => r.reasons.some((rc) => rc.signalId === 'bbdd'))).toBe(true);
  });

  it('uppercase stub tokenFn: two genuinely DIFFERENT names do NOT collide in bbdd', () => {
    const manifest = [
      ship({ name: 'Ana Lopez' }),
      ship({ name: 'Bob Garcia' }),
    ];
    // Different norms → different tokens → no cross-collision
    const out = scoreManifest(manifest, {}, { nameTokenFn: upperTokenFn });
    // Neither should fire bbdd (only 1 count each < 3 threshold)
    expect(out.every((r) => !r.reasons.find((rc) => rc.signalId === 'bbdd'))).toBe(true);
  });

  // ─── 4. Parity: injecting tokenFn vs identity yields SAME band on fixture ─

  it('stub tokenFn yields same band as identity when history keys are re-tokenized consistently', () => {
    // If we apply the same transform to both the history keys AND the current names,
    // the collision structure is preserved → same band result.
    const manifest = [ship({ name: 'Ana' })];
    // history keyed by identity norm
    const historyIdentity = { ana: 3 };
    // history keyed by token (upper)
    const historyTokenized = { ANA: 3 };

    const withIdentity = scoreManifest(manifest, historyIdentity, { nameTokenFn: (n) => n })[0];
    const withToken = scoreManifest(manifest, historyTokenized, { nameTokenFn: upperTokenFn })[0];
    // Both have 3 prior + 1 current = 4 → bbdd fires → same band
    expect(withToken.band).toBe(withIdentity.band);
    expect(withToken.reasons.some((r) => r.signalId === 'bbdd')).toBe(true);
    expect(withIdentity.reasons.some((r) => r.signalId === 'bbdd')).toBe(true);
  });

  // ─── 5. EntityContext exposes nameToken (used by gradeSignals) ────────────

  it('gradeSignals uses ctx.nameToken when bbdd lookup is done', () => {
    // With a stub tokenizer that prepends 'tok:', the lookup key is 'tok:ana'
    const tokenFn = (n: string): string => `tok:${n}`;
    const s = ship({ name: 'Ana' }); // norm → 'ana', tokenized → 'tok:ana'
    const c = baseCtx({
      monthlyNameCount: { 'tok:ana': 6 }, // 6 ops under token key
      nameToken: tokenFn,
    });
    const reasons = gradeSignals(s, c);
    const bbdd = reasons.find((r) => r.signalId === 'bbdd');
    expect(bbdd).toBeDefined();
    expect(bbdd!.points).toBeGreaterThan(0);
  });

  it('gradeSignals with default nameToken (identity) still uses norm(name) as key', () => {
    const s = ship({ name: 'Ana' }); // norm → 'ana'
    // No nameToken injected → falls back to norm(name) === 'ana'
    const c = baseCtx({ monthlyNameCount: { ana: 6 } });
    const reasons = gradeSignals(s, c);
    expect(reasons.find((r) => r.signalId === 'bbdd')).toBeDefined();
  });

  // ─── 6. entityKey name-fallback uses nameToken ───────────────────────────

  it('entityKey returns RFC/CURP first (unchanged) regardless of nameToken', () => {
    const c = { name: 'Ana Lopez', rfc: 'PERJ800101AA8' };
    // entityKey with RFC should always return the RFC, not the name
    expect(entityKey(c)).toBe('PERJ800101AA8');
  });

  it('entityKey name-fallback routes through nameToken when provided', () => {
    const c = { name: 'Ana Lopez' }; // no RFC/CURP
    const tokenFn = (n: string): string => `tok:${n}`;
    // With token fn: name-fallback should be `name:tok:ana lopez`
    expect(entityKey(c, tokenFn)).toBe('name:tok:ana lopez');
  });

  it('entityKey name-fallback identity (no tokenFn): returns name:norm(name)', () => {
    const c = { name: 'Ana López' }; // no RFC
    // Default: name:norm(name)
    expect(entityKey(c)).toBe('name:ana lopez');
  });

  // ─── 7. F13/agregado consistency: entityValueTotal keyed by entityKey ────

  it('F13 agregado: same entity across both RFC and name-fallback paths stays consistent', () => {
    // RFC-bearing consignees use RFC as key — nameToken does NOT affect them
    const sRfc = ship({ name: 'Ana', rfc: 'PERJ800101AA8', customsValueUsd: 2499 });
    const ek = 'PERJ800101AA8';
    const c = baseCtx({ entityValueTotal: { [ek]: 4998 }, nameToken: upperTokenFn });
    const reasons = gradeSignals(sRfc, c);
    expect(reasons.some((r) => r.signalId === 'agregado')).toBe(true);
  });
});
