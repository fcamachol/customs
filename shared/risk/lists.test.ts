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
