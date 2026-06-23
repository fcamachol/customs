import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import ConsultaView from './ConsultaView';

const recordsList = [
  { id: 'rec-1', mawbReference: 'MAWB-123', clientName: 'Acme Corp', createdAt: '2026-01-01' },
];

const recordDetail = {
  id: 'rec-1',
  mawbReference: 'MAWB-123',
  clientName: 'Acme Corp',
  pedimentoFileId: 'file-9',
  shipmentCount: 5,
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

vi.mock('../api', () => ({
  apiGet: vi.fn(async (url: string) => {
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

  it('searches and renders a record', async () => {
    render(<ConsultaView />);

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Acme' } });
    fireEvent.click(screen.getByRole('button', { name: 'Buscar' }));

    const recordButton = await screen.findByText(/MAWB-123/);
    expect(recordButton).toBeTruthy();
    expect(screen.getByText(/Acme Corp/)).toBeTruthy();
  });

  it('shows artifact FileCards after selecting a record', async () => {
    render(<ConsultaView />);

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Acme' } });
    fireEvent.click(screen.getByRole('button', { name: 'Buscar' }));

    const recordButton = await screen.findByText(/MAWB-123/);
    fireEvent.click(recordButton);

    // 'Análisis de Riesgo' / 'Reporte General' now also appear as on-screen tab labels, so use
    // getAllByText for those; 'LayOut' and 'Pedimento' remain unique to the download FileCards.
    await waitFor(() => {
      expect(screen.getAllByText('Análisis de Riesgo').length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText('Reporte General').length).toBeGreaterThan(0);
    expect(screen.getByText('LayOut')).toBeTruthy();
    expect(screen.getByText('Pedimento')).toBeTruthy();
  });
});
