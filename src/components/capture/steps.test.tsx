import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CapturarStep, PrevalidarStep, FinalizarStep, type PedimentoItem } from './steps';
import { apiPost } from '../../api';
import type { ReconciliationReport } from '../../../shared/types/reports';

vi.mock('../../api', () => ({
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

describe('capture steps', () => {
  // CapturarStep — shows identity summary; saving posts /import-data with the optimistic version.
  it('CapturarStep saving calls /import-data + onSaved', async () => {
    (apiPost as ReturnType<typeof vi.fn>).mockResolvedValue({ version: 1, importData: {} });
    const onSaved = vi.fn();
    render(<CapturarStep pedimento={basePedimento()} readOnly={false} onSaved={onSaved} />);

    expect(screen.getByText('24 47 3250 0000123')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Patente/i), { target: { value: '3250' } });
    fireEvent.click(screen.getByRole('button', { name: /Guardar/i }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(apiPost).toHaveBeenCalledWith(
      '/api/pedimentos/ped-1/import-data',
      expect.objectContaining({ patente: '3250', version: 0 }),
    );
  });

  // PrevalidarStep — Prevalidar posts /pedimentos/:id/pedimento; APPROVED → onApproved + reconciliation panel.
  it('PrevalidarStep an APPROVED prevalidation calls /pedimento and onApproved + renders the ReconciliationPanel', async () => {
    (apiPost as ReturnType<typeof vi.fn>).mockResolvedValue({ prevalidation: { status: 'APPROVED', errors: [], warnings: [] } });
    const onApproved = vi.fn();
    render(
      <PrevalidarStep
        pedimento={basePedimento({ subStatus: 'capturado', importData: {}, reconciliation })}
        readOnly={false}
        onApproved={onApproved}
        onReopened={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Prevalidar/i }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/api/pedimentos/ped-1/pedimento', {}));
    await waitFor(() => expect(onApproved).toHaveBeenCalled());
    expect(screen.getAllByText(/Coinciden/i).length).toBeGreaterThanOrEqual(1);
  });

  // FinalizarStep — Finalizar posts /finalize + onFinalized.
  it('FinalizarStep Finalizar calls /finalize + onFinalized', async () => {
    (apiPost as ReturnType<typeof vi.fn>).mockResolvedValue({});
    const onFinalized = vi.fn();
    render(
      <FinalizarStep pedimento={basePedimento({ subStatus: 'prevalidado', importData: {} })} readOnly={false} onFinalized={onFinalized} />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Finalizar/i }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/api/pedimentos/ped-1/finalize', {}));
    await waitFor(() => expect(onFinalized).toHaveBeenCalled());
  });

  // cargado → read-only summary (no Guardar / Finalizar buttons).
  it('a cargado pedimento renders read-only', () => {
    render(
      <FinalizarStep
        pedimento={basePedimento({ subStatus: 'cargado', importData: {}, lock: { editable: false, reason: 'Cargado' } })}
        readOnly
        onFinalized={() => {}}
      />,
    );
    expect(screen.getByText(/Cargado/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Finalizar' })).toBeNull();
  });

  // rechazado → shows prevalidation errors + Reabrir → /reopen.
  it('a rechazado pedimento shows errors and Reabrir calls /reopen', async () => {
    (apiPost as ReturnType<typeof vi.fn>).mockResolvedValue({});
    const onReopened = vi.fn();
    render(
      <PrevalidarStep
        pedimento={basePedimento({
          subStatus: 'rechazado',
          importData: {},
          prevalidation: { status: 'REJECTED', errors: ['Falta patente'], warnings: [] },
        })}
        readOnly={false}
        onApproved={() => {}}
        onReopened={onReopened}
      />,
    );
    expect(screen.getByText(/Falta patente/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Reabrir/i }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/api/pedimentos/ped-1/reopen', {}));
    await waitFor(() => expect(onReopened).toHaveBeenCalled());
  });
});
