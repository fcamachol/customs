import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CaptureWorkspace } from './CaptureWorkspace';
import { apiGet, apiPost, apiDelete } from '../api';
import type { PedimentoItem } from './capture/steps';
import type { CoverageResult } from '../../shared/pedimento/coverage';

vi.mock('../api', () => ({
  ApiError: class ApiError extends Error {},
  apiGet: vi.fn(),
  apiPost: vi.fn(() => Promise.resolve({})),
  apiDelete: vi.fn(() => Promise.resolve({ ok: true })),
  apiDownload: vi.fn(() => Promise.resolve()),
}));

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

function coverage(overrides: Partial<CoverageResult> = {}): CoverageResult {
  return {
    status: 'parcial', expectedCount: 2, uploadedNumeros: [], missingNumeros: [],
    uncoveredGuias: [], duplicatedGuias: [], manifestGuiaCount: 2, coveredGuiaCount: 1, ...overrides,
  };
}

function ped(overrides: Partial<PedimentoItem> = {}): PedimentoItem {
  return {
    id: 'p1', numeroPedimento: '258516535001684', subdivisionOrdinal: 2, isLast: false,
    fileId: 'f1', scanVerdict: 'clean', pedimentoPdf: '/api/files/f1', coveredGuias: ['G1'],
    importData: null, importDataVersion: 0, subStatus: 'pendiente', prevalidation: null,
    reconciliation: null, lock: { editable: true, reason: null }, ...overrides,
  };
}

function detail(overrides: Record<string, unknown> = {}) {
  return { mawbReference: 'MAWB-1', clientName: 'ACME', coverage: coverage(), pedimentos: [ped()], ...overrides };
}

