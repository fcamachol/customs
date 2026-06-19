import { describe, expect, it } from 'vitest';
import { classifyScore, scoreManifest } from './classify';
import type { Shipment } from '../types/shipment';

describe('classifyScore', () => {
  it('uses spreadsheet bands: <2 verde, 2-3 amarillo, >=4 rojo', () => {
    expect(classifyScore(0)).toBe('verde');
    expect(classifyScore(1)).toBe('verde');
    expect(classifyScore(2)).toBe('amarillo');
    expect(classifyScore(3)).toBe('amarillo');
    expect(classifyScore(4)).toBe('rojo');
    expect(classifyScore(8)).toBe('rojo');
  });
});

function ship(id: string, over: Partial<Shipment> = {}): Shipment {
  return {
    id, mawbReference: 'M', description: 'camisa',
    hsCode: '9901000100', quantity: 1, unit: 'PCE', customsValueUsd: 100, currency: 'USD',
    originCountry: 'CN', guideId: id, // unique guideId so dedup-by-package counts correctly
    consignee: { name: 'Ana', rfc: 'PERJ800101AAA', address: 'Calle 1' },
    sender: { name: 'S' }, platform: { commercialName: 'P' }, ...over,
  } as Shipment;
}

describe('scoreManifest', () => {
  it('consignatario does NOT fire at 2 occurrences (threshold is >=3)', () => {
    // Two shipments with same consignee name, distinct guideIds → count=2, threshold >=3 → should NOT fire
    const twoShips = [
      ship('g1', { consignee: { name: 'Ana', rfc: 'PERJ800101AAA', address: 'Calle 1' } }),
      ship('g2', { consignee: { name: 'Ana', rfc: 'PERJ800101AAA', address: 'Calle 2' } }),
    ];
    const twoOut = scoreManifest(twoShips, new Set());
    expect(twoOut[0].incidences).not.toContain('Varios paquetes por consignatario');
    expect(twoOut[0].color).toBe('verde');
  });

  it('consignatario fires at 3rd+ occurrence (threshold >=3)', () => {
    // Three shipments with same consignee name, distinct guideIds → count=3 → SHOULD fire
    const threeShips = [
      ship('g3', { consignee: { name: 'Ana', rfc: 'PERJ800101AAA', address: 'Calle 1' } }),
      ship('g4', { consignee: { name: 'Ana', rfc: 'PERJ800101AAA', address: 'Calle 2' } }),
      ship('g5', { consignee: { name: 'Ana', rfc: 'PERJ800101AAA', address: 'Calle 3' } }),
    ];
    const threeOut = scoreManifest(threeShips, new Set());
    expect(threeOut[0].incidences).toContain('Varios paquetes por consignatario');
  });

  it('severity override: prohibidos alone forces rojo even when score < 2', () => {
    // Only fired signal is prohibidos (score=1, normally verde) — must be rojo
    const s = ship('sg1', { description: 'armas de fuego' });
    const out = scoreManifest(
      [s],
      new Set(),
      { prohibitedKeywords: ['armas'] },
    );
    expect(out[0].incidences).toEqual(expect.arrayContaining([expect.stringContaining('Artículos prohibidos')]));
    expect(out[0].score).toBe(1); // score is still 1 (count-based)
    expect(out[0].color).toBe('rojo'); // but color is forced rojo by severity override
  });

  it('severity override: pirateria alone forces rojo', () => {
    const s = ship('sg2', { description: 'bolso gucci falso' });
    const out = scoreManifest(
      [s],
      new Set(),
      { piracyBrands: ['gucci'] },
    );
    expect(out[0].incidences).toEqual(expect.arrayContaining([expect.stringContaining('Piratería')]));
    expect(out[0].color).toBe('rojo');
  });

  it('score 2-3 with no critical signal -> amarillo', () => {
    // Two flags: invalid RFC (short) + value too high — no prohibidos/pirateria
    const s = ship('sg3', { customsValueUsd: 5000, consignee: { name: 'Bob', rfc: 'BAD', address: 'Calle 9' } });
    const out = scoreManifest([s], new Set());
    expect(out[0].score).toBeGreaterThanOrEqual(2);
    expect(out[0].color).toBe('amarillo');
    // Confirm no critical signals were fired
    expect(out[0].incidences).not.toEqual(expect.arrayContaining([expect.stringContaining('Artículos prohibidos')]));
    expect(out[0].incidences).not.toEqual(expect.arrayContaining([expect.stringContaining('Piratería')]));
  });

  it('ruleset_version is set on every scored shipment', () => {
    const out = scoreManifest([ship('rv1')], new Set());
    expect(out[0].ruleset_version).toBe('2026-06');
  });
});
