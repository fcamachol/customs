import { describe, expect, it } from 'vitest';
import {
  calcularImporte,
  cantidadFacturable,
  desviacionTarifa,
  proponerLinea,
  resolverTarifaCliente,
  tarifaVigenteEn,
  type TarifaCliente,
} from './facturacion';

const tarifa = (over: Partial<TarifaCliente> = {}): TarifaCliente => ({
  id: 'a',
  concepto: 'Despacho aduanal T1 por pieza',
  unidad: 'pieza',
  precio: 0.05,
  moneda: 'MXN',
  vigenciaDesde: null,
  vigenciaHasta: null,
  activo: true,
  ...over,
});

describe('tarifaVigenteEn', () => {
  it('an open-ended rate is in force', () => {
    expect(tarifaVigenteEn(tarifa(), '2026-08-14')).toBe(true);
  });

  it('an expired rate stops being a price instead of becoming yesterday’s price', () => {
    expect(tarifaVigenteEn(tarifa({ vigenciaHasta: '2026-07-31' }), '2026-08-14')).toBe(false);
  });

  it('a deactivated rate never applies', () => {
    expect(tarifaVigenteEn(tarifa({ activo: false }), '2026-08-14')).toBe(false);
  });
});

describe('resolverTarifaCliente', () => {
  it('prefers the bounded window over the standing rate', () => {
    const standing = tarifa({ id: 'standing', precio: 0.05 });
    const acotada = tarifa({ id: 'acotada', precio: 0.07, vigenciaDesde: '2026-08-01' });
    const r = resolverTarifaCliente([standing, acotada], { unidad: 'pieza', fecha: '2026-08-14' });
    expect(r.tarifa?.id).toBe('acotada');
  });

  it('breaks ties by most recently agreed — NOT by cheapest (that would undercharge, R45)', () => {
    const vieja = tarifa({ id: 'vieja', precio: 0.03, vigenciaDesde: '2026-01-01' });
    const nueva = tarifa({ id: 'nueva', precio: 0.09, vigenciaDesde: '2026-08-01' });
    const r = resolverTarifaCliente([vieja, nueva], { unidad: 'pieza', fecha: '2026-08-14' });
    expect(r.tarifa?.id).toBe('nueva');
    expect(r.ambigua).toBe(true);
  });

  it('says so when the catalog is ambiguous rather than hiding the choice', () => {
    const r = resolverTarifaCliente([tarifa({ id: 'a' }), tarifa({ id: 'b' })], {
      unidad: 'pieza',
      fecha: '2026-08-14',
    });
    expect(r.ambigua).toBe(true);
    expect(r.candidatas).toHaveLength(2);
  });

  it('returns nothing when no rate is in force', () => {
    const r = resolverTarifaCliente([tarifa({ vigenciaHasta: '2026-01-01' })], {
      unidad: 'pieza',
      fecha: '2026-08-14',
    });
    expect(r.tarifa).toBeNull();
    expect(r.ambigua).toBe(false);
  });
});

describe('cantidadFacturable', () => {
  const cantidades = { piezas: 2914, cartones: 64, pesoKg: 542.86 };

  it('takes the quantity the unit actually multiplies', () => {
    expect(cantidadFacturable('pieza', cantidades)).toBe(2914);
    expect(cantidadFacturable('carton', cantidades)).toBe(64);
    expect(cantidadFacturable('kg', cantidades)).toBe(542.86);
    expect(cantidadFacturable('guia', cantidades)).toBe(1);
    expect(cantidadFacturable('despacho', cantidades)).toBe(1);
  });

  it('refuses to price an undeclared quantity — null, never zero', () => {
    expect(cantidadFacturable('pieza', { piezas: null, cartones: 64, pesoKg: null })).toBeNull();
  });
});

describe('calcularImporte', () => {
  it('lands on the centavo instead of on an IEEE-754 tail', () => {
    // 0.05 * 2914 is 145.70000000000002 in floating point.
    expect(calcularImporte(2914, 0.05)).toBe(145.7);
  });
});

describe('desviacionTarifa', () => {
  it('is signed: over-charging and under-charging are both findings (R45)', () => {
    expect(desviacionTarifa(0.07, 0.05)).toBe(0.02);
    expect(desviacionTarifa(0.03, 0.05)).toBe(-0.02);
  });

  it('is null when there is nothing contracted to compare against — the finding itself', () => {
    expect(desviacionTarifa(0.07, null)).toBeNull();
  });
});

describe('proponerLinea', () => {
  it('prices a delivered guía end to end', () => {
    const l = proponerLinea({
      tarifas: [tarifa()],
      cantidades: { piezas: 2914, cartones: 64, pesoKg: 542.86 },
      fecha: '2026-08-14',
    });
    expect(l).toMatchObject({ cantidad: 2914, precioUnitario: 0.05, importe: 145.7, advertencia: null });
  });

  it('returns a line with an advertencia rather than dropping it when there is no rate', () => {
    const l = proponerLinea({
      tarifas: [],
      cantidades: { piezas: 100, cartones: null, pesoKg: null },
      fecha: '2026-08-14',
    });
    expect(l.importe).toBeNull();
    expect(l.advertencia).toMatch(/no tiene tarifa vigente/);
  });

  it('refuses to invent the quantity when the guía does not declare it', () => {
    const l = proponerLinea({
      tarifas: [tarifa()],
      cantidades: { piezas: null, cartones: 10, pesoKg: null },
      fecha: '2026-08-14',
    });
    expect(l.cantidad).toBeNull();
    expect(l.importe).toBeNull();
    expect(l.advertencia).toMatch(/no declara la cantidad/);
  });
});
