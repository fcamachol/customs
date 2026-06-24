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
});
