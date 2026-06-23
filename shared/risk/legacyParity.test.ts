// shared/risk/legacyParity.test.ts
import { describe, expect, it } from 'vitest';
import { scoreLegacyParity } from './legacyParity';
import type { Shipment } from '../types/shipment';

function ship(over: Partial<Shipment> & { name: string; rfc?: string; curp?: string; address?: string }): Shipment {
  const { name, rfc, curp, address, ...rest } = over;
  return {
    id: 'x', mawbReference: 'M', description: 'camisa', hsCode: '6109',
    quantity: 1, unit: 'PCE', customsValueUsd: 100, currency: 'USD', originCountry: 'CN', guideId: 'g',
    consignee: { name, rfc: rfc ?? '', curp, address }, sender: { name: 'S' }, platform: { commercialName: 'P' },
    ...rest,
  } as Shipment;
}

describe('legacy parity (reproduces Risk analysis 17 feb 25.xlsx)', () => {
  it('ID fires unless length is exactly 13 or 18', () => {
    const rows = scoreLegacyParity([
      ship({ name: 'A', rfc: 'PERJ800101AA8' }),          // len 13 -> ok
      ship({ name: 'B', curp: 'AERA790828HBSRBR04' }),     // len 18 -> ok
      ship({ name: 'C', rfc: 'SHORT' }),                   // len 5 -> fires
    ], new Set());
    expect(rows[0].incidences).not.toContain('Falta RFC/CURP');
    expect(rows[1].incidences).not.toContain('Falta RFC/CURP');
    expect(rows[2].incidences).toContain('Falta RFC/CURP');
  });

  it('consignatarios fires at >=2 occurrences (COUNTIF != 1)', () => {
    const rows = scoreLegacyParity([
      ship({ name: 'Repeat', rfc: 'PERJ800101AA8', address: 'addr-a' }),
      ship({ name: 'Repeat', rfc: 'PERJ800101AA8', address: 'addr-b' }),
      ship({ name: 'Solo', rfc: 'PERJ800101AA8', address: 'addr-c' }),
    ], new Set());
    expect(rows[0].incidences).toContain('Varios paquetes por consignatario');
    expect(rows[2].incidences).not.toContain('Varios paquetes por consignatario');
  });

  it('bands: <2 Verde, 2-3 Amarillo, >=4 Rojo', () => {
    // one clean solo row -> 0 signals -> Verde
    const verde = scoreLegacyParity([ship({ name: 'Solo', rfc: 'PERJ800101AA8', address: 'u' })], new Set());
    expect(verde[0].resultado).toBe('Verde');
    // qty>10 + monto>2500 + bad id + prohibited = 4 -> Rojo
    const rojo = scoreLegacyParity([
      ship({ name: 'Solo', rfc: 'BAD', address: 'u', quantity: 11, customsValueUsd: 5000, description: 'maquillaje' }),
    ], new Set());
    expect(rojo[0].suma).toBeGreaterThanOrEqual(4);
    expect(rojo[0].resultado).toBe('Rojo');
  });

  it('bbdd fires when consignee name is present in the monthly DB', () => {
    const rows = scoreLegacyParity(
      [ship({ name: 'Known Buyer', rfc: 'PERJ800101AA8', address: 'u' })],
      new Set(['known buyer']),
    );
    expect(rows[0].incidences).toContain('Varias importaciones en el mes');
  });
});
