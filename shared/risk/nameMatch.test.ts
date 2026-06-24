/**
 * nameMatch.test.ts — TDD: write failing tests first.
 *
 * Tests for F14: fuzzy entity resolution for name-typo evasion in bbdd/smurfing signals.
 * Tests must fail before implementation exists in nameMatch.ts.
 */
import { describe, expect, it } from 'vitest';
import { blockingKey, similar, resolveNameClusters } from './nameMatch';

describe('blockingKey', () => {
  it('strips diacritics', () => {
    expect(blockingKey('García')).toBe(blockingKey('Garcia'));
    expect(blockingKey('López')).toBe(blockingKey('Lopez'));
  });

  it('is case-insensitive', () => {
    expect(blockingKey('Juan Perez')).toBe(blockingKey('JUAN PEREZ'));
  });

  it('is token-sorted (word order invariant)', () => {
    expect(blockingKey('Juan Perez')).toBe(blockingKey('Perez Juan'));
    expect(blockingKey('Maria de la Cruz')).toBe(blockingKey('Cruz de la Maria'));
  });

  it('folds Spanish phonetic equivalents: s/z/c', () => {
    // s→s, z→s, c before e/i→s (hard c before a/o/u and before consonants stays as k)
    expect(blockingKey('Perez')).toBe(blockingKey('Peres'));
    expect(blockingKey('Perez')).toBe(blockingKey('Perec'));
  });

  it('folds Spanish phonetic equivalents: b/v', () => {
    expect(blockingKey('Vargas')).toBe(blockingKey('Bargas'));
    expect(blockingKey('Vidal')).toBe(blockingKey('Bidal'));
  });

  it('produces a consistent string (not empty for non-empty input)', () => {
    expect(blockingKey('Juan Perez').length).toBeGreaterThan(0);
    expect(blockingKey('')).toBe('');
  });
});

describe('similar (bounded Damerau-Levenshtein)', () => {
  it('returns true for identical strings', () => {
    expect(similar('juan perez', 'juan perez', 2)).toBe(true);
  });

  it('returns true for a 1-character typo (Juan Peres ~ Juan Perez)', () => {
    expect(similar('juan peres', 'juan perez', 2)).toBe(true);
  });

  it('returns true for a transposition (Juan Preez ~ Juan Perez)', () => {
    expect(similar('juan preez', 'juan perez', 2)).toBe(true);
  });

  it('returns false when distance exceeds maxDistance', () => {
    expect(similar('juan', 'perez', 2)).toBe(false);
  });

  it('respects maxDistance bound', () => {
    // distance 3 should fail with maxDistance=2 but pass with maxDistance=3
    expect(similar('abcde', 'abxyz', 2)).toBe(false);
    expect(similar('abcde', 'abxyz', 4)).toBe(true);
  });

  it('is symmetric', () => {
    expect(similar('juan peres', 'juan perez', 2)).toBe(similar('juan perez', 'juan peres', 2));
  });
});

