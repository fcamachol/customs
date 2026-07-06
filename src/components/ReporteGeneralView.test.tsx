import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ReporteGeneralView from './ReporteGeneralView';
import { apiGet, apiPost, apiDownload } from '../api';

vi.mock('../api', () => ({ apiGet: vi.fn(), apiPost: vi.fn(), apiDownload: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

const CLIENTS = [
  { id: 'cl1', name: 'ACME', platforms: [{ id: 'p1', commercialName: 'Shop A' }, { id: 'p2', commercialName: 'Shop B' }] },
];

/** Mock the three GETs; `detail` controls the association returned for record m1. */
function mockApi(detail: { clientId: string | null; platformId: string | null }) {
  (apiGet as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
    if (path === '/api/catalogs/clients') return Promise.resolve(CLIENTS);
    if (path.startsWith('/api/records?q=')) return Promise.resolve([
      { id: 'm1', mawbReference: '369-1', clientName: 'ACME', createdAt: '2026-06-23' },
    ]);
    if (path === '/api/records/m1') return Promise.resolve({
      id: 'm1', ...detail, pedimentos: [{ id: 'ped-1', numeroPedimento: '111' }],
    });
    return Promise.resolve([]);
  });
  (apiPost as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
  (apiDownload as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
}

/** Search for the seeded record and select it. */
async function searchAndSelect() {
  fireEvent.change(screen.getByPlaceholderText(/Buscar registro/i), { target: { value: '369' } });
  fireEvent.click(screen.getByRole('button', { name: /Buscar/i }));
  await waitFor(() => screen.getByText(/369-1/));
  fireEvent.click(screen.getByText(/369-1/));
}

/** Open a SearchSelect by focusing its input, then pick an option by label. */
async function pickOption(placeholder: string, optionLabel: string) {
  const input = await screen.findByPlaceholderText(placeholder);
  fireEvent.focus(input);
  const optionBtn = await screen.findByRole('button', { name: optionLabel });
  fireEvent.click(optionBtn);
}

describe('ReporteGeneralView one-click generation', () => {
  it('pre-associated manifest: shows the summary and downloads without re-binding', async () => {
    mockApi({ clientId: 'cl1', platformId: 'p2' });
    render(<ReporteGeneralView />);
    await searchAndSelect();

    // Association is shown read-only (no dropdowns) with a Cambiar affordance
    await waitFor(() => screen.getByText(/Cliente: ACME/));
    expect(screen.getByText(/Plataforma: Shop B/)).toBeTruthy();
    expect(screen.queryByPlaceholderText('Selecciona un cliente…')).toBeNull();
    expect(screen.getByRole('button', { name: /Cambiar/i })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Generar/i }));
    await waitFor(() => expect(apiDownload).toHaveBeenCalledWith('/api/pedimentos/ped-1/report.xlsx', 'Reporte_General_111.xlsx'));
    // Unchanged association → no bind POST
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('unassociated manifest: pre-selects the client by name, binds on generate', async () => {
    mockApi({ clientId: null, platformId: null });
    render(<ReporteGeneralView />);
    await searchAndSelect();

    // Dropdowns visible; client pre-matched by name so the platform select is already unlocked
    await pickOption('Selecciona una plataforma…', 'Shop B');

    fireEvent.click(screen.getByRole('button', { name: /Generar/i }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/api/manifests/m1/client', { clientId: 'cl1', platformId: 'p2' }));
    await waitFor(() => expect(apiDownload).toHaveBeenCalledWith('/api/pedimentos/ped-1/report.xlsx', 'Reporte_General_111.xlsx'));
  });

  it('no longer renders the manual Remitente/Plataforma forms', async () => {
    mockApi({ clientId: null, platformId: null });
    render(<ReporteGeneralView />);
    expect(screen.queryByText('Datos del Remitente')).toBeNull();
    expect(screen.queryByText('Datos de la Plataforma')).toBeNull();
  });
});
