import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CaptureWizard, type PedimentoItem } from './CaptureWizard';
import { apiGet, apiPost, apiDownload } from '../api';
import type { ReconciliationReport } from '../../shared/types/reports';

vi.mock('../api', () => ({
  ApiError: class ApiError extends Error {},
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiDownload: vi.fn(),
}));

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

const reconciliation: ReconciliationReport = {
  generatedAt: '2026-06-24T10:00:00Z',
  extractionMethod: 'deterministic',
  usedPositional: true,
  confidence: 0.95,
  header: [],
  totals: [],
  lines: [{ guia: 'GUIA-001', status: 'matched', diffs: [] }],
  summary: { matched: 1, mismatched: 0, missingInPedimento: 0, extraInPedimento: 0, color: 'verde' },
  notes: [],
};

function basePedimento(overrides: Partial<PedimentoItem> = {}): PedimentoItem {
  return {
    id: 'ped-1',
    numeroPedimento: '24 47 3250 0000123',
    subdivisionOrdinal: 1,
    isLast: true,
    fileId: 'file-1',
    scanVerdict: 'clean',
    pedimentoPdf: '/api/pedimentos/ped-1/pdf',
    coveredGuias: ['GUIA-001', 'GUIA-002'],
    importData: null,
    importDataVersion: 0,
    subStatus: 'pendiente',
    prevalidation: null,
    reconciliation: null,
    lock: { editable: true, reason: null },
    ...overrides,
  };
}