describe('CaptureWorkspace', () => {
  it('loads the manifest detail and shows the sticky header + stepper + first pedimento card', async () => {
    vi.mocked(apiGet).mockResolvedValue(detail());
    render(<CaptureWorkspace manifestId="m-1" onClose={() => {}} onChanged={() => {}} />);

    await waitFor(() => expect(apiGet).toHaveBeenCalledWith('/api/records/m-1'));
    // Header keeps manifest identity visible (the lost-context fix).
    expect(await screen.findByText('MAWB-1 — ACME')).toBeTruthy();
    // 4-phase stepper.
    expect(screen.getByText('Subir pedimentos')).toBeTruthy();
    expect(screen.getByText('Prevalidar')).toBeTruthy();
    // A manifest with pedimentos defaults to Capturar; the first not-done card auto-expands (so the
    // número shows in both the card header and the expanded summary).
    await waitFor(() => expect(screen.getAllByText('258516535001684').length).toBeGreaterThan(0));
    expect(screen.getByText('Número de pedimento')).toBeTruthy();
  });

  it('an empty manifest opens on the Subir step with a multi-file dropzone', async () => {
    vi.mocked(apiGet).mockResolvedValue(detail({ pedimentos: [], coverage: coverage({ status: 'sin_pedimento', expectedCount: null }) }));
    render(<CaptureWorkspace manifestId="m-1" onClose={() => {}} onChanged={() => {}} />);

    expect(await screen.findByLabelText('Zona de carga de pedimentos PDF')).toBeTruthy();
    expect(screen.getByText(/varios a la vez/i)).toBeTruthy();
  });

  it('uploads multiple PDFs sequentially to the manifest endpoint', async () => {
    vi.mocked(apiGet).mockResolvedValue(detail({ pedimentos: [] }));
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ pedimentoId: 'pX', numeroPedimento: 'N', scan: { verdict: 'clean', findings: [], motors: { rf08: 'clean', rf10: 'clean' } } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const onChanged = vi.fn();
    render(<CaptureWorkspace manifestId="m-1" onClose={() => {}} onChanged={onChanged} />);

    await screen.findByLabelText('Zona de carga de pedimentos PDF');
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const f1 = new File(['%PDF-1.4'], 'a.pdf', { type: 'application/pdf' });
    const f2 = new File(['%PDF-1.4'], 'b.pdf', { type: 'application/pdf' });
    fireEvent.change(input, { target: { files: [f1, f2] } });

    fireEvent.click(screen.getByRole('button', { name: /Subir 2 pedimento/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/manifests/m-1/pedimento-pdf'),
      expect.objectContaining({ method: 'POST' }),
    );
    // Refresh after the batch updates the queue/header.
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('bulk "Finalizar pedimentos listos" finalizes every prevalidado pedimento', async () => {
    vi.mocked(apiGet).mockResolvedValue(detail({
      pedimentos: [ped({ id: 'p1', subStatus: 'prevalidado' }), ped({ id: 'p2', numeroPedimento: 'NUM2', subStatus: 'prevalidado' })],
    }));
    render(<CaptureWorkspace manifestId="m-1" onClose={() => {}} onChanged={() => {}} />);

    await screen.findByText('MAWB-1 — ACME');
    // Navigate to Finalizar via the stepper (the only /Finalizar/ button before navigation).
    fireEvent.click(screen.getByRole('button', { name: /Finalizar/i }));
    const bulk = await screen.findByRole('button', { name: /Finalizar pedimentos listos \(2\)/i });
    fireEvent.click(bulk);

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/api/pedimentos/p1/finalize', {}));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/api/pedimentos/p2/finalize', {}));
  });

  it('a cargado pedimento card is read-only (no Guardar)', async () => {
    vi.mocked(apiGet).mockResolvedValue(detail({
      pedimentos: [ped({ subStatus: 'cargado', importData: {}, lock: { editable: false, reason: 'Cargado' } })],
      coverage: coverage({ status: 'completo' }),
    }));
    render(<CaptureWorkspace manifestId="m-1" onClose={() => {}} onChanged={() => {}} />);

    await screen.findByText('MAWB-1 — ACME');
    // The card is collapsed (done); expand it and confirm there's no editable Guardar action.
    expect(screen.getByText('Cargado')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /258516535001684/ }));
    expect(screen.queryByRole('button', { name: 'Guardar datos' })).toBeNull();
  });

  it('renders a delete trash icon for non-cargado pedimentos and hides it for cargado pedimentos', async () => {
    vi.mocked(apiGet).mockResolvedValue(detail({
      pedimentos: [
        ped({ id: 'p1', subStatus: 'pendiente' }),
        ped({ id: 'p2', numeroPedimento: 'NUM2', subStatus: 'cargado', lock: { editable: false, reason: 'Cargado' } }),
      ],
    }));
    render(<CaptureWorkspace manifestId="m-1" onClose={() => {}} onChanged={() => {}} />);

    await screen.findByText('MAWB-1 — ACME');
    expect(screen.getAllByRole('button', { name: 'Eliminar pedimento' })).toHaveLength(1);
  });

  it('confirms then deletes a pedimento and refreshes the list', async () => {
    vi.mocked(apiGet).mockResolvedValue(detail({ pedimentos: [ped({ id: 'p1', subStatus: 'pendiente' })] }));
    const onChanged = vi.fn();
    render(<CaptureWorkspace manifestId="m-1" onClose={() => {}} onChanged={onChanged} />);

    await screen.findByText('MAWB-1 — ACME');
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar pedimento' }));
    expect(await screen.findByText('¿Eliminar pedimento?')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Eliminar' }));

    await waitFor(() => expect(apiDelete).toHaveBeenCalledWith('/api/pedimentos/p1'));
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('Cancelar dismisses the confirm without calling the API', async () => {
    vi.mocked(apiGet).mockResolvedValue(detail({ pedimentos: [ped({ id: 'p1', subStatus: 'pendiente' })] }));
    render(<CaptureWorkspace manifestId="m-1" onClose={() => {}} onChanged={() => {}} />);

    await screen.findByText('MAWB-1 — ACME');
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar pedimento' }));
    await screen.findByText('¿Eliminar pedimento?');
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));

    expect(screen.queryByText('¿Eliminar pedimento?')).toBeNull();
    expect(apiDelete).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Eliminar pedimento' })).toBeTruthy();
  });

  it('shows an error message when the delete request fails and resets the confirm state', async () => {
    vi.mocked(apiGet).mockResolvedValue(detail({ pedimentos: [ped({ id: 'p1', subStatus: 'pendiente' })] }));
    vi.mocked(apiDelete).mockRejectedValueOnce(new Error('No se pudo eliminar'));
    render(<CaptureWorkspace manifestId="m-1" onClose={() => {}} onChanged={() => {}} />);

    await screen.findByText('MAWB-1 — ACME');
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar pedimento' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Eliminar' }));

    expect(await screen.findByText('No se pudo eliminar')).toBeTruthy();
    expect(screen.queryByText('¿Eliminar pedimento?')).toBeNull();
  });

  it('shows an amber extraction-warning indicator and the warning text when extractionWarnings is non-empty', async () => {
    const warn = 'El PDF parece ser un documento escaneado sin capa de texto.';
    vi.mocked(apiGet).mockResolvedValue(detail({
      pedimentos: [ped({ id: 'p1', subStatus: 'pendiente', extractionWarnings: [warn] })],
    }));
    render(<CaptureWorkspace manifestId="m-1" onClose={() => {}} onChanged={() => {}} />);

    await screen.findByText('MAWB-1 — ACME');
    // Compact header indicator (count) is labelled for screen readers …
    expect(screen.getByLabelText('1 advertencia(s) de extracción')).toBeTruthy();
    // … and the card auto-expands (first not-done in Capturar), showing the readable warning line.
    expect(await screen.findByText(warn)).toBeTruthy();
  });

  it('renders no extraction-warning indicator when extractionWarnings is empty/absent', async () => {
    vi.mocked(apiGet).mockResolvedValue(detail({ pedimentos: [ped({ id: 'p1', subStatus: 'pendiente' })] }));
    render(<CaptureWorkspace manifestId="m-1" onClose={() => {}} onChanged={() => {}} />);

    await screen.findByText('MAWB-1 — ACME');
    expect(screen.queryByLabelText(/advertencia\(s\) de extracción/)).toBeNull();
  });

  it('clicking the trash icon does not toggle the accordion', async () => {
    vi.mocked(apiGet).mockResolvedValue(detail({ pedimentos: [ped({ id: 'p1', subStatus: 'pendiente' })] }));
    render(<CaptureWorkspace manifestId="m-1" onClose={() => {}} onChanged={() => {}} />);

    await screen.findByText('MAWB-1 — ACME');
    // Card auto-expands (first not-done card in Capturar); wait for the effect that drives it.
    expect(await screen.findByText('Número de pedimento')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Eliminar pedimento' }));
    expect(screen.getByText('Número de pedimento')).toBeTruthy();
  });
});

