import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SeguimientoView from './SeguimientoView';
import { apiGet } from '../api';

const records = [
  { id: 'r-pending', mawbReference: 'MAWB-PEND', clientName: 'Cliente Pendiente', createdAt: '2026-01-01', coverageStatus: 'parcial', expectedCount: 2, uploadedCount: 1 },
  { id: 'r-done', mawbReference: 'MAWB-DONE', clientName: 'Cliente Completo', createdAt: '2026-01-02', coverageStatus: 'completo', expectedCount: 1, uploadedCount: 1 },
];

// GET /api/records/:id detail: manifest identity + coverage + the pedimentos[] (subdivisiones), each
// carrying its own lifecycle (subStatus), capture data, prevalidation, reconciliation and lock. The
// capture workspace renders the whole manifest lifecycle across all of these.
function makeDetail(overrides: Record<string, unknown> = {}) {
  return {
    mawbReference: 'MAWB-PEND',
    clientName: 'Cliente Pendiente',
    coverage: { status: 'parcial', expectedCount: 2, uploadedNumeros: [], missingNumeros: [], uncoveredGuias: [], duplicatedGuias: [], manifestGuiaCount: 2, coveredGuiaCount: 1 },
    pedimentos: [
      {
        id: 'p1', numeroPedimento: '258516535001684', subdivisionOrdinal: 2, isLast: false,
        fileId: 'f1', scanVerdict: 'clean', pedimentoPdf: '/api/files/f1', coveredGuias: ['G1'],
        importData: null, importDataVersion: 0, subStatus: 'pendiente', prevalidation: null,
        reconciliation: null, lock: { editable: true, reason: null },
      },
    ],
    ...overrides,
  };
}

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
    expect(await screen.findByText('MAWB-PEND')).toBeTruthy();
    expect(screen.queryByText('MAWB-DONE')).toBeNull();

    fireEvent.click(screen.getByText('Completados'));
    expect(await screen.findByText('MAWB-DONE')).toBeTruthy();
    expect(screen.queryByText('MAWB-PEND')).toBeNull();
  });

  it('does not open the workspace until a manifest is selected', async () => {
    render(<SeguimientoView />);
    expect(await screen.findByText('MAWB-PEND')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('selecting a manifest opens the capture workspace with the manifest header + stepper + its pedimentos', async () => {
    render(<SeguimientoView />);
    fireEvent.click(await screen.findByText('MAWB-PEND'));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toBeTruthy();
    // The workspace fetches the manifest detail and keeps identity visible in the header.
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith('/api/records/r-pending'));
    expect(await screen.findByText('MAWB-PEND — Cliente Pendiente')).toBeTruthy();
    // 4-phase stepper + the manifest's pedimento (subdivisión) card.
    expect(screen.getByText('Subir pedimentos')).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText('258516535001684').length).toBeGreaterThan(0));
    expect(screen.getByText(/subdivisión 2/)).toBeTruthy();
  });

  it('an empty manifest opens the workspace on its Subir (multi-upload) step', async () => {
    detail = makeDetail({ pedimentos: [], coverage: { status: 'sin_pedimento', expectedCount: null, uploadedNumeros: [], missingNumeros: [], uncoveredGuias: [], duplicatedGuias: [], manifestGuiaCount: 0, coveredGuiaCount: 0 } });
    render(<SeguimientoView />);
    fireEvent.click(await screen.findByText('MAWB-PEND'));

    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(await screen.findByLabelText('Zona de carga de pedimentos PDF')).toBeTruthy();
  });
});
