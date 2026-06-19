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

function ship(over: Partial<Shipment> = {}): Shipment {
  return {
    id: Math.random().toString(), mawbReference: 'M', description: 'camisa',
    hsCode: '9901000100', quantity: 1, unit: 'PCE', customsValueUsd: 100, currency: 'USD',
    originCountry: 'CN', guideId: 'g',
    consignee: { name: 'Ana', rfc: 'PERJ800101AAA', address: 'Calle 1' },
    sender: { name: 'S' }, platform: { commercialName: 'P' }, ...over,
  } as Shipment;
}

describe('scoreManifest', () => {
  it('consignatario does NOT fire at 2 same-name rows (threshold is >=3)', () => {
    // Two rows, same consignee name → row count = 2, threshold >=3 → should NOT fire
    const twoShips = [
      ship({ consignee: { name: 'Ana', rfc: 'PERJ800101AAA', address: 'Calle 1' } }),
      ship({ consignee: { name: 'Ana', rfc: 'PERJ800101AAA', address: 'Calle 2' } }),
    ];
    const twoOut = scoreManifest(twoShips, new Set());
    expect(twoOut[0].incidences).not.toContain('Varios paquetes por consignatario');
    expect(twoOut[0].color).toBe('verde');
  });

  it('consignatario fires at 3 same-name rows (threshold >=3, row-based)', () => {
    // Three rows, same consignee name → row count = 3 → SHOULD fire
    const threeShips = [
      ship({ consignee: { name: 'Ana', rfc: 'PERJ800101AAA', address: 'Calle 1' } }),
      ship({ consignee: { name: 'Ana', rfc: 'PERJ800101AAA', address: 'Calle 2' } }),
      ship({ consignee: { name: 'Ana', rfc: 'PERJ800101AAA', address: 'Calle 3' } }),
    ];
    const threeOut = scoreManifest(threeShips, new Set());
    expect(threeOut[0].incidences).toContain('Varios paquetes por consignatario');
  });

  it('direccion fires at 2 same-address rows (threshold >=2, row-based)', () => {
    // Two rows sharing the same address → row count = 2 → SHOULD fire
    const ships = [
      ship({ consignee: { name: 'Ana', rfc: 'PERJ800101AAA', address: 'Calle X' } }),
      ship({ consignee: { name: 'Bob', rfc: 'PERJ800101AAA', address: 'Calle X' } }),
    ];
    const out = scoreManifest(ships, new Set());
    expect(out[0].incidences).toContain('Misma dirección de entrega');
  });

  it('severity override: prohibidos alone forces rojo even when score < 2', () => {
    // Only fired signal is prohibidos (score=1, normally verde) — must be rojo
    const s = ship({ description: 'armas de fuego' });
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
    const s = ship({ description: 'bolso gucci falso' });
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
    const s = ship({ customsValueUsd: 5000, consignee: { name: 'Bob', rfc: 'BAD', address: 'Calle 9' } });
    const out = scoreManifest([s], new Set());
    expect(out[0].score).toBeGreaterThanOrEqual(2);
    expect(out[0].color).toBe('amarillo');
    // Confirm no critical signals were fired
    expect(out[0].incidences).not.toEqual(expect.arrayContaining([expect.stringContaining('Artículos prohibidos')]));
    expect(out[0].incidences).not.toEqual(expect.arrayContaining([expect.stringContaining('Piratería')]));
  });

  it('ruleset_version is set on every scored shipment', () => {
    const out = scoreManifest([ship({})], new Set());
    expect(out[0].ruleset_version).toBe('2026-06');
  });
});
