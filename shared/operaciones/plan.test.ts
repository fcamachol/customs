import { describe, expect, it } from 'vitest';
import { diffPlan, resumenDiff, type PlanSnapshot } from './plan';

/**
 * R19 / P4 — the plan is a living document and every version after the first ships with its delta.
 *
 * What matters here is what the warehouse and the transportista actually need told:
 *   - a unit added or withdrawn;
 *   - a unit whose CARRIER or PLATES changed, because somebody has to be at the gate to meet it;
 *   - guías added to or removed from a load — the most consequential change and the one a generic
 *     "modified" flag would bury;
 *   - a changed `ordenCarga`, because the warehouse re-stacks on that number alone (R14);
 *   - the difference between "first plan of the day" and "a plan that replaced every unit", which an
 *     all-additions diff cannot express on its own.
 */
function snapshot(over: Partial<PlanSnapshot> = {}): PlanSnapshot {
  return {
    fechaOperacion: '2026-08-14',
    generadoAt: '2026-08-13T20:00:00.000Z',
    despachos: [],
    exclusiones: [],
    ...over,
  };
}

const despachoBase = {
  folio: 'D-20260814-001',
  tipoUnidad: 'tracto',
  transportista: 'Transportes del Bajío',
  placas: 'ABC1234',
  operadorNombre: 'J. Pérez',
  destino: 'IMILE Cuautitlán',
  estado: 'planeado',
  citaAt: '2026-08-14T16:00:00.000Z',
  partidas: [
    { guia: 'AAA0001', mawb: '160-11111111', cliente: 'ACME', cartones: 10, piezas: 100, ordenCarga: 1 },
    { guia: 'AAA0002', mawb: '160-11111111', cliente: 'ACME', cartones: 5, piezas: 50, ordenCarga: 2 },
  ],
};

describe('diffPlan', () => {
  it('marks the first published version of a date as such, not merely as all-additions', () => {
    const d = diffPlan(null, snapshot({ despachos: [despachoBase] }));
    expect(d.esPrimeraVersion).toBe(true);
    expect(d.despachosAgregados).toEqual(['D-20260814-001']);
    expect(d.sinCambios).toBe(false);
    expect(resumenDiff(d)).toContain('Plan inicial');
  });

  it('reports no changes when the document is identical', () => {
    const s = snapshot({ despachos: [despachoBase] });
    const d = diffPlan(s, { ...s, generadoAt: '2026-08-13T21:00:00.000Z' });
    expect(d.sinCambios).toBe(true);
    expect(resumenDiff(d)).toBe('Sin cambios respecto de la versión anterior.');
  });

  it('names units added and withdrawn', () => {
    const antes = snapshot({ despachos: [despachoBase] });
    const ahora = snapshot({
      despachos: [{ ...despachoBase, folio: 'D-20260814-002' }],
    });
    const d = diffPlan(antes, ahora);
    expect(d.despachosAgregados).toEqual(['D-20260814-002']);
    expect(d.despachosRetirados).toEqual(['D-20260814-001']);
    expect(d.despachosModificados).toEqual([]);
  });

  it('reports a changed carrier and plates field by field, with both values', () => {
    const antes = snapshot({ despachos: [despachoBase] });
    const ahora = snapshot({
      despachos: [{ ...despachoBase, transportista: 'Fletes del Norte', placas: 'XYZ9876' }],
    });
    const d = diffPlan(antes, ahora);
    expect(d.despachosModificados).toHaveLength(1);
    expect(d.despachosModificados[0].cambios.transportista).toEqual({
      antes: 'Transportes del Bajío',
      despues: 'Fletes del Norte',
    });
    expect(d.despachosModificados[0].cambios.placas.despues).toBe('XYZ9876');
  });

  it('keeps guías added and removed separate from the field changes', () => {
    const antes = snapshot({ despachos: [despachoBase] });
    const ahora = snapshot({
      despachos: [
        {
          ...despachoBase,
          partidas: [
            despachoBase.partidas[0],
            { guia: 'BBB0001', mawb: '160-22222222', cliente: 'Otro', cartones: 3, piezas: 30, ordenCarga: 2 },
          ],
        },
      ],
    });
    const d = diffPlan(antes, ahora);
    const m = d.despachosModificados[0];
    expect(m.partidasAgregadas).toEqual(['BBB0001']);
    expect(m.partidasRetiradas).toEqual(['AAA0002']);
    expect(m.cambios).toEqual({});
  });

  it('flags a changed loading consecutive on its own — the warehouse re-stacks on that number', () => {
    const antes = snapshot({ despachos: [despachoBase] });
    const ahora = snapshot({
      despachos: [
        {
          ...despachoBase,
          partidas: [
            { ...despachoBase.partidas[0], ordenCarga: 2 },
            { ...despachoBase.partidas[1], ordenCarga: 1 },
          ],
        },
      ],
    });
    const d = diffPlan(antes, ahora);
    expect(d.despachosModificados[0].ordenCargaCambiada).toEqual([
      { guia: 'AAA0001', antes: 1, despues: 2 },
      { guia: 'AAA0002', antes: 2, despues: 1 },
    ]);
  });

  it('tracks exclusions appearing and being resolved, with their cause', () => {
    const antes = snapshot({
      despachos: [despachoBase],
      exclusiones: [{ mawb: '160-99999999', guia: null, causa: 'hold_activo', detalle: 'csa: falta cesión' }],
    });
    const ahora = snapshot({
      despachos: [despachoBase],
      exclusiones: [{ mawb: '160-88888888', guia: 'CCC0001', causa: 'guia_no_transmitida', detalle: null }],
    });
    const d = diffPlan(antes, ahora);
    expect(d.exclusionesAgregadas).toHaveLength(1);
    expect(d.exclusionesAgregadas[0].causa).toBe('guia_no_transmitida');
    expect(d.exclusionesResueltas).toHaveLength(1);
    expect(d.exclusionesResueltas[0].mawb).toBe('160-99999999');
    expect(d.sinCambios).toBe(false);
  });

  it('does not report a modification for a unit whose only change is a field nobody is told about', () => {
    // `generadoAt` moves on every read; comparing it would make every republication look like news.
    const antes = snapshot({ despachos: [despachoBase] });
    const ahora = snapshot({ despachos: [despachoBase], generadoAt: '2026-08-13T23:59:00.000Z' });
    expect(diffPlan(antes, ahora).sinCambios).toBe(true);
  });

  it('summarises a mixed change in one line', () => {
    const antes = snapshot({ despachos: [despachoBase] });
    const ahora = snapshot({
      despachos: [
        { ...despachoBase, placas: 'XYZ9876' },
        { ...despachoBase, folio: 'D-20260814-002', partidas: [] },
      ],
    });
    const resumen = resumenDiff(diffPlan(antes, ahora));
    expect(resumen).toContain('1 unidad(es) agregada(s)');
    expect(resumen).toContain('1 modificada(s)');
  });
});
