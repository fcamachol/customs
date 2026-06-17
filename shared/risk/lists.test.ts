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
});
