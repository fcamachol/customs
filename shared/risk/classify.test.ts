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
    consignee: { name: 'Ana', rfc: 'PERJ800101AA8', address: 'Calle 1' },
    sender: { name: 'S' }, platform: { commercialName: 'P' }, ...over,
  } as Shipment;
}

describe('scoreManifest', () => {
  it('a single clean shipment (valid RFC, normal qty/value) scores verde', () => {
    const out = scoreManifest([ship()], {});
    expect(out[0].band).toBe('verde');
    expect(out[0].color).toBe('verde'); // back-compat alias
    expect(out[0].reasons).toHaveLength(0);
    expect(out[0].incidences).toHaveLength(0); // back-compat alias
  });

  it('smurfing signal fires when >= 3 distinct entities share one address', () => {
    // Three different RFC-identified consignees at the same address → distinct=3 → fires
    const ships = [
      ship({ consignee: { name: 'Ana', rfc: 'PERJ800101AA8', address: 'Calle X' } }),
      ship({ consignee: { name: 'Bob', rfc: 'BOBC800202BB9', address: 'Calle X' } }),
      ship({ consignee: { name: 'Car', rfc: 'CARC800303CC0', address: 'Calle X' } }),
    ];
    const out = scoreManifest(ships, {});
    // all three rows share the address → addressDistinctConsignees=3 ≥ threshold=3
    expect(out[0].incidences).toEqual(expect.arrayContaining([expect.stringContaining('Misma dirección de entrega')]));
  });

  it('smurfing signal does NOT fire for only 2 distinct entities at one address', () => {
    const ships = [
      ship({ consignee: { name: 'Ana', rfc: 'PERJ800101AA8', address: 'Calle X' } }),
      ship({ consignee: { name: 'Bob', rfc: 'BOBC800202BB9', address: 'Calle X' } }),
    ];
    const out = scoreManifest(ships, {});
    // distinct=2 < threshold=3 → no fire
    expect(out[0].incidences).not.toEqual(expect.arrayContaining([expect.stringContaining('Misma dirección de entrega')]));
    expect(out[0].band).toBe('verde');
  });

  it('severity override: prohibidos alone forces rojo regardless of weighted score', () => {
    // Only fired signal is prohibidos → forcesBand='rojo' regardless of numeric score
    const s = ship({ description: 'armas de fuego' });
    const out = scoreManifest(
      [s],
      {},
      { prohibitedKeywords: ['armas'] },
    );
    expect(out[0].incidences).toEqual(expect.arrayContaining([expect.stringContaining('Artículos prohibidos')]));
    expect(out[0].band).toBe('rojo');
    expect(out[0].color).toBe('rojo'); // back-compat alias
    // score is 0-100 weighted (prohibidos = 60/218 * 100 ≈ 28)
    expect(out[0].score).toBeGreaterThan(0);
  });

  it('severity override: pirateria alone forces rojo', () => {
    const s = ship({ description: 'bolso gucci falso' });
    const out = scoreManifest(
      [s],
      {},
      { piracyBrands: ['gucci'] },
    );
    expect(out[0].incidences).toEqual(expect.arrayContaining([expect.stringContaining('Piratería')]));
    expect(out[0].band).toBe('rojo');
    expect(out[0].color).toBe('rojo'); // back-compat alias
  });

  it('invalid RFC + value too high produces rojo in the weighted engine', () => {
    // id signal (25 pts) + monto signal (20 pts) = 45/218*100 ≈ 20.6 → ≥ rojo threshold (17)
    const s = ship({ customsValueUsd: 5000, consignee: { name: 'Bob', rfc: 'BAD', address: 'Calle 9' } });
    const out = scoreManifest([s], {});
    expect(out[0].score).toBeGreaterThan(0);
    expect(out[0].band).toBe('rojo');
    expect(out[0].color).toBe('rojo'); // back-compat alias
    // Confirm no critical (forcesBand) signals were fired
    expect(out[0].reasons.every((r) => !r.forcesBand)).toBe(true);
  });

  it('missing description or value produces gris (data-sufficiency)', () => {
    const noDesc = ship({ description: '' });
    const out = scoreManifest([noDesc], {});
    expect(out[0].band).toBe('gris');
    expect(out[0].color).toBe('gris'); // back-compat alias
  });

  it('ruleset_version and ruleset_hash are set on every scored shipment', () => {
    const out = scoreManifest([ship()], {});
    expect(out[0].ruleset_version).toBe('2026-06');
    expect(out[0].ruleset_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reasons array and incidences back-compat alias are populated for flagged rows', () => {
    const s = ship({ description: 'armas ilegales' });
    const out = scoreManifest([s], {}, { prohibitedKeywords: ['armas'] });
    expect(out[0].reasons.length).toBeGreaterThan(0);
    expect(out[0].incidences).toEqual(out[0].reasons.map((r) => r.detail));
  });

  // ─── F13: cross-row $2,500 aggregate by consignee ──────────────────────────
  it('two same-RFC rows at $2,499 each land amarillo with agregado reason', () => {
    const sameRfc = 'PERJ800101AA8';
    const ships = [
      ship({ consignee: { name: 'Ana', rfc: sameRfc, address: 'Calle A' }, customsValueUsd: 2499 }),
      ship({ consignee: { name: 'Ana', rfc: sameRfc, address: 'Calle A' }, customsValueUsd: 2499 }),
    ];
    const out = scoreManifest(ships, {});
    // Both rows share the same entity key → total $4,998 → agregado fires
    expect(out[0].reasons.some((r) => r.signalId === 'agregado')).toBe(true);
    expect(out[1].reasons.some((r) => r.signalId === 'agregado')).toBe(true);
    // Neither row triggers per-row monto (each is ≤ $2,500), but aggregate fires
    // Split score ≈ 30/248×100 ≈ 12.1 → lands in amarillo [10, 15)
    expect(out[0].band).toBe('amarillo');
    expect(out[1].band).toBe('amarillo');
  });

  it('two different-RFC rows at $2,499 each stay verde (no cross-entity aggregation)', () => {
    // Use two RFCs that both pass checksum validation so no id signal fires
    const ships = [
      ship({ consignee: { name: 'Ana', rfc: 'ADM130509UQ0', address: 'Calle A' }, customsValueUsd: 2499 }),
      ship({ consignee: { name: 'Bob', rfc: 'GUMM710831UYA', address: 'Calle B' }, customsValueUsd: 2499 }),
    ];
    const out = scoreManifest(ships, {});
    expect(out[0].reasons.every((r) => r.signalId !== 'agregado')).toBe(true);
    expect(out[1].reasons.every((r) => r.signalId !== 'agregado')).toBe(true);
    expect(out[0].band).toBe('verde');
    expect(out[1].band).toBe('verde');
  });
});
