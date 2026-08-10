// src/components/TrazabilidadView.test.tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import TrazabilidadView from './TrazabilidadView';

/**
 * What this view has to say out loud, in both directions:
 *  - given a carrier: every PACKAGE it took, so the multi-client truck (R29) reads as two clients on
 *    one folio and not as one opaque trip.
 *  - given a guía: who took it, on which plates — and, when the unit was shared, how much of the
 *    load was somebody else's.
 */

const transportistas = [
  { id: 't-1', razonSocial: 'Transportes del Bajío', estado: 'activo', unidadesActivas: 3, convenioVigente: true },
  { id: 't-2', razonSocial: 'Fletes del Norte', estado: 'activo', unidadesActivas: 1, convenioVigente: false },
];

const paquetes = {
  transportistaId: 't-1',
  transportista: 'Transportes del Bajío',
  filtros: { desde: null, hasta: null, estado: null },
  totales: { despachos: 1, paquetes: 2, piezas: 120, cartonesPlaneados: 12, cartonesCargados: 8 },
  paquetes: [
    {
      partidaId: 'p-1', despachoId: 'd-1', folio: 'D-20260814-001', fechaOperacion: '2026-08-14',
      estado: 'cargado', tipoUnidad: 'tracto', tipoUnidadLabel: 'Tracto', placas: 'ABC1234',
      operadorNombre: 'Juan Pérez', destino: 'IMILE Cuautitlán', salidaAt: null, arriboReal: null,
      operacionId: 'op-a', mawb: '160-11111111', guia: 'AAA0001', guiaEstado: 'declarada',
      cliente: 'ACME', piezas: 100, cartonesPlaneados: 10, cartonesCargados: 8, ordenCarga: 1,
    },
    {
      partidaId: 'p-2', despachoId: 'd-1', folio: 'D-20260814-001', fechaOperacion: '2026-08-14',
      estado: 'cargado', tipoUnidad: 'tracto', tipoUnidadLabel: 'Tracto', placas: 'ABC1234',
      operadorNombre: 'Juan Pérez', destino: 'IMILE Cuautitlán', salidaAt: null, arriboReal: null,
      operacionId: 'op-b', mawb: '160-22222222', guia: 'BBB0001', guiaEstado: 'declarada',
      cliente: 'BIMBO', piezas: 20, cartonesPlaneados: 2, cartonesCargados: null, ordenCarga: 2,
    },
  ],
};

const vacio = {
  transportistaId: 't-2',
  transportista: 'Fletes del Norte',
  filtros: { desde: null, hasta: null, estado: null },
  totales: { despachos: 0, paquetes: 0, piezas: 0, cartonesPlaneados: 0, cartonesCargados: 0 },
  paquetes: [],
};

const casos = [
  { id: 'op-b', mawb: '160-22222222', clienteNombre: 'BIMBO', numeroVuelo: 'CX3186', etapa: 'disponible', holdActivo: false },
];

const despachosDelCaso = {
  operacionId: 'op-b',
  mawb: '160-22222222',
  totales: { despachos: 1, transportistas: 1, partidas: 1 },
  despachos: [
    {
      id: 'd-1', folio: 'D-20260814-001', fechaOperacion: '2026-08-14', estado: 'cargado',
      tipoUnidad: 'tracto', tipoUnidadLabel: 'Tracto', transportistaId: 't-1',
      transportista: 'Transportes del Bajío', placas: 'ABC1234', operadorNombre: 'Juan Pérez',
      destino: 'IMILE Cuautitlán', citaAt: null, salidaAt: null, etaCalculado: null,
      arriboReal: null, desviacionArriboMin: null, partidasTotales: 2,
      partidas: [
        {
          id: 'p-2', guia: 'BBB0001', guiaEstado: 'declarada', cliente: 'BIMBO',
          piezas: 20, cartonesPlaneados: 2, cartonesCargados: null, ordenCarga: 2,
        },
      ],
    },
  ],
};

