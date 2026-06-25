import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CaptureWizard, type PedimentoItem } from './CaptureWizard';
import { apiPost, apiDownload } from '../api';
import type { ReconciliationReport } from '../../shared/types/reports';

vi.mock('../api', () => ({ apiPost: vi.fn(), apiDownload: vi.fn() }));

beforeEach(() => vi.clearAllMocks());

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
  // (a) pendiente → Revisar then Capturar; saving calls /import-data + onChanged
  it('a pendiente pedimento renders Revisar then Capturar and saving calls /import-data + onChanged', async () => {
    (apiPost as ReturnType<typeof vi.fn>).mockResolvedValue({ version: 1, importData: {} });
    const onChanged = vi.fn();
    render(<CaptureWizard pedimento={basePedimento()} onClose={() => {}} onChanged={onChanged} />);

    // Revisar step shows read-only summary
    expect(screen.getByText('24 47 3250 0000123')).toBeTruthy();

    // Advance to Capturar
    fireEvent.click(screen.getByRole('button', { name: /Continuar/i }));

    // The 7-field form is present
    expect(screen.getByLabelText(/Tasa de importación/i)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Patente/i), { target: { value: '3250' } });

    fireEvent.click(screen.getByRole('button', { name: /Guardar/i }));

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(apiPost).toHaveBeenCalledWith(
      '/api/pedimentos/ped-1/import-data',
      expect.objectContaining({ patente: '3250', version: 0 }),
    );
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
