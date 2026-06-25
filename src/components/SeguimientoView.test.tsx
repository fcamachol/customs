import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SeguimientoView from './SeguimientoView';
import { apiGet, apiPost, apiDownload } from '../api';

const records = [
  { id: 'r-pending', mawbReference: 'MAWB-PEND', clientName: 'Cliente Pendiente', createdAt: '2026-01-01', coverageStatus: 'parcial', expectedCount: 2, uploadedCount: 1 },
  { id: 'r-done', mawbReference: 'MAWB-DONE', clientName: 'Cliente Completo', createdAt: '2026-01-02', coverageStatus: 'completo', expectedCount: 1, uploadedCount: 1 },
];

// Detail carries a manifest-level lock (gates adding pedimentos) and a pedimentos[] whose rows each
// carry their own lifecycle (subStatus), capture data (importData), prevalidation, reconciliation and
// lock. Capture is now a single entry point: a wizard opened from each row (no inline form).
function makeDetail({
  manifestLock = { editable: true, reason: null },
  pedimentoLock = { editable: true, reason: null },
  importData = null as Record<string, string> | null,
  importDataVersion = 0,
  subStatus = 'pendiente' as string,
}: {
  manifestLock?: { editable: boolean; reason: string | null };
  pedimentoLock?: { editable: boolean; reason: string | null };
  importData?: Record<string, string> | null;
  importDataVersion?: number;
  subStatus?: string;
} = {}) {
  return {
    lock: manifestLock,
    pedimentos: [
      {
        id: 'p1', numeroPedimento: '258516535001684', subdivisionOrdinal: 2, isLast: false,
        fileId: 'f1', scanVerdict: 'clean', pedimentoPdf: '/api/files/f1', coveredGuias: ['G1'],
        importData, importDataVersion, subStatus, prevalidation: null, reconciliation: null,
        lock: pedimentoLock,
      },
    ],
  };
}

// Per-test override of the record detail (defaults to editable, pendiente, no captured data).
let detail = makeDetail();

vi.mock('../api', () => ({
  ApiError: class ApiError extends Error {},
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

  it('opens a modal (not an inline panel) with the pedimentos sub-list + entry button + download named by numero', async () => {
    render(<SeguimientoView />);
    // Nothing renders before a manifest is selected — the panel is not inline at the bottom.
    expect(await screen.findByText('MAWB-PEND')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('258516535001684')).toBeNull();

    // Selecting a manifest opens the Pedimentos (subdivisiones) panel inside a modal dialog.
    fireEvent.click(screen.getByText('MAWB-PEND'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toBeTruthy();
    // The selected manifest's pedimentos[] renders each row with its numero + a lifecycle status chip.
    await waitFor(() => expect(screen.getByText('258516535001684')).toBeTruthy());
    expect(screen.getByText('Pedimentos (subdivisiones)')).toBeTruthy();
    expect(screen.getByText(/subdivisión 2/)).toBeTruthy();
    expect(screen.getByText('Pendiente')).toBeTruthy();
    // The PDF upload is no longer an inline dropzone — it moved into the wizard, reached via a button.
    expect(screen.getByRole('button', { name: /Agregar pedimento/i })).toBeTruthy();
    expect(screen.queryByText('Agregar pedimento PDF')).toBeNull();
    expect(screen.queryByLabelText('Zona de carga de pedimento PDF')).toBeNull();

    // The inline 7-field capture form is gone — no inline Patente input, no "Guardar datos" on the row.
    expect(screen.queryByLabelText('Patente')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Guardar datos' })).toBeNull();

    // Per-pedimento download names the file by numero (matches ConsultaView).
    fireEvent.click(screen.getByRole('button', { name: 'PDF' }));
    await waitFor(() => {
      expect(apiDownload).toHaveBeenCalledWith('/api/files/f1', 'Pedimento_258516535001684.pdf');
    });
  });

  it('opens the CaptureWizard modal when the row entry button (Capturar) is clicked', async () => {
    render(<SeguimientoView />);
    fireEvent.click(await screen.findByText('MAWB-PEND'));
    await waitFor(() => expect(screen.getByText('258516535001684')).toBeTruthy());

    // The manifest modal is open, but the capture wizard ("Captura de pedimento") is not yet.
    expect(screen.queryByText('Captura de pedimento')).toBeNull();

    // A pendiente row's entry button is labelled "Capturar"; clicking it opens the wizard directly on
    // its Capturar step (the PDF is already attached, so the upload step is skipped).
    fireEvent.click(screen.getByRole('button', { name: 'Capturar' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toBeTruthy();
    expect(screen.getByText('Captura de pedimento')).toBeTruthy();
    // The pedimento identity summary + the capture form are shown (no dropzone for an existing row).
    expect(screen.getByText('Número de pedimento')).toBeTruthy();
    expect(screen.getByLabelText(/Tasa de importación/i)).toBeTruthy();
    expect(screen.queryByLabelText('Zona de carga de pedimento PDF')).toBeNull();
  });

  it('labels the entry button by subStatus and opens the wizard read-only for cargado', async () => {
    detail = makeDetail({
      subStatus: 'cargado',
      pedimentoLock: { editable: false, reason: 'Pedimento cargado. Resumen de solo lectura.' },
    });
    render(<SeguimientoView />);
    fireEvent.click(await screen.findByText('MAWB-PEND'));
    await waitFor(() => expect(screen.getByText('258516535001684')).toBeTruthy());

    // cargado → status chip "Cargado" + the entry button reads "Ver".
    expect(screen.getByText('Cargado')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Ver' }));
    // The wizard opens on its read-only Finalizar summary (no Finalizar action button).
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(screen.getByText(/Resumen de solo lectura/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Finalizar' })).toBeNull();
  });

  it('the Agregar pedimento button opens the wizard on its Subir pedimento (upload) step', async () => {
    render(<SeguimientoView />);
    fireEvent.click(await screen.findByText('MAWB-PEND'));
    await waitFor(() => expect(screen.getByText('258516535001684')).toBeTruthy());

    // The manifest modal is open, but the capture wizard ("Captura de pedimento") is not yet.
    expect(screen.queryByText('Captura de pedimento')).toBeNull();

    // Clicking "Agregar pedimento" opens the wizard modal on its first step: the PDF dropzone.
    fireEvent.click(screen.getByRole('button', { name: /Agregar pedimento/i }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toBeTruthy();
    expect(screen.getByText('Captura de pedimento')).toBeTruthy();
    expect(screen.getByLabelText('Zona de carga de pedimento PDF')).toBeTruthy();
  });

  it('hides the Agregar pedimento button and shows a bloqueado note when the manifest is locked', async () => {
    detail = makeDetail({ manifestLock: { editable: false, reason: 'Ya se adjuntó el pedimento PDF; los datos están bloqueados.' } });
    render(<SeguimientoView />);
    fireEvent.click(await screen.findByText('MAWB-PEND'));
    // The pedimentos list still renders (download + capture entry stay available)…
    await waitFor(() => expect(screen.getByText('258516535001684')).toBeTruthy());
    // …but the add-pedimento control is gone, replaced by a bloqueado indication.
    expect(screen.queryByRole('button', { name: /Agregar pedimento/i })).toBeNull();
    expect(screen.queryByLabelText('Zona de carga de pedimento PDF')).toBeNull();
    expect(screen.getByText(/no se pueden agregar más pedimentos/i)).toBeTruthy();
  });
});