describe('CaptureWizard', () => {
  // (a) existing pendiente → opens straight on Capturar (PDF already attached); saving calls
  // /import-data + onChanged. The pedimento identity summary stays visible.
  it('an existing pendiente pedimento opens on Capturar and saving calls /import-data + onChanged', async () => {
    (apiPost as ReturnType<typeof vi.fn>).mockResolvedValue({ version: 1, importData: {} });
    const onChanged = vi.fn();
    render(<CaptureWizard pedimento={basePedimento()} onClose={() => {}} onChanged={onChanged} />);

    // The pedimento identity summary (folded into Capturar) shows the número.
    expect(screen.getByText('24 47 3250 0000123')).toBeTruthy();

    // The 7-field form is present immediately (no separate Revisar step / Continuar gate).
    expect(screen.queryByRole('button', { name: /^Continuar$/i })).toBeNull();
    expect(screen.getByLabelText(/Tasa de importación/i)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Patente/i), { target: { value: '3250' } });

    fireEvent.click(screen.getByRole('button', { name: /Guardar/i }));

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(apiPost).toHaveBeenCalledWith(
      '/api/pedimentos/ped-1/import-data',
      expect.objectContaining({ patente: '3250', version: 0 }),
    );
  });

  // (a2) new-upload mode → "Subir pedimento" step uploads via POST, then re-fetches the manifest
  // detail, finds the created subdivisión and advances into Capturar.
  it('new-upload mode uploads the PDF and advances into Capturar with the created pedimento', async () => {
    const created = basePedimento({ id: 'ped-new', numeroPedimento: '99 99 9999 0000999' });
    (apiGet as ReturnType<typeof vi.fn>).mockResolvedValue({ pedimentos: [created] });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ pedimentoId: 'ped-new', fileId: 'f-new', scan: { verdict: 'clean', findings: [], motors: { rf08: 'clean', rf10: 'clean' } } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const onChanged = vi.fn();

    render(<CaptureWizard manifestId="m-1" onClose={() => {}} onChanged={onChanged} />);

    // Starts on the upload step: dropzone present, no capture form yet.
    expect(screen.getByLabelText('Zona de carga de pedimento PDF')).toBeTruthy();
    expect(screen.queryByLabelText(/Tasa de importación/i)).toBeNull();

    // Select a PDF via the hidden file input, then click "Subir PDF".
    const file = new File(['%PDF-1.4'], 'pedimento.pdf', { type: 'application/pdf' });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: /Subir PDF/i }));

    // Uploaded to the manifest endpoint, then re-fetched detail + advanced into Capturar.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/manifests/m-1/pedimento-pdf'),
      expect.objectContaining({ method: 'POST' }),
    ));
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith('/api/records/m-1'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(await screen.findByLabelText(/Tasa de importación/i)).toBeTruthy();
    expect(screen.getByText('99 99 9999 0000999')).toBeTruthy();
  });

  // (a3) a blocked (422) upload shows the scan result and does NOT advance.
  it('a blocked upload shows the scan verdict and stays on the upload step', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      statusText: 'Unprocessable Entity',
      json: async () => ({ error: 'PDF bloqueado', scan: { verdict: 'blocked', findings: [], motors: { rf08: 'blocked', rf10: 'clean' } } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const onChanged = vi.fn();

    render(<CaptureWizard manifestId="m-1" onClose={() => {}} onChanged={onChanged} />);

    const file = new File(['%PDF-1.4'], 'malo.pdf', { type: 'application/pdf' });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: /Subir PDF/i }));

    // The scan card + error surface, and the flow stays on the upload step (no capture form, no onChanged).
    expect(await screen.findByText(/Análisis de seguridad/i)).toBeTruthy();
    expect(screen.getAllByText(/Bloqueado/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('PDF bloqueado')).toBeTruthy();
    expect(screen.queryByLabelText(/Tasa de importación/i)).toBeNull();
    expect(onChanged).not.toHaveBeenCalled();
    expect(apiGet).not.toHaveBeenCalled();
  });

  // (b) capturado → Prevalidar calls /pedimentos/:id/pedimento; APPROVED advances to Finalizar + renders panel
  it('a capturado pedimento Prevalidar calls /pedimentos/:id/pedimento and an APPROVED mock advances to Finalizar + renders the ReconciliationPanel', async () => {
    (apiPost as ReturnType<typeof vi.fn>).mockResolvedValue({
      prevalidation: { status: 'APPROVED', errors: [], warnings: [] },
    });
    const onChanged = vi.fn();
    render(
      <CaptureWizard
        pedimento={basePedimento({ subStatus: 'capturado', importData: {}, reconciliation })}
        onClose={() => {}}
        onChanged={onChanged}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Prevalidar/i }));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/api/pedimentos/ped-1/pedimento', {}),
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    // Advanced to Finalizar
    expect(screen.getByRole('button', { name: /Finalizar/i })).toBeTruthy();
    // ReconciliationPanel rendered (its summary label)
    expect(screen.getAllByText(/Coinciden/i).length).toBeGreaterThanOrEqual(1);
  });

  // (c) prevalidado → Finalizar calls /finalize + onClose
  it('a prevalidado pedimento Finalizar calls /finalize + onClose', async () => {
    (apiPost as ReturnType<typeof vi.fn>).mockResolvedValue({});
    const onClose = vi.fn();
    const onChanged = vi.fn();
    render(
      <CaptureWizard
        pedimento={basePedimento({ subStatus: 'prevalidado', importData: {} })}
        onClose={onClose}
        onChanged={onChanged}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Finalizar/i }));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/api/pedimentos/ped-1/finalize', {}),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onChanged).toHaveBeenCalled();
  });

  // (d) cargado → read-only, no mutating buttons
  it('a cargado pedimento is read-only (no Save/Prevalidar/Finalizar buttons)', () => {
    render(
      <CaptureWizard
        pedimento={basePedimento({ subStatus: 'cargado', importData: {}, reconciliation, lock: { editable: false, reason: 'Cargado' } })}
        onClose={() => {}}
        onChanged={() => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: /Guardar/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Prevalidar/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Finalizar/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Reabrir/i })).toBeNull();
  });

  // rechazado → shows prevalidation errors + Reabrir → /reopen
  it('a rechazado pedimento shows errors and Reabrir calls /reopen', async () => {
    (apiPost as ReturnType<typeof vi.fn>).mockResolvedValue({});
    const onChanged = vi.fn();
    render(
      <CaptureWizard
        pedimento={basePedimento({
          subStatus: 'rechazado',
          importData: {},
          prevalidation: { status: 'REJECTED', errors: ['Falta patente'], warnings: [] },
        })}
        onClose={() => {}}
        onChanged={onChanged}
      />,
    );
    expect(screen.getByText(/Falta patente/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Reabrir/i }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/api/pedimentos/ped-1/reopen', {}));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });
});
