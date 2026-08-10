import { describe, expect, it } from 'vitest';
import {
  POD_COLUMNAS_PARTIDA,
  POD_LAYOUT_VERSION,
  construirPod,
  filasPod,
  type PodEntrada,
} from './pod';

/**
 * The POD is evidence, so the two things pinned here are the two ways a document that is evidence
 * goes wrong: it stops being reproducible, or it starts asserting something nobody declared.
 */
const base: PodEntrada = {
  folio: 'POD-D-20260814-003',
  despachoFolio: 'D-20260814-003',
  fechaOperacion: '2026-08-14',
  tipoUnidad: 'tracto',
  tipoUnidadLabel: 'Tracto',
  transportista: 'Transportes del Bajío',
  placas: 'ABC1234',
  operadorNombre: 'Juan Pérez',
  destinoAlias: 'IMILE Cuautitlán',
  destinoDireccion: 'Parque Logístico 12',
  salidaAt: '2026-08-14T18:00:00.000Z',
  etaCalculado: '2026-08-14T20:00:00.000Z',
  arriboReal: '2026-08-14T20:35:00.000Z',
  observaciones: null,
  generadoAt: '2026-08-14T17:00:00.000Z',
  version: 1,
  partidas: [
    {
      guia: 'AAA0002', mawb: '160-11111111', cliente: 'ACME', pedimento: null,
      cartonesPlaneados: 5, cartonesCargados: 5, piezas: 50, ordenCarga: 2,
    },
    {
      guia: 'AAA0001', mawb: '160-11111111', cliente: 'ACME', pedimento: '26 43 3789 6000123',
      cartonesPlaneados: 10, cartonesCargados: 9, piezas: 100, ordenCarga: 1,
    },
  ],
};

describe('construirPod', () => {
  it('orders the load by orden_carga — the warehouse stages by that consecutive (R14)', () => {
    const snap = construirPod(base);
    expect(snap.partidas.map((p) => p.guia)).toEqual(['AAA0001', 'AAA0002']);
  });

  it('totals what was planned and what was actually loaded, separately', () => {
    const snap = construirPod(base);
    expect(snap.totales).toEqual({
      guias: 2,
      cartonesPlaneados: 15,
      cartonesCargados: 14,
      piezas: 150,
    });
  });

  it('reports an undeclared quantity as null, never as zero', () => {
    const snap = construirPod({
      ...base,
      partidas: base.partidas.map((p) => ({ ...p, piezas: null })),
    });
    // A signed sheet saying "0 pieces" would assert that nothing travelled — and R43 would then
    // multiply that zero by the tariff.
    expect(snap.totales.piezas).toBeNull();
    expect(snap.totales.cartonesCargados).toBe(14);
  });

  it('stamps the layout version so a historical POD still explains itself', () => {
    expect(construirPod(base).layoutVersion).toBe(POD_LAYOUT_VERSION);
  });

  it('is deterministic: same input, same document', () => {
    expect(filasPod(construirPod(base))).toEqual(filasPod(construirPod(base)));
  });
});

describe('filasPod', () => {
  const filas = filasPod(construirPod(base));

  it('prints the load table with its declared columns', () => {
    expect(filas).toContainEqual([...POD_COLUMNAS_PARTIDA]);
    const linea = filas.find((f) => f[1] === 'AAA0001');
    expect(linea).toEqual([1, 'AAA0001', '160-11111111', 'ACME', '26 43 3789 6000123', 10, 9, 100]);
  });

  it('leaves the signature block EMPTY — only the client can fill it in', () => {
    expect(filas).toContainEqual(['Nombre y firma', '']);
    expect(filas).toContainEqual(['Fecha y hora de recepción', '']);
  });

  it('names the folio of the trip it belongs to', () => {
    expect(filas[1]).toEqual(['Folio POD', 'POD-D-20260814-003', '', 'Versión', 1]);
  });
});
