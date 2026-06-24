import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SeguimientoView from './SeguimientoView';
import { apiGet, apiDownload } from '../api';

const records = [
  { id: 'r-pending', mawbReference: 'MAWB-PEND', clientName: 'Cliente Pendiente', createdAt: '2026-01-01', coverageStatus: 'parcial', expectedCount: 2, uploadedCount: 1 },
  { id: 'r-done', mawbReference: 'MAWB-DONE', clientName: 'Cliente Completo', createdAt: '2026-01-02', coverageStatus: 'completo', expectedCount: 1, uploadedCount: 1 },
];

function makeDetail(lock: { editable: boolean; reason: string | null }) {
  return {
    importData: null,
    importDataVersion: 0,
    lock,
    pedimentos: [
      { id: 'p1', numeroPedimento: '258516535001684', subdivisionOrdinal: 2, isLast: false, fileId: 'f1', scanVerdict: 'clean', pedimentoPdf: '/api/files/f1', coveredGuias: ['G1'] },
    ],
  };
}

// Per-test override of the record detail (defaults to editable).
let detail = makeDetail({ editable: true, reason: null });

vi.mock('../api', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(() => Promise.resolve({ ok: true })),
  apiDownload: vi.fn(() => Promise.resolve()),
}));

describe('SeguimientoView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    detail = makeDetail({ editable: true, reason: null });
    vi.mocked(apiGet).mockImplementation(async (url: string) => {
      if (url.startsWith('/api/records/')) return detail;
      if (url.startsWith('/api/records')) return records;
      throw new Error('not found');
    });
  });

  it('renders the Pendientes/Completados tabs, the filter field and pedimento capture labels', async () => {
    render(<SeguimientoView />);
    expect(screen.getByText('Pendientes')).toBeTruthy();
    expect(screen.getByText('Completados')).toBeTruthy();
    expect(screen.getByPlaceholderText(/Filtrar/i)).toBeTruthy();
    expect(screen.getByText('Pedimento')).toBeTruthy();
    expect(screen.getByText('Agente Aduanal')).toBeTruthy();
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

  it('shows the pedimentos sub-list with a per-pedimento download named by numero', async () => {
    render(<SeguimientoView />);
    fireEvent.click(await screen.findByText('MAWB-PEND'));
    // The selected manifest's pedimentos[] is rendered with its numero + a PDF download.
    await waitFor(() => expect(screen.getByText('258516535001684')).toBeTruthy());
    expect(screen.getByText(/subdivisión 2/)).toBeTruthy();
    expect(screen.getByText('Agregar pedimento PDF')).toBeTruthy();

    // Per-pedimento download names the file by numero (matches ConsultaView).
    fireEvent.click(screen.getByRole('button', { name: 'PDF' }));
    await waitFor(() => {
      expect(apiDownload).toHaveBeenCalledWith('/api/files/f1', 'Pedimento_258516535001684.pdf');
    });
  });

  it('hides the upload zone and shows a bloqueado note when the record is locked', async () => {
    detail = makeDetail({ editable: false, reason: 'Ya se adjuntó el pedimento PDF; los datos están bloqueados.' });
    render(<SeguimientoView />);
    fireEvent.click(await screen.findByText('MAWB-PEND'));
    // The pedimentos list still renders (download stays available)…
    await waitFor(() => expect(screen.getByText('258516535001684')).toBeTruthy());
    // …but the add-pedimento upload control is gone, replaced by a bloqueado indication.
    expect(screen.queryByText('Agregar pedimento PDF')).toBeNull();
    expect(screen.queryByLabelText('Zona de carga de pedimento PDF')).toBeNull();
    expect(screen.getByText(/no se pueden agregar más pedimentos/i)).toBeTruthy();
  });
});
