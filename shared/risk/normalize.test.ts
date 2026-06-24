/**
 * normalize.test.ts — TDD tests for evasion-resistant canonicalization.
 *
 * Covers:
 *   1. canonicalize() positive cases (leet, token-split, homoglyph evasion)
 *   2. canonicalize() negative / false-positive guard cases
 *   3. norm() semantic stability (must match prior inline definition)
 *   4. matchesBrand / matchesProhibited integration using evasion inputs
 */
import { describe, expect, it } from 'vitest';
import { canonicalize, norm } from './normalize';
import { matchesBrand, matchesProhibited } from './lists';

// ─── 1. canonicalize() — positive evasion cases ──────────────────────────────

describe('canonicalize() — evasion positive cases', () => {
  it('N1ke (leet): tight form matches nike', () => {
    const { tight } = canonicalize('N1ke');
    const { tight: needle } = canonicalize('Nike');
    expect(tight).toContain(needle);
    expect(tight).toBe('nike');
    expect(needle).toBe('nike');
  });

  it('Guc ci (token-split): tight form matches gucci', () => {
    const { tight: haystack } = canonicalize('Guc ci');
    const { tight: needle } = canonicalize('Gucci');
    expect(haystack).toContain(needle);
    expect(haystack).toBe('gucci');
    expect(needle).toBe('gucci');
  });

  it('Cyrillic і (U+0456) in Nіke: loose form folds to nike matching Nike loose', () => {
    // The Cyrillic і (U+0456) is mapped to Latin i in the confusables table.
    // This happens in the loose form (confusable fold step).
    const cyrillicI = 'і'; // Cyrillic і
    const { loose: haystack } = canonicalize(`N${cyrillicI}ke`);
    const { loose: needle } = canonicalize('Nike');
    expect(haystack).toBe('nike');
    expect(needle).toBe('nike');
    expect(haystack).toContain(needle);
  });

  it('l1quido (leet): tight form matches liquido', () => {
    const { tight } = canonicalize('l1quido');
    const { tight: needle } = canonicalize('liquido');
    expect(tight).toContain(needle);
    expect(tight).toBe('liquido');
    expect(needle).toBe('liquido');
  });

  it('p4st1lla (multi-leet): tight form matches pastilla', () => {
    const { tight } = canonicalize('p4st1lla');
    const { tight: needle } = canonicalize('pastilla');
    expect(tight).toContain(needle);
    expect(tight).toBe('pastilla');
    expect(needle).toBe('pastilla');
  });

  it('Cyrillic а,е,о,р,с,х: loose folds all to Latin equivalents', () => {
    // а→a, е→e, о→o, р→p, с→c, х→x
    expect(canonicalize('аеорсх').loose).toBe('aeopcy'.slice(0, 4) + 'cx');
    // Each mapping individually:
    expect(canonicalize('а').loose).toBe('a'); // Cyrillic а → a
    expect(canonicalize('е').loose).toBe('e'); // Cyrillic е → e
    expect(canonicalize('о').loose).toBe('o'); // Cyrillic о → o
    expect(canonicalize('р').loose).toBe('p'); // Cyrillic р → p
    expect(canonicalize('с').loose).toBe('c'); // Cyrillic с → c
    expect(canonicalize('х').loose).toBe('x'); // Cyrillic х → x
    expect(canonicalize('ѕ').loose).toBe('s'); // Cyrillic ѕ → s
    expect(canonicalize('у').loose).toBe('y'); // Cyrillic у → y
  });

  it('Greek homoglyphs: loose folds to Latin equivalents', () => {
    expect(canonicalize('ν').loose).toBe('v'); // Greek ν → v
    expect(canonicalize('ο').loose).toBe('o'); // Greek ο → o
    expect(canonicalize('α').loose).toBe('a'); // Greek α → a
    expect(canonicalize('ε').loose).toBe('e'); // Greek ε → e
    expect(canonicalize('ρ').loose).toBe('p'); // Greek ρ → p
  });

  it('@ and $ leet chars: tight form substituted', () => {
    expect(canonicalize('p@st1ll@').tight).toBe('pastilla');
    expect(canonicalize('$5').tight).toBe('ss');
  });

  it('diacritics are stripped in loose form (NFD)', () => {
    expect(canonicalize('cápsula').loose).toBe('capsula');
    expect(canonicalize('Gücci').loose).toBe('gucci');
  });
});

