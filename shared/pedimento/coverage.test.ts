import { describe, expect, it } from 'vitest';
import { computeCoverage } from './coverage';

const ped = (numero: string, guias: string[], extra = {}) => ({ numeroPedimento: numero, coveredGuias: guias, ...extra });

describe('computeCoverage', () => {
  it('sin_pedimento when there are no pedimentos', () => {
    const r = computeCoverage(['G1', 'G2'], []);
    expect(r.status).toBe('sin_pedimento');
    expect(r.uncoveredGuias).toEqual(['G1', 'G2']);
  });

  it('completo when every guía is covered exactly once and all expected pedimentos are present', () => {
    const r = computeCoverage(['G1', 'G2', 'G3'], [
      ped('1', ['G1', 'G2'], { siblings: ['2'], isLast: false }),
      ped('2', ['G3'], { siblings: ['1'], isLast: true, ordinal: 2 }),
    ]);
    expect(r.status).toBe('completo');
    expect(r.missingNumeros).toEqual([]);
    expect(r.uncoveredGuias).toEqual([]);
    expect(r.duplicatedGuias).toEqual([]);
    expect(r.expectedCount).toBe(2);
  });

  it('parcial when a declared sibling pedimento is still missing', () => {
    const r = computeCoverage(['G1', 'G2', 'G3'], [
      ped('1', ['G1', 'G2'], { siblings: ['2', '3'] }),
    ]);
    expect(r.status).toBe('parcial');
    expect(r.expectedCount).toBe(3);
    expect(r.missingNumeros.sort()).toEqual(['2', '3']);
  });

  it('parcial with an uncovered guía even if expected set is complete', () => {
    const r = computeCoverage(['G1', 'G2'], [ped('1', ['G1'], { siblings: [], isLast: true, ordinal: 1 })]);
    expect(r.status).toBe('parcial');
    expect(r.uncoveredGuias).toEqual(['G2']);
  });

  it('flags a guía covered by more than one pedimento as duplicated', () => {
    const r = computeCoverage(['G1'], [ped('1', ['G1'], { siblings: ['2'] }), ped('2', ['G1'], { siblings: ['1'] })]);
    expect(r.duplicatedGuias).toEqual(['G1']);
    expect(r.status).toBe('parcial');
  });

  it('parcial (never completo) when the manifest has no guías — coverage cannot be vacuously satisfied', () => {
    const r = computeCoverage([], [ped('1', [], { siblings: [], isLast: true, ordinal: 1 })]);
    expect(r.status).toBe('parcial');
    expect(r.manifestGuiaCount).toBe(0);
  });

  it('covers a guía even when manifest and pedimento format it differently (dashes/case)', () => {
    const r = computeCoverage(['G-1', 'G2'], [
      ped('1', ['g1', 'G-2'], { siblings: [], isLast: true, ordinal: 1 }),
    ]);
    expect(r.status).toBe('completo');
    expect(r.uncoveredGuias).toEqual([]);
    expect(r.coveredGuiaCount).toBe(2);
  });

  it('reports the RAW manifest guía (not the normalized form) as uncovered', () => {
    const r = computeCoverage(['369-94268462', 'ABC-1'], [
      ped('1', ['36994268462'], { siblings: [], isLast: true, ordinal: 1 }),
    ]);
    expect(r.uncoveredGuias).toEqual(['ABC-1']);
  });

  it('flags a normalized duplicate covered by two pedimentos', () => {
    const r = computeCoverage(['G-1'], [
      ped('1', ['g1'], { siblings: ['2'] }),
      ped('2', ['G1'], { siblings: ['1'] }),
    ]);
    expect(r.duplicatedGuias).toEqual(['G-1']);
    expect(r.status).toBe('parcial');
  });
});
