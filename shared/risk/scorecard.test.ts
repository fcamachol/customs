// shared/risk/scorecard.test.ts
import { describe, expect, it } from 'vitest';
import { scoreRow } from './scorecard';
import { RULESET } from './ruleset';
import type { ReasonCode } from './signals';

const opts = (insufficientData = false) => ({ weights: RULESET.weights, bands: RULESET.bands, insufficientData });

describe('scoreRow', () => {
  it('no reasons -> score 0 -> verde', () => {
    const r = scoreRow([], opts());
    expect(r.score).toBe(0);
    expect(r.band).toBe('verde');
  });
  it('insufficient data -> gris regardless of points', () => {
    expect(scoreRow([], opts(true)).band).toBe('gris');
  });
  it('forcesBand reason -> rojo even at low score', () => {
    const codes: ReasonCode[] = [{ signalId: 'prohibidos', points: 60, weight: 60, detail: 'x', forcesBand: 'rojo' }];
    expect(scoreRow(codes, opts()).band).toBe('rojo');
  });
  it('score crosses amarillo/rojo cutoffs', () => {
    const big: ReasonCode[] = [{ signalId: 'monto', points: 100, weight: 100, detail: 'x' }];
    // points exceed maxPoints fraction -> high score -> rojo
    expect(scoreRow(big, opts()).band).toBe('rojo');
  });
});
