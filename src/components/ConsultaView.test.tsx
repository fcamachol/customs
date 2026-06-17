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

describe('ConsultaView', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/api/records/rec-1')) {
          return { ok: true, json: async () => recordDetail } as Response;
        }
        if (url.includes('/api/records')) {
          return { ok: true, json: async () => recordsList } as Response;
        }
        return { ok: false, statusText: 'not found' } as Response;
      }) as unknown as typeof fetch,
    );
  });

  it('searches and renders a record, then shows artifact download buttons on click', async () => {
    render(<ConsultaView />);

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Acme' } });
    fireEvent.click(screen.getByRole('button', { name: 'Buscar' }));

    const recordButton = await screen.findByText(/MAWB-123/);
    expect(recordButton).toBeTruthy();
    expect(screen.getByText(/Acme Corp/)).toBeTruthy();

    fireEvent.click(recordButton);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Análisis de Riesgo (XLS)' })).toBeTruthy();
    });
    expect(screen.getByRole('button', { name: 'Reporte General (XLS)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'LayOut (XLS)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Pedimento (PDF)' })).toBeTruthy();
  });
});