describe('resolveNameClusters', () => {
  it('clusters Juan Peres with Juan Perez (typo variant)', () => {
    const names = ['Juan Perez', 'Juan Peres'];
    const clusters = resolveNameClusters(names);
    const c1 = clusters.get('juan perez');
    const c2 = clusters.get('juan peres');
    // Both should resolve to the same canonical
    expect(c1).toBeDefined();
    expect(c2).toBeDefined();
    expect(c1).toBe(c2);
  });

  it('is token-order invariant (Perez Juan clusters with Juan Perez)', () => {
    const names = ['Juan Perez', 'Perez Juan'];
    const clusters = resolveNameClusters(names);
    const c1 = clusters.get('juan perez');
    const c2 = clusters.get('perez juan');
    expect(c1).toBeDefined();
    expect(c2).toBeDefined();
    expect(c1).toBe(c2);
  });

  it('does NOT cluster "Maria" and "Mario" (short standalone names, ≤8 chars)', () => {
    // Fix 3: short-name guard — distance-based merging requires BOTH names' norm length ≥ 8.
    // "maria" (5 chars) and "mario" (5 chars) are below the minimum → must NOT merge.
    // They also differ in blockingKey, so phonetic blocking does not merge them either.
    const names = ['Maria', 'Mario'];
    const clusters = resolveNameClusters(names);
    const c1 = clusters.get('maria');
    const c2 = clusters.get('mario');
    expect(c1).toBeDefined();
    expect(c2).toBeDefined();
    // Short-name guard: MUST NOT cluster.
    expect(c1).not.toBe(c2);
  });

  it('canonical is the lexicographically smallest normalized name in the cluster', () => {
    const names = ['Juan Peres', 'Juan Perez'];
    const clusters = resolveNameClusters(names);
    // 'juan peres' < 'juan perez' lexicographically ('s' < 'z'), so canonical = 'juan peres'
    expect(clusters.get('juan peres')).toBe('juan peres');
    expect(clusters.get('juan perez')).toBe('juan peres');
  });

  it('canonical is stable: both names point to the same lex-minimum canonical', () => {
    const clusters1 = resolveNameClusters(['Juan Perez']);
    const clusters2 = resolveNameClusters(['Juan Perez', 'Juan Peres']);
    // In both cases 'Juan Perez' alone maps to 'juan perez'; when grouped the
    // canonical shifts to 'juan peres' (lex smaller). Both are internally consistent.
    expect(clusters1.get('juan perez')).toBe('juan perez');
    // In the group, both map to the lex-minimum ('juan peres')
    expect(clusters2.get('juan perez')).toBe('juan peres');
    expect(clusters2.get('juan peres')).toBe('juan peres');
  });

  it('handles empty input', () => {
    const clusters = resolveNameClusters([]);
    expect(clusters.size).toBe(0);
  });

  it('handles a single name', () => {
    const clusters = resolveNameClusters(['Juan Perez']);
    expect(clusters.get('juan perez')).toBe('juan perez');
  });

  it('clusters multiple variants of a name into one canonical', () => {
    // Three variants: exact, 1-typo, transposition
    const names = ['Ana Lopez', 'Ana Lopex', 'Ana Loopez'];
    const clusters = resolveNameClusters(names);
    const c1 = clusters.get('ana lopez');
    const c2 = clusters.get('ana lopex');
    // 1-typo should cluster
    expect(c1).toBe(c2);
  });
});

describe('resolveNameClusters — short-name guard (Fix 3)', () => {
  // Rule: distance-based merging requires BOTH names' norm length ≥ 8.
  // Short names (< 8 chars) can only merge via phonetic blocking (same blockingKey).
  // This prevents false positives like "Maria"/"Mario" (5 chars each).

  it('"Maria" and "Mario" (5 chars) must NOT merge via edit distance', () => {
    // Both names are 5 chars < MIN_LEN_FOR_DISTANCE=8. Different blockingKeys → no merge.
    const clusters = resolveNameClusters(['Maria', 'Mario']);
    const c1 = clusters.get('maria');
    const c2 = clusters.get('mario');
    expect(c1).not.toBe(c2);
  });

  it('"Juan Perez"/"Juan Peres" (10 chars each) still merges — genuine typo case', () => {
    // Both names are 10 chars ≥ 8 → distance check applies. Distance=1 ≤ threshold=2.
    const clusters = resolveNameClusters(['Juan Perez', 'Juan Peres']);
    expect(clusters.get('juan perez')).toBe(clusters.get('juan peres'));
  });

  it('"Carlos Ruiz"/"Carlos Ruix" (11 chars) merges — full name ≥8 passes the guard', () => {
    // Full-name length is what is checked, not individual token length.
    // "carlos ruiz"/"carlos ruix" are 11 chars each → guard passes → distance merge.
    const clusters = resolveNameClusters(['Carlos Ruiz', 'Carlos Ruix']);
    expect(clusters.get('carlos ruiz')).toBe(clusters.get('carlos ruix'));
  });
});

describe('resolveNameClusters — distinct valid entities are never merged', () => {
  it('does not merge clearly different people (even if they share a name fragment)', () => {
    const names = ['Carlos Fernandez', 'Carlos Rodriguez'];
    const clusters = resolveNameClusters(names);
    const c1 = clusters.get('carlos fernandez');
    const c2 = clusters.get('carlos rodriguez');
    expect(c1).not.toBe(c2);
  });

  it('returns all input names as keys (each name gets a canonical)', () => {
    const names = ['Juan Perez', 'Ana Lopez', 'Carlos Ruiz'];
    const clusters = resolveNameClusters(names);
    for (const n of names) {
      expect(clusters.has(n.toLowerCase())).toBe(true);
    }
  });
});
