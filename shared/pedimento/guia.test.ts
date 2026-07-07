import { describe, expect, it } from 'vitest';
import { normGuia, normGuiaSet, indexByNormGuia } from './guia';

describe('normGuia', () => {
  it('strips punctuation and whitespace and uppercases', () => {
    expect(normGuia('369-94268462')).toBe('36994268462');
    expect(normGuia('g-1')).toBe('G1');
    expect(normGuia(' G 1 ')).toBe('G1');
    expect(normGuia('abc.def_123')).toBe('ABCDEF123');
  });

  it('makes formatting-different but identical guías compare equal', () => {
    expect(normGuia('G-1')).toBe(normGuia('g1'));
    expect(normGuia('369-94268462')).toBe(normGuia('369 94268462'));
  });

  it('keeps genuinely different guías distinct', () => {
    expect(normGuia('G-1')).not.toBe(normGuia('G-2'));
  });

  it('normalizes null/undefined and blank to empty string', () => {
    expect(normGuia(undefined as unknown as string)).toBe('');
    expect(normGuia('   ')).toBe('');
    expect(normGuia('---')).toBe('');
  });
});

describe('normGuiaSet', () => {
  it('builds a normalized membership set and matches across formats', () => {
    const set = normGuiaSet(['G-1', ' g2 ']);
    expect(set.has(normGuia('g1'))).toBe(true);
    expect(set.has(normGuia('G2'))).toBe(true);
    expect(set.has(normGuia('G3'))).toBe(false);
  });

  it('drops blank/punctuation-only guías so they never match each other', () => {
    const set = normGuiaSet(['', '---', '  ']);
    expect(set.size).toBe(0);
    expect(set.has(normGuia(''))).toBe(false);
  });
});

describe('indexByNormGuia', () => {
  it('maps a normalized guía back to its raw value', () => {
    const idx = indexByNormGuia(['G-1', 'G2']);
    expect(idx.get(normGuia('g1'))).toBe('G-1');
    expect(idx.get(normGuia('g2'))).toBe('G2');
  });

  it('keeps the first raw value on a normalized collision', () => {
    const idx = indexByNormGuia(['G-1', 'g1']);
    expect(idx.get(normGuia('G1'))).toBe('G-1');
    expect(idx.size).toBe(1);
  });
});
