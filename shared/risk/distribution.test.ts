import { describe, expect, it } from 'vitest';
import { scoreManifest } from './classify';
import type { Shipment } from '../types/shipment';

function ship(i: number, over: Partial<Shipment>): Shipment {
  return {
    id: String(i), mawbReference: 'M', description: 'camisa', hsCode: '9901000100',
    quantity: 1, unit: 'PCE', customsValueUsd: 100, currency: 'USD', originCountry: 'CN', guideId: 'g',
    consignee: { name: `P${i}`, rfc: 'PERJ800101AA8', address: `Calle ${i}` },
    sender: { name: 'S' }, platform: { commercialName: 'P' }, ...over,
  } as Shipment;
}

describe('distribution', () => {
  it('clean shipments are verde; multi-flag shipments are rojo', () => {
    const clean = Array.from({ length: 10 }, (_, i) => ship(i, {}));
    const out = scoreManifest(clean, {});
    expect(out.every((s) => s.color === 'verde')).toBe(true);

    const dirty = scoreManifest(
      [ship(99, { quantity: 11, customsValueUsd: 5000, description: 'maquillaje Gucci', consignee: { name: 'x', rfc: 'BAD' } })],
      { x: 4 },
    );
    expect(dirty[0].color).toBe('rojo');
    expect(dirty[0].score).toBeGreaterThanOrEqual(4);
  });
});