const apiGetMock = vi.fn(async (url: string): Promise<unknown> => {
  if (url === '/api/transportistas') return transportistas;
  if (url.startsWith('/api/transportistas/t-1/paquetes')) return paquetes;
  if (url.startsWith('/api/transportistas/t-2/paquetes')) return vacio;
  if (url.startsWith('/api/operaciones/op-b/despachos')) return despachosDelCaso;
  if (url.startsWith('/api/operaciones?')) return casos;
  throw new Error(`unexpected url: ${url}`);
});

vi.mock('../api', () => ({ apiGet: (url: string) => apiGetMock(url) }));

describe('TrazabilidadView', () => {
  beforeEach(() => vi.clearAllMocks());

  it('asks for a carrier before showing anything', async () => {
    render(<TrazabilidadView />);
    await waitFor(() => expect(screen.getByText('Elige un transportista')).toBeTruthy());
    expect(apiGetMock).toHaveBeenCalledWith('/api/transportistas');
  });

  it('shows every package a carrier took, with guía, cliente and cartones cargados/planeados', async () => {
    render(<TrazabilidadView />);
    await waitFor(() => expect(screen.getByRole('option', { name: 'Transportes del Bajío' })).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Transportista'), { target: { value: 't-1' } });

    await waitFor(() => expect(screen.getAllByText('D-20260814-001').length).toBeGreaterThan(0));
    expect(screen.getByText('AAA0001')).toBeTruthy();
    expect(screen.getByText('160-11111111')).toBeTruthy();
    expect(screen.getByText('ACME')).toBeTruthy();
    // The multi-client truck: one folio, two clients, two guías máster.
    expect(screen.getByText('BIMBO')).toBeTruthy();
    expect(screen.getByText('160-22222222')).toBeTruthy();
    expect(screen.getAllByText('D-20260814-001')).toHaveLength(2);
    // Totals row: 1 despacho, 2 paquetes.
    expect(screen.getByText('Despachos')).toBeTruthy();
    expect(screen.getByText('Paquetes')).toBeTruthy();
  });

  it('passes the date range and estado filters through to the API', async () => {
    render(<TrazabilidadView />);
    await waitFor(() => expect(screen.getByRole('option', { name: 'Transportes del Bajío' })).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Transportista'), { target: { value: 't-1' } });
    await waitFor(() => expect(screen.getByText('AAA0001')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('Desde'), { target: { value: '2026-08-01' } });
    fireEvent.change(screen.getByLabelText('Filtrar por estado del despacho'), { target: { value: 'cargado' } });

    await waitFor(() =>
      expect(apiGetMock).toHaveBeenCalledWith('/api/transportistas/t-1/paquetes?desde=2026-08-01&estado=cargado'),
    );
  });

  it('says plainly when a carrier took nothing, instead of showing an empty table', async () => {
    render(<TrazabilidadView />);
    await waitFor(() => expect(screen.getByRole('option', { name: 'Fletes del Norte' })).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Transportista'), { target: { value: 't-2' } });
    await waitFor(() => expect(screen.getByText('Sin paquetes de Fletes del Norte')).toBeTruthy());
  });

  it('answers the reverse question: given a guía, which carrier and which plates took it', async () => {
    render(<TrazabilidadView />);
    fireEvent.click(screen.getByRole('button', { name: 'Por guía' }));
    fireEvent.change(screen.getByLabelText('Buscar por guía máster o vuelo'), { target: { value: '160-22222222' } });

    await waitFor(() => expect(screen.getByText('160-22222222')).toBeTruthy());
    fireEvent.click(screen.getByText('160-22222222'));

    await waitFor(() => expect(screen.getByText('Transportes del Bajío')).toBeTruthy());
    expect(screen.getByText('ABC1234')).toBeTruthy();
    expect(screen.getByText('D-20260814-001')).toBeTruthy();
    expect(screen.getByText('BBB0001')).toBeTruthy();
    // R29: the rest of the truck is stated, not implied.
    expect(screen.getByText(/Viaje compartido/)).toBeTruthy();
  });
});
