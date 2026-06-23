import { describe, expect, it } from 'vitest';
import { resolveWeights, resolveBands, maxPoints, RULESET } from './ruleset';

describe('ruleset weights/bands floors', () => {
  it('rejects negative / non-finite weight overrides (cannot disable a signal)', () => {
    const w = resolveWeights({ prohibidos: -5, monto: NaN, id: 10 });
    expect(w.prohibidos).toBe(RULESET.weights.prohibidos); // override rejected
    expect(w.monto).toBe(RULESET.weights.monto);           // NaN rejected
    expect(w.id).toBe(10);                                  // valid override accepted
  });

  it('rejects inverted bands (rojo must be > amarillo)', () => {
    const b = resolveBands({ amarillo: 80, rojo: 20 });
    expect(b).toEqual(RULESET.bands); // inverted -> fall back to defaults
  });

  it('maxPoints sums all signal weights', () => {
    expect(maxPoints(RULESET.weights)).toBe(
      Object.values(RULESET.weights).reduce((a, b) => a + b, 0),
    );
  });
});
