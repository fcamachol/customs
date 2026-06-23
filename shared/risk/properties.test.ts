// shared/risk/properties.test.ts
import { describe, expect, it } from 'vitest';
import { scoreManifest } from './classify';
import type { Shipment } from '../types/shipment';

const ship = (over: Partial<Shipment> & { name: string }): Shipment => ({
  id: 'x', mawbReference: 'M', description: 'camisa', hsCode: '6109', quantity: 1, unit: 'PCE',
  customsValueUsd: 100, currency: 'USD', originCountry: 'CN', guideId: 'g',
  consignee: { name: over.name, rfc: 'PERJ800101AA8', address: 'a' },
  sender: { name: 'S' }, platform: { commercialName: 'P' }, ...over,
} as Shipment);

describe('engine properties', () => {
  it('worsening one input never lowers the score', () => {
    const base = scoreManifest([ship({ name: 'A' })], {})[0].score;
    const worse = scoreManifest([ship({ name: 'A', quantity: 50 })], {})[0].score;
    expect(worse).toBeGreaterThanOrEqual(base);
  });
  it('adding a clean unrelated row does not change another row score', () => {
    const a1 = scoreManifest([ship({ name: 'A' })], {})[0].score;
    const a2 = scoreManifest([ship({ name: 'A' }), ship({ name: 'B' })], {})[0].score;
    expect(a2).toBe(a1);
  });
  it('ruleset hash is identical across runs with same config', () => {
    const h1 = scoreManifest([ship({ name: 'A' })], {})[0].ruleset_hash;
    const h2 = scoreManifest([ship({ name: 'A' })], {})[0].ruleset_hash;
    expect(h1).toBe(h2);
  });
});
