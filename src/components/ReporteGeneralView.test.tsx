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

/**
 * Mocks two records, rA and rB. rA's detail fetch stays pending until `resolveA()` is called;
 * rB's detail fetch resolves immediately. Lets a test simulate clicking A then B before A's
 * response lands.
 */
function mockApiRace() {
  let resolveA: (value: unknown) => void = () => {};
  const detailAPromise = new Promise((resolve) => { resolveA = resolve; });
  const detailA = { id: 'rA', clientId: 'cl1', platformId: 'p2', pedimentos: [{ id: 'ped-A', numeroPedimento: '999' }] };
  const detailB = { id: 'rB', clientId: 'cl1', platformId: 'p1', pedimentos: [{ id: 'ped-B', numeroPedimento: '222' }] };
  (apiGet as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
    if (path === '/api/catalogs/clients') return Promise.resolve(CLIENTS);
    if (path.startsWith('/api/records?q=')) return Promise.resolve([
      { id: 'rA', mawbReference: 'AAA-1', clientName: 'ACME', createdAt: '2026-06-23' },
      { id: 'rB', mawbReference: 'BBB-1', clientName: 'ACME', createdAt: '2026-06-24' },
    ]);
    if (path === '/api/records/rA') return detailAPromise;
    if (path === '/api/records/rB') return Promise.resolve(detailB);
    return Promise.resolve([]);
  });
  (apiPost as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
  (apiDownload as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  return { resolveA: () => resolveA(detailA) };
}

describe('ReporteGeneralView stale-fetch guard', () => {
  it('discards a stale record-detail response when a different record was selected meanwhile', async () => {
    const { resolveA } = mockApiRace();
    render(<ReporteGeneralView />);

    fireEvent.change(screen.getByPlaceholderText(/Buscar registro/i), { target: { value: 'A' } });
    fireEvent.click(screen.getByRole('button', { name: /Buscar/i }));
    await waitFor(() => screen.getByText(/AAA-1/));

    fireEvent.click(screen.getByText(/AAA-1/)); // selects rA; its detail fetch is left pending
    fireEvent.click(screen.getByText(/BBB-1/)); // selects rB; its detail fetch resolves right away

    await waitFor(() => screen.getByText(/Plataforma: Shop A/)); // rB's association is shown

    // rA's stale response lands after rB was already selected — must be discarded, not applied.
    resolveA();
    await waitFor(() => screen.getByText(/Plataforma: Shop A/));
    expect(screen.queryByText(/Plataforma: Shop B/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Generar/i }));
    await waitFor(() => expect(apiDownload).toHaveBeenCalledWith('/api/pedimentos/ped-B/report.xlsx', 'Reporte_General_222.xlsx'));
    expect(apiDownload).not.toHaveBeenCalledWith('/api/pedimentos/ped-A/report.xlsx', 'Reporte_General_999.xlsx');
  });
});

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
