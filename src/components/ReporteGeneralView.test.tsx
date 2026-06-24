import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ReporteGeneralView from './ReporteGeneralView';
import { apiGet, apiPost, apiDownload } from '../api';

vi.mock('../api', () => ({ apiGet: vi.fn(), apiPost: vi.fn(), apiDownload: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

/** Helper: open a SearchSelect by focusing its input, then pick an option by label. */
async function pickOption(placeholder: string, optionLabel: string) {
  const input = await screen.findByPlaceholderText(placeholder);
  fireEvent.focus(input);
  // Wait for the listbox to appear and find the option button by label text
  const optionBtn = await screen.findByRole('button', { name: optionLabel });
  fireEvent.click(optionBtn);
}

describe('ReporteGeneralView cascading client→platform combobox', () => {
  it('binds the selected client and platform on generate', async () => {
    (apiGet as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
      if (path === '/api/catalogs/clients') return Promise.resolve([
        { id: 'cl1', name: 'ACME', platforms: [{ id: 'p1', commercialName: 'Shop A' }, { id: 'p2', commercialName: 'Shop B' }] },
      ]);
      if (path.startsWith('/api/records?q=')) return Promise.resolve([{ id: 'm1', mawbReference: '369-1', clientName: 'ACME', createdAt: '2026-06-23' }]);
      // After binding, the view fetches the record detail to resolve its pedimentos.
      if (path === '/api/records/m1') return Promise.resolve({ id: 'm1', pedimentos: [{ id: 'ped-1', numeroPedimento: '111' }] });
      return Promise.resolve([]);
    });
    (apiPost as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    (apiDownload as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    render(<ReporteGeneralView />);

    // Search and select a manifest record
    fireEvent.change(screen.getByPlaceholderText(/Buscar registro/i), { target: { value: '369' } });
    fireEvent.click(screen.getByRole('button', { name: /Buscar/i }));
    await waitFor(() => screen.getByText(/369-1/));
    fireEvent.click(screen.getByText(/369-1/));

    // Select client via SearchSelect combobox
    await pickOption('Selecciona un cliente…', 'ACME');

    // Select platform via SearchSelect combobox (now unlocked with ACME's platforms)
    await pickOption('Selecciona una plataforma…', 'Shop B');

    // Generate report — should POST bind endpoint then download each pedimento's report.xlsx
    fireEvent.click(screen.getByRole('button', { name: /Generar/i }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/api/manifests/m1/client', { clientId: 'cl1', platformId: 'p2' }));
    await waitFor(() => expect(apiDownload).toHaveBeenCalledWith('/api/pedimentos/ped-1/report.xlsx', 'Reporte_General_111.xlsx'));
  });
});
