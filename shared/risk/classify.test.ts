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

function ship(over: Partial<Shipment>): Shipment {
  return {
    id: Math.random().toString(), mawbReference: 'M', description: 'camisa',
    hsCode: '9901000100', quantity: 1, unit: 'PCE', customsValueUsd: 100, currency: 'USD',
    originCountry: 'CN', guideId: 'g',
    consignee: { name: 'Ana', rfc: 'PERJ800101AAA', address: 'Calle 1' },
    sender: { name: 'S' }, platform: { commercialName: 'P' }, ...over,
  } as Shipment;
}

describe('scoreManifest', () => {
  it('builds context across shipments and scores each', () => {
    const ships = [
      ship({ consignee: { name: 'Ana', rfc: 'PERJ800101AAA', address: 'Calle 1' } }),
      ship({ consignee: { name: 'Ana', rfc: 'PERJ800101AAA', address: 'Calle 1' } }),
    ];
    const out = scoreManifest(ships, new Set());
    expect(out[0].color).toBe('amarillo');
    expect(out[0].incidences).toContain('Varios paquetes por consignatario');
  });
});
