import { describe, expect, it } from 'vitest';
import { traducirDescripcion } from './descripcionEs';

describe('traducirDescripcion', () => {
  it('translates a comma-separated English product list to Spanish', () => {
    expect(traducirDescripcion('Pants,Protective Case,T-Shirt,Women\'s dress,Sweatshirt,Coat'))
      .toBe('Pantalones, Funda protectora, Camiseta, Vestido de mujer, Sudadera, Abrigo');
  });
  it('translates single terms case-insensitively', () => {
    expect(traducirDescripcion('Phone Case')).toBe('Funda para teléfono');
    expect(traducirDescripcion('BELT')).toBe('Cinturón');
  });
  it('falls back to the singular for unknown plurals', () => {
    expect(traducirDescripcion('Jackets')).toBe('Chaqueta');
  });
  it('passes unknown segments through unchanged (never loses information)', () => {
    expect(traducirDescripcion('Pants,Fidget Widget X')).toBe('Pantalones, Fidget Widget X');
    expect(traducirDescripcion('手机壳')).toBe('手机壳');
  });
  it('handles empty input', () => {
    expect(traducirDescripcion('')).toBe('');
  });
});
