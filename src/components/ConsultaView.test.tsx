import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import ConsultaView from './ConsultaView';
import { apiDownload } from '../api';

const recordsList = [
  { id: 'rec-1', mawbReference: 'MAWB-123', clientName: 'Acme Corp', createdAt: '2026-01-01' },
];

const recordDetail = {
  id: 'rec-1',
  mawbReference: 'MAWB-123',
  clientName: 'Acme Corp',
  pedimentoFileId: 'file-9',
  shipmentCount: 5,
  pedimentos: [
    { id: 'p1', numeroPedimento: '258516535001684', subdivisionOrdinal: 1, isLast: false, pedimentoPdf: '/api/files/file-9' },
    { id: 'p2', numeroPedimento: '258516535001685', subdivisionOrdinal: 2, isLast: true, pedimentoPdf: '/api/files/file-10' },
  ],
  artifacts: {
    riskAnalysis: '/api/records/rec-1/risk.xlsx',
    pedimentoPdf: '/api/files/file-9',
    report: '/api/records/rec-1/report.xlsx',
  },
};

const reportsBundle = {
  risk: [], report: [], layout: [],
  lock: { editable: true, reason: null },
  riskStale: false, masked: false, generatedAt: '2026-01-01', contentHash: 'abc',
};

const clientsList = [
  { id: 'cli-1', name: 'Acme Corp', platforms: [{ id: 'plt-1', commercialName: 'Acme Store', legalName: null }] },
];

vi.mock('../api', () => ({
  apiGet: vi.fn(async (url: string) => {
    if (url.includes('/api/catalogs/clients')) return clientsList;
    if (url.includes('/reports.json')) return reportsBundle;
    if (url.includes('/api/records/rec-1')) return recordDetail;
    if (url.includes('/api/records')) return recordsList;
    throw new Error('not found');
  }),
  apiDownload: vi.fn(async () => undefined),
}));

describe('ConsultaView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads and renders records on mount (instant apply, no Buscar button)', async () => {
    render(<ConsultaView />);

    // Records load on mount; filters apply instantly with no submit button.
    const recordButton = await screen.findByText(/MAWB-123/);
    expect(recordButton).toBeTruthy();
    expect(screen.getByText(/Acme Corp/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Buscar' })).toBeNull();
  });

  it('renders report tabs (incl. Pedimento) and downloads the active tab', async () => {
    render(<ConsultaView />);

    const recordButton = await screen.findByText(/MAWB-123/);
    fireEvent.click(recordButton);

    // Reports now drive both the table view and the downloads via tabs.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Análisis de Riesgo' })).toBeTruthy();
    });
    expect(screen.getByRole('button', { name: 'Reporte General' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Layout' })).toBeTruthy();
    // Pedimento tab only appears because this record has a pedimento PDF.
    expect(screen.getByRole('button', { name: 'Pedimento' })).toBeTruthy();

    // The top-right "Descargar" downloads the file for the active tab (default: risk).
    fireEvent.click(screen.getByRole('button', { name: 'Descargar' }));
    await waitFor(() => {
      expect(apiDownload).toHaveBeenCalledWith('/api/records/rec-1/risk.xlsx', 'Analisis_de_Riesgo.xlsx');
    });
  });

  it('lists each pedimento (subdivisión) PDF with its own download', async () => {
    render(<ConsultaView />);
    fireEvent.click(await screen.findByText(/MAWB-123/));

    // Both subdivisión numbers render, each with a per-pedimento download button.
    await waitFor(() => expect(screen.getByText('258516535001684')).toBeTruthy());
    expect(screen.getByText('258516535001685')).toBeTruthy();
    expect(screen.getByText(/subdivisión 2 \(última\)/)).toBeTruthy();

    const downloads = screen.getAllByRole('button', { name: /Descargar PDF/ });
    fireEvent.click(downloads[1]);
    await waitFor(() => {
      expect(apiDownload).toHaveBeenCalledWith('/api/files/file-10', 'Pedimento_258516535001685.pdf');
    });
  });
});
