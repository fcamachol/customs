import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { PanelRrna } from './PanelRrna';

/**
 * El catálogo de RRNA es por palabra clave y produce falsos positivos previsibles. Estas pruebas
 * fijan las tres cosas que impiden que la pantalla lo presente como un veredicto.
 */
vi.mock('../api', () => ({ apiGet: vi.fn() }));

const COINCIDENCIA = {
  categoria: 'COFEPRIS_COSMETICS', label: 'Cosmético / Higiene', autoridad: 'COFEPRIS',
  descripcion: 'Requiere registro sanitario.', termino: 'perfume',
};

function respuesta(over: Record<string, unknown> = {}) {
  return {
    analizadas: 10, marcadas: 1,
    porCategoria: { COFEPRIS_COSMETICS: 1 },
    aviso: 'Coincidencias por palabra clave. Son indicios para revisar, no determinaciones.',
    filas: [{
      shipmentId: 's1', guia: 'HX001', descripcion: 'Pulverizador de perfume',
      hsCode: '33030001', valorDeclarado: 12, rrnaNoteDeclarada: null,
      coincidencias: [COINCIDENCIA],
    }],
    ...over,
  };
}

async function montar(r: unknown) {
  const { apiGet } = await import('../api');
  vi.mocked(apiGet).mockResolvedValue(r as never);
  return render(<PanelRrna manifestId="m1" />);
}

beforeEach(() => vi.clearAllMocks());

describe('PanelRrna', () => {
  it('sin coincidencias no dibuja nada', async () => {
    // Un panel que dice "0 hallazgos" en cada manifiesto entrena a saltárselo, y entonces no sirve
    // el día que sí trae algo.
    const { container } = await montar(respuesta({ marcadas: 0, filas: [], porCategoria: {} }));
    await waitFor(() => expect(container.textContent).toBe(''));
  });

  it('si la consulta falla, tampoco: no rompe la pantalla de riesgo', async () => {
    const { apiGet } = await import('../api');
    vi.mocked(apiGet).mockRejectedValue(new Error('boom'));
    const { container } = render(<PanelRrna manifestId="m1" />);
    await waitFor(() => expect(container.textContent).toBe(''));
  });

  it('muestra el aviso de que son indicios ANTES que la tabla', async () => {
    await montar(respuesta());
    await waitFor(() => expect(screen.getByText(/Posibles regulaciones no arancelarias/)).toBeTruthy());
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText(/no determinaciones/i)).toBeTruthy();
  });

  it('muestra EL TÉRMINO que disparó cada coincidencia', async () => {
    // Sin esto, descartar un falso positivo obliga a abrir la guía.
    await montar(respuesta());
    await waitFor(() => expect(screen.getByRole('button')).toBeTruthy());
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('perfume')).toBeTruthy();
    expect(screen.getByText('COFEPRIS')).toBeTruthy();
  });

  it('muestra la nota que declaró el remitente aunque no haya coincidencia', async () => {
    await montar(respuesta({
      filas: [{
        shipmentId: 's2', guia: 'HX002', descripcion: 'Camisa', hsCode: '61091000',
        valorDeclarado: 30, rrnaNoteDeclarada: 'Permiso COFEPRIS 123', coincidencias: [],
      }],
    }));
    await waitFor(() => expect(screen.getByRole('button')).toBeTruthy());
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('Permiso COFEPRIS 123')).toBeTruthy();
  });

  it('arranca cerrado: no compite con el semáforo del motor', async () => {
    await montar(respuesta());
    await waitFor(() => expect(screen.getByText(/Posibles regulaciones/)).toBeTruthy());
    expect(screen.queryByText('perfume')).toBeNull();
  });
});
