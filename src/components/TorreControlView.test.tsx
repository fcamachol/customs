// src/components/TorreControlView.test.tsx
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import TorreControlView from './TorreControlView';

const base = {
  mawbRaw: null, clienteNombre: 'Acme Corp', origenIata: 'HKG', destinoIata: 'NLU',
  etdOrigen: '2026-08-01T02:00:00.000Z', etaPais: '2026-08-01T10:00:00.000Z',
  cartonesPrealerta: 12, piezasPrealerta: 340, pesoKgPrealerta: 980.5,
  estadoDocumental: 'en_revision', estadoPlaneacion: 'planeado',
  vueloEtaEstimado: null, vueloArriboReal: null, prealertaVersion: 1,
};

const hold = {
  ...base, id: 'op-hold', mawb: 'H-1', numeroVuelo: 'CV900', etapa: 'documental',
  semaforo: 'red' as const, holdActivo: true, createdAt: '2026-08-01T00:00:00.000Z',
  vueloEstado: 'en_ruta', discrepanciasCount: 2,
};

const flagged = {
  ...base, id: 'op-flag', mawb: 'F-1', numeroVuelo: 'CV901', etapa: 'entregado',
  semaforo: 'green' as const, holdActivo: false, createdAt: '2026-08-02T00:00:00.000Z',
  vueloEstado: 'demorado', discrepanciasCount: 3,
};

const plain = {
  ...base, id: 'op-plain', mawb: 'P-1', numeroVuelo: 'CV902', etapa: 'documental',
  semaforo: null, holdActivo: false, createdAt: '2026-08-04T00:00:00.000Z',
  vueloEstado: 'aterrizado', discrepanciasCount: 0,
};

const arrivedToday = {
  ...base, id: 'op-cancel', mawb: 'C-1', numeroVuelo: 'CV903', etapa: 'documental',
  semaforo: 'green' as const, holdActivo: false, createdAt: '2026-08-03T00:00:00.000Z',
  vueloEstado: 'cancelado', discrepanciasCount: 0, vueloArriboReal: new Date().toISOString(),
};

const allOps = [hold, flagged, plain, arrivedToday];

const apiGetMock = vi.fn(async (_url: string) => allOps);

vi.mock('../api', () => ({
  apiGet: (url: string) => apiGetMock(url),
}));

describe('TorreControlView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiGetMock.mockImplementation(async () => allOps);
  });
  afterEach(() => vi.useRealTimers());

  it('renders KPIs computed from the operaciones data', async () => {
    render(<TorreControlView />);
    await waitFor(() => expect(screen.getByText('H-1')).toBeTruthy());

    // Operaciones activas: etapa not in entregado/cerrada/cancelada → hold, plain, arrivedToday = 3
    expect(screen.getByText('Operaciones activas').nextSibling?.textContent).toBe('3');
    // En vuelo: vueloEstado en_ruta → 1
    expect(screen.getByText('En vuelo').nextSibling?.textContent).toBe('1');
    // Arribadas hoy: vueloArriboReal today → 1
    expect(screen.getByText('Arribadas hoy').nextSibling?.textContent).toBe('1');
    // Con banderas: discrepanciasCount > 0 → hold, flagged = 2
    expect(screen.getByText('Con banderas').nextSibling?.textContent).toBe('2');
    // Demoradas / canceladas: vueloEstado in demorado|cancelado → flagged, arrivedToday = 2
    expect(screen.getByText('Demoradas / canceladas').nextSibling?.textContent).toBe('2');
  });

  it('shows the hold banner only when a row has holdActivo', async () => {
    render(<TorreControlView />);
    await waitFor(() => expect(screen.getByText('H-1')).toBeTruthy());
    expect(screen.getByText(/OPERACIÓN EN HOLD/i)).toBeTruthy();
  });

  it('does not show the hold banner when no row has holdActivo', async () => {
    apiGetMock.mockImplementation(async () => [flagged, plain]);
    render(<TorreControlView />);
    await waitFor(() => expect(screen.getByText('F-1')).toBeTruthy());
    expect(screen.queryByText(/OPERACIÓN EN HOLD/i)).toBeNull();
  });

  it('orders rows: hold first, then discrepancias desc, then createdAt desc', async () => {
    const { container } = render(<TorreControlView />);
    await waitFor(() => expect(screen.getByText('H-1')).toBeTruthy());

    const rows = container.querySelectorAll('tbody tr');
    const mawbOfRow = (i: number) => rows[i].querySelector('.font-mono')?.textContent?.trim().replace(/Hold$/, '');
    expect(mawbOfRow(0)).toBe('H-1');
    expect(mawbOfRow(1)).toBe('F-1');
    expect(mawbOfRow(2)).toBe('P-1');
    expect(mawbOfRow(3)).toBe('C-1');
  });

  it('shows the semáforo verbatim in English (green/red), never translated', async () => {
    render(<TorreControlView />);
    await waitFor(() => expect(screen.getByText('H-1')).toBeTruthy());
    expect(screen.getByText('red')).toBeTruthy();
    expect(screen.getAllByText('green').length).toBeGreaterThan(0);
  });

  it('renders vuelo estado chips for each state', async () => {
    render(<TorreControlView />);
    await waitFor(() => expect(screen.getByText('H-1')).toBeTruthy());
    expect(screen.getByText('En ruta')).toBeTruthy();
    expect(screen.getByText('Demorado')).toBeTruthy();
    expect(screen.getByText('Aterrizado')).toBeTruthy();
    expect(screen.getByText('Cancelado')).toBeTruthy();
  });

  it('shows "Sin verificar" for desconocido or null vuelo estado', async () => {
    apiGetMock.mockImplementation(async () => [{ ...plain, vueloEstado: null }]);
    render(<TorreControlView />);
    await waitFor(() => expect(screen.getByText('P-1')).toBeTruthy());
    expect(screen.getByText('Sin verificar')).toBeTruthy();
  });

  it('renders an empty state when there are no operaciones', async () => {
    apiGetMock.mockImplementation(async () => []);
    render(<TorreControlView />);
    await waitFor(() => expect(screen.getByText('Sin operaciones activas')).toBeTruthy());
  });

  it('polls every 30s and stops polling after unmount', async () => {
    vi.useFakeTimers();
    const { unmount } = render(<TorreControlView />);

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(apiGetMock).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(apiGetMock).toHaveBeenCalledTimes(2);

    unmount();

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(apiGetMock).toHaveBeenCalledTimes(2);
  });
});
