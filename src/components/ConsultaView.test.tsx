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
  },
};

// Per-MANIFEST risk bundle.
const riskBundle = { risk: [], riskStale: false, generatedAt: '2026-01-01', contentHash: 'risk' };
// Per-PEDIMENTO report bundle.
const pedimentoBundle = { report: [], layout: [], lock: { editable: true, reason: null }, masked: false, generatedAt: '2026-01-01', contentHash: 'rep' };

const clientsList = [
  { id: 'cli-1', name: 'Acme Corp', platforms: [{ id: 'plt-1', commercialName: 'Acme Store', legalName: null }] },
];

vi.mock('../api', () => ({
  apiGet: vi.fn(async (url: string) => {
    if (url.includes('/api/catalogs/clients')) return clientsList;
    if (url.includes('/api/pedimentos/') && url.includes('/reports.json')) return pedimentoBundle;
    if (url.includes('/api/records/rec-1/reports.json')) return riskBundle;
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

  it('renders a generated-files panel per pedimento with Análisis de Riesgo / Pedimento / Reporte General tabs', async () => {
    render(<ConsultaView />);

    const recordButton = await screen.findByText(/MAWB-123/);
    fireEvent.click(recordButton);

    // One files panel per pedimento, each titled with its número + subdivisión.
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /258516535001684 — subdivisión 1/ })).toBeTruthy();
    });
    expect(screen.getByRole('heading', { name: /258516535001685 — subdivisión 2 \(última\)/ })).toBeTruthy();

    // Consulta surfaces the generated files: each panel leads with the Análisis de Riesgo artifact
    // tab followed by Pedimento / Reporte General (client observation). No Layout tab here.
    expect(screen.getAllByRole('button', { name: 'Análisis de Riesgo' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Pedimento' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Reporte General' })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Layout' })).toBeNull();

    // The risk-analysis SUMMARY (stat tiles) is no longer what Consulta leads with.
    expect(screen.queryByText('Analizados')).toBeNull();
  });

  it('downloads the Análisis de Riesgo artifact from the default tab', async () => {
    render(<ConsultaView />);
    fireEvent.click(await screen.findByText(/MAWB-123/));

    await waitFor(() => expect(screen.getByRole('heading', { name: /258516535001684/ })).toBeTruthy());

    // Default tab is Análisis de Riesgo; its download targets the manifest-level risk.xlsx.
    const downloads = screen.getAllByRole('button', { name: /Descargar/ });
    fireEvent.click(downloads[0]);
    await waitFor(() => {
      expect(apiDownload).toHaveBeenCalledWith('/api/records/rec-1/risk.xlsx', 'Analisis_de_Riesgo.xlsx');
    });
  });

  it("downloads a pedimento's Reporte General from its own panel", async () => {
    render(<ConsultaView />);
    fireEvent.click(await screen.findByText(/MAWB-123/));

    // Wait for the per-pedimento panels to load.
    await waitFor(() => expect(screen.getByRole('heading', { name: /258516535001684/ })).toBeTruthy());

    // Switch the FIRST panel to its Reporte General tab, then download THAT pedimento's report.xlsx.
    fireEvent.click(screen.getAllByRole('button', { name: 'Reporte General' })[0]);
    const downloads = screen.getAllByRole('button', { name: /Descargar/ });
    fireEvent.click(downloads[0]);
    await waitFor(() => {
      expect(apiDownload).toHaveBeenCalledWith('/api/pedimentos/p1/report.xlsx', 'Reporte_General.xlsx');
    });
  });

  it("downloads a pedimento's PDF from its Pedimento tab", async () => {
    render(<ConsultaView />);
    fireEvent.click(await screen.findByText(/MAWB-123/));

    await waitFor(() => expect(screen.getByRole('heading', { name: /258516535001685/ })).toBeTruthy());

    // Open the Pedimento tab on the SECOND panel, then download its PDF.
    const pedimentoTabs = screen.getAllByRole('button', { name: 'Pedimento' });
    fireEvent.click(pedimentoTabs[1]);
    const pdfButtons = await screen.findAllByRole('button', { name: /Descargar PDF/ });
    fireEvent.click(pdfButtons[pdfButtons.length - 1]);
    await waitFor(() => {
      expect(apiDownload).toHaveBeenCalledWith('/api/files/file-10', 'Pedimento.pdf');
    });
  });
});