describe('CaptureWorkspace — phase continue buttons', () => {
  it('Capturar shows "Continuar a Prevalidar" which advances the phase', async () => {
    vi.mocked(apiGet).mockResolvedValue(detail());
    render(<CaptureWorkspace manifestId="m-1" onClose={() => {}} onChanged={() => {}} />);
    await screen.findByText('MAWB-1 — ACME');

    fireEvent.click(await screen.findByRole('button', { name: 'Continuar a Prevalidar' }));
    // Prevalidar phase heading appears and its own continue button leads to Finalizar.
    expect(await screen.findByRole('button', { name: 'Continuar a Finalizar' })).toBeTruthy();
  });
  it('Finalizar has no continue button (bulk finalize is the terminal action)', async () => {
    vi.mocked(apiGet).mockResolvedValue(detail());
    render(<CaptureWorkspace manifestId="m-1" onClose={() => {}} onChanged={() => {}} />);
    await screen.findByText('MAWB-1 — ACME');

    fireEvent.click(await screen.findByRole('button', { name: 'Continuar a Prevalidar' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Continuar a Finalizar' }));
    await screen.findByRole('button', { name: /Finalizar pedimentos listos/ });
    expect(screen.queryByRole('button', { name: /Continuar a/ })).toBeNull();
  });
});