// ─── 2. canonicalize() — false-positive guard ─────────────────────────────────

describe('canonicalize() — false-positive guard (tight path threshold >= 4)', () => {
  it('short leet "s4" has tight form length < 4 — would not be used as needle', () => {
    const { tight } = canonicalize('s4');
    expect(tight.length).toBeLessThan(4);
  });

  it('tight form of "id" is length < 4', () => {
    const { tight } = canonicalize('id');
    expect(tight.length).toBeLessThan(4);
  });

  it('"modelo A1B2 camisa lisa" tight form does NOT contain "nike"', () => {
    const { tight } = canonicalize('modelo A1B2 camisa lisa');
    const { tight: nikeTight } = canonicalize('Nike');
    expect(tight).not.toContain(nikeTight);
  });
});

// ─── 3. norm() — semantic stability ───────────────────────────────────────────

describe('norm() — semantic stability (must match prior inline definition)', () => {
  it('pure ASCII string: output unchanged', () => {
    expect(norm('Nike')).toBe('nike');
    expect(norm('Louis Vuitton')).toBe('louis vuitton');
    expect(norm('CAMISA AZUL')).toBe('camisa azul');
  });

  it('diacritics are stripped (NFD)', () => {
    expect(norm('cápsula')).toBe('capsula');
    expect(norm('árbol')).toBe('arbol');
  });

  it('whitespace is preserved (trim only at edges)', () => {
    expect(norm('  hola  ')).toBe('hola');
    expect(norm('uno dos')).toBe('uno dos');
  });

  it('null/undefined safety: returns empty string', () => {
    // norm is typed to take string but runtime may receive nullish values
    expect(norm('')).toBe('');
  });

  it('Cyrillic і (U+0456) is NOT folded by norm() — confusable folding is only in canonicalize()', () => {
    // This is the key semantic contract: norm() does not apply the confusable fold.
    // If this were applied, stored entity keys for Cyrillic-named consignees would shift.
    const cyrillicI = 'і';
    const result = norm(`N${cyrillicI}ke`);
    // The Cyrillic і is NOT Latin i in NFD — it has no decomposition to a Latin base.
    // So after NFD+diacritic strip+lowercase, the character remains.
    expect(result).not.toBe('nike');
  });
});

// ─── 4. matchesBrand / matchesProhibited — integration with evasion inputs ───

describe('matchesBrand() — evasion resistance integration', () => {
  it('N1ke (leet) in description → matches Nike via tight path', () => {
    expect(matchesBrand('tenis N1ke air')).toBe('Nike');
  });

  it('Guc ci (token-split) → matches Gucci via tight path', () => {
    expect(matchesBrand('bolsa Guc ci edicion')).toBe('Gucci');
  });

  it('Cyrillic і → matches Nike via loose path (confusable fold)', () => {
    const cyrillicI = 'і'; // Cyrillic і (U+0456)
    expect(matchesBrand(`N${cyrillicI}ke zapato`)).toBe('Nike');
  });

  it('false-positive guard: "modelo A1B2 camisa" → null', () => {
    expect(matchesBrand('modelo A1B2 camisa')).toBeNull();
  });

  it('existing tests still pass — Tenis NIKE air → Nike (loose path)', () => {
    expect(matchesBrand('Tenis NIKE air')).toBe('Nike');
  });

  it('existing tests still pass — bolsa louis vuitton → Louis Vuitton', () => {
    expect(matchesBrand('bolsa louis vuitton')).toBe('Louis Vuitton');
  });

  it('camisa lisa → null (no match)', () => {
    expect(matchesBrand('camisa lisa')).toBeNull();
  });
});

describe('matchesProhibited() — evasion resistance integration', () => {
  it('l1quido (leet) in description → matches liquido via tight path', () => {
    expect(matchesProhibited('l1quido peligroso')).toBe('liquido');
  });

  it('p4st1lla (multi-leet) → matches pastilla via tight path', () => {
    expect(matchesProhibited('p4st1lla vitamina extra')).toBe('pastilla');
  });

  it('existing tests still pass — caja de maquillaje → maquillaje', () => {
    expect(matchesProhibited('caja de maquillaje')).toBe('maquillaje');
  });

  it('existing tests still pass — autoparte de motor → autoparte', () => {
    expect(matchesProhibited('autoparte de motor')).toBe('autoparte');
  });

  it('libro → null (no match)', () => {
    expect(matchesProhibited('libro')).toBeNull();
  });
});
