import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SeguimientoView from './SeguimientoView';
import { apiGet, apiPost, apiDownload } from '../api';

const records = [
  { id: 'r-pending', mawbReference: 'MAWB-PEND', clientName: 'Cliente Pendiente', createdAt: '2026-01-01', coverageStatus: 'parcial', expectedCount: 2, uploadedCount: 1 },
  { id: 'r-done', mawbReference: 'MAWB-DONE', clientName: 'Cliente Completo', createdAt: '2026-01-02', coverageStatus: 'completo', expectedCount: 1, uploadedCount: 1 },
];

// Detail now carries a manifest-level lock (gates adding pedimentos) and a pedimentos[] whose rows
// each carry their own importData / importDataVersion / lock (capture is per-pedimento now).
function makeDetail({
  manifestLock = { editable: true, reason: null },
  pedimentoLock = { editable: true, reason: null },
  importData = null as Record<string, string> | null,
  importDataVersion = 0,
}: {
  manifestLock?: { editable: boolean; reason: string | null };
  pedimentoLock?: { editable: boolean; reason: string | null };
  importData?: Record<string, string> | null;
  importDataVersion?: number;
} = {}) {
  return {
    lock: manifestLock,
    pedimentos: [
      {
        id: 'p1', numeroPedimento: '258516535001684', subdivisionOrdinal: 2, isLast: false,
        fileId: 'f1', scanVerdict: 'clean', pedimentoPdf: '/api/files/f1', coveredGuias: ['G1'],
        importData, importDataVersion, lock: pedimentoLock,
      },
    ],
  };
}

// Per-test override of the record detail (defaults to editable, no captured data).
let detail = makeDetail();

vi.mock('../api', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(() => Promise.resolve({ ok: true, version: 1, importData: {} })),
  apiDownload: vi.fn(() => Promise.resolve()),
}));

describe('SeguimientoView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    detail = makeDetail();
    vi.mocked(apiGet).mockImplementation(async (url: string) => {
      if (url.startsWith('/api/records/')) return detail;
      if (url.startsWith('/api/records')) return records;
      throw new Error('not found');
    });
  });

  it('renders the Pendientes/Completados tabs and the filter field', async () => {
    render(<SeguimientoView />);
    expect(screen.getByText('Pendientes')).toBeTruthy();
    expect(screen.getByText('Completados')).toBeTruthy();
    expect(screen.getByPlaceholderText(/Filtrar/i)).toBeTruthy();
  });

  it('splits records into tabs by coverageStatus (completo → Completados)', async () => {
    render(<SeguimientoView />);
    // Default tab is Pendientes: the parcial record shows, the completo one does not.
    expect(await screen.findByText('MAWB-PEND')).toBeTruthy();
    expect(screen.queryByText('MAWB-DONE')).toBeNull();

    fireEvent.click(screen.getByText('Completados'));
    expect(await screen.findByText('MAWB-DONE')).toBeTruthy();
    expect(screen.queryByText('MAWB-PEND')).toBeNull();
  });

  it('shows the pedimentos sub-list with a per-pedimento capture form + download named by numero', async () => {
    render(<SeguimientoView />);
    fireEvent.click(await screen.findByText('MAWB-PEND'));
    // The selected manifest's pedimentos[] is rendered with its numero + a per-row capture form.
    await waitFor(() => expect(screen.getByText('258516535001684')).toBeTruthy());
    expect(screen.getByText(/subdivisión 2/)).toBeTruthy();
    expect(screen.getByText('Agente Aduanal')).toBeTruthy();
    expect(screen.getByText('Agregar pedimento PDF')).toBeTruthy();

    // Per-pedimento download names the file by numero (matches ConsultaView).
    fireEvent.click(screen.getByRole('button', { name: 'PDF' }));
    await waitFor(() => {
      expect(apiDownload).toHaveBeenCalledWith('/api/files/f1', 'Pedimento_258516535001684.pdf');
    });
  });

  it('saves per-pedimento import-data to the pedimento-scoped endpoint with the row version', async () => {
    detail = makeDetail({ importDataVersion: 4 });
    render(<SeguimientoView />);
    fireEvent.click(await screen.findByText('MAWB-PEND'));
    await waitFor(() => expect(screen.getByText('258516535001684')).toBeTruthy());

    const patente = screen.getByLabelText('Patente') as HTMLInputElement;
    fireEvent.change(patente, { target: { value: '3250' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar datos' }));

    await waitFor(() => {
      expect(apiPost).toHaveBeenCalledWith(
        '/api/pedimentos/p1/import-data',
        expect.objectContaining({ patente: '3250', version: 4 }),
      );
    });
  });

  it('pre-fills the per-pedimento form from the row importData', async () => {
    detail = makeDetail({ importData: { patente: '9876', agenteAduanal: 'Ana López' } });
    render(<SeguimientoView />);
    fireEvent.click(await screen.findByText('MAWB-PEND'));
    await waitFor(() => expect((screen.getByLabelText('Patente') as HTMLInputElement).value).toBe('9876'));
    expect((screen.getByLabelText('Agente Aduanal') as HTMLInputElement).value).toBe('Ana López');
  });

  it('disables the per-pedimento form and hides Guardar when the row is locked', async () => {
    detail = makeDetail({ pedimentoLock: { editable: false, reason: 'Ya se adjuntó el pedimento PDF; los datos están bloqueados.' } });
    render(<SeguimientoView />);
    fireEvent.click(await screen.findByText('MAWB-PEND'));
    await waitFor(() => expect(screen.getByText('258516535001684')).toBeTruthy());
    // The lock note shows and the inputs are disabled; the save button is gone.
    expect(screen.getByText(/los datos están bloqueados/i)).toBeTruthy();
    expect((screen.getByLabelText('Patente') as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Guardar datos' })).toBeNull();
  });

  it('hides the upload zone and shows a bloqueado note when the manifest is locked', async () => {
    detail = makeDetail({ manifestLock: { editable: false, reason: 'Ya se adjuntó el pedimento PDF; los datos están bloqueados.' } });
    render(<SeguimientoView />);
    fireEvent.click(await screen.findByText('MAWB-PEND'));
    // The pedimentos list still renders (download + capture stay available)…
    await waitFor(() => expect(screen.getByText('258516535001684')).toBeTruthy());
    // …but the add-pedimento upload control is gone, replaced by a bloqueado indication.
    expect(screen.queryByText('Agregar pedimento PDF')).toBeNull();
    expect(screen.queryByLabelText('Zona de carga de pedimento PDF')).toBeNull();
    expect(screen.getByText(/no se pueden agregar más pedimentos/i)).toBeTruthy();
  });
});
