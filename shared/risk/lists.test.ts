import { describe, expect, it } from 'vitest';
import { matchesBrand, matchesProhibited } from './lists';

describe('lists', () => {
  it('detects piracy brands case-insensitively', () => {
    expect(matchesBrand('Tenis NIKE air')).toBe('Nike');
    expect(matchesBrand('bolsa louis vuitton')).toBe('Louis Vuitton');
    expect(matchesBrand('camisa lisa')).toBeNull();
  });
  it('detects prohibited keywords', () => {
    expect(matchesProhibited('caja de maquillaje')).toBe('maquillaje');
    expect(matchesProhibited('autoparte de motor')).toBe('autoparte');
    expect(matchesProhibited('libro')).toBeNull();
  });

  // ─── F12: evasion resistance — leet, token-split, homoglyph ────────────────
  describe('evasion resistance (F12)', () => {
    it('matchesBrand: N1ke (leet) → Nike', () => {
      expect(matchesBrand('tenis N1ke air')).toBe('Nike');
    });

    it('matchesBrand: Guc ci (token-split) → Gucci', () => {
      expect(matchesBrand('bolsa Guc ci edicion')).toBe('Gucci');
    });

    it('matchesBrand: Cyrillic і (U+0456) in Nіke → Nike', () => {
      const cyrillicI = 'і'; // Cyrillic і
      expect(matchesBrand(`N${cyrillicI}ke zapato`)).toBe('Nike');
    });

    it('matchesProhibited: l1quido (leet) → liquido', () => {
      expect(matchesProhibited('l1quido peligroso')).toBe('liquido');
    });

    it('matchesProhibited: p4st1lla (multi-leet) → pastilla', () => {
      expect(matchesProhibited('p4st1lla vitamina extra')).toBe('pastilla');
    });

    it('false-positive guard: matchesBrand("modelo A1B2 camisa") → null', () => {
      expect(matchesBrand('modelo A1B2 camisa')).toBeNull();
    });
  });

  // Tests for injected override lists
  it('matchesProhibited uses injected list — faro is NOT a default keyword but matches when injected', () => {
    expect(matchesProhibited('Faro delantero', ['faro'])).toBe('faro');
  });
  it('matchesProhibited with injected list does NOT fall back to defaults', () => {
    // 'maquillaje' is a default keyword but not in the injected list
    expect(matchesProhibited('caja de maquillaje', ['faro'])).toBeNull();
  });
  it('matchesProhibited with empty injected list falls back to defaults', () => {
    expect(matchesProhibited('caja de maquillaje', [])).toBe('maquillaje');
  });
  it('matchesBrand uses injected list — custom brand detected', () => {
    expect(matchesBrand('Bolsa Puma edicion especial', ['Puma'])).toBe('Puma');
  });
  it('matchesBrand with injected list does NOT match defaults not in the list', () => {
    // 'Nike' is a default brand but not in the injected list
    expect(matchesBrand('Tenis NIKE air', ['Puma'])).toBeNull();
  });
  it('default behavior unchanged when no list passed', () => {
    expect(matchesProhibited('libro')).toBeNull();
    expect(matchesBrand('camisa lisa')).toBeNull();
    expect(matchesBrand('Tenis NIKE air')).toBe('Nike');
  });
});
