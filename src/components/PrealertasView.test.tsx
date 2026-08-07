// src/components/PrealertasView.test.tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import PrealertasView from './PrealertasView';

const listItem = {
  id: 'op-1', mawb: '369-94705516', mawbRaw: '369-9470-5516', clienteNombre: 'Acme Corp',
  origenIata: 'HKG', destinoIata: 'NLU', numeroVuelo: 'CV901',
  etdOrigen: '2026-08-01T02:00:00.000Z', etaPais: '2026-08-01T10:00:00.000Z',
  cartonesPrealerta: 12, piezasPrealerta: 340, pesoKgPrealerta: 980.5,
  etapa: 'documental', estadoDocumental: 'en_revision', estadoPlaneacion: 'planeado',
  semaforo: 'green' as const, holdActivo: false,
  createdAt: '2026-08-01T01:00:00.000Z', vueloEstado: 'en_vuelo', vueloEtaEstimado: '2026-08-01T10:15:00.000Z',
  vueloArriboReal: null, discrepanciasCount: 1, prealertaVersion: 1,
};

const heldItem = {
  ...listItem, id: 'op-2', mawb: '369-11112222', holdActivo: true, semaforo: 'red' as const,
  discrepanciasCount: 0,
};

const detail = {
  ...listItem,
  discrepancias: [{ codigo: 'PESO_DIFIERE', severidad: 'media', detalle: 'Peso declarado difiere del manifiesto' }],
  cotejoVersion: 'v1', arriboVueloAt: null, disponibleAt: null,
  agoraConversationId: null, manifestId: 'man-1',
  vuelo: {
    numeroVuelo: 'CV901', callsign: 'CVA901', aerolinea: 'Cargolux',
    origenIata: 'HKG', destinoIata: 'NLU', fechaOperacion: '2026-08-01',
    etdProgramado: '2026-08-01T02:00:00.000Z', etaProgramado: '2026-08-01T10:00:00.000Z',
    etdReal: '2026-08-01T02:10:00.000Z', etaEstimado: '2026-08-01T10:15:00.000Z',
    arriboReal: null, estado: 'en_vuelo', fuente: 'adsb', ultimaLat: 20.5, ultimaLon: -100.1,
    ultimaAltitudFt: 35000, ultimaConsultaAt: '2026-08-01T09:00:00.000Z',
  },
  prealertas: [
    {
      id: 'pa-1', version: 1, recibidoAt: '2026-08-01T01:00:00.000Z', remitente: 'cliente@acme.com',
      asunto: 'Prealerta vuelo CV901', estado: 'aceptada', motivoRechazo: null, parserVersion: 'v3',
      messageId: 'msg-1',
      parsed: { fields: {}, warnings: [{ code: 'piezas_no_encontrado', field: 'piezas', detail: 'No se encontró el campo' }] },
      rawFileId: 'raw-1',
      adjuntos: [
        {
          id: 'adj-1', tipo: 'awb' as const, originalName: 'awb-369-94705516.pdf',
          contentHash: 'a'.repeat(64), scanVerdict: 'clean', fileId: 'file-1',
        },
      ],
    },
  ],
  timeline: [
    {
      id: 'ev-1', tipo: 'prealerta_recibida', origen: 'correo', ocurridoAt: '2026-08-01T10:05:00.000Z',
      registradoAt: '2026-08-01T10:11:00.000Z', override: false, motivo: null, payload: {},
    },
  ],
};

const apiGetMock = vi.fn(async (url: string) => {
  if (url.startsWith('/api/operaciones/')) return detail;
  if (url.startsWith('/api/operaciones')) return [listItem, heldItem];
  throw new Error(`unexpected url: ${url}`);
});

vi.mock('../api', () => ({
  apiGet: (url: string) => apiGetMock(url),
  apiDownload: vi.fn(async () => undefined),
}));

describe('PrealertasView', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the list with route, vuelo, ETA and discrepancias badge', async () => {
    render(<PrealertasView />);
    await waitFor(() => expect(screen.getByText('369-94705516')).toBeTruthy());
    expect(screen.getAllByText('Acme Corp').length).toBeGreaterThan(0);
    expect(screen.getAllByText('HKG → NLU').length).toBeGreaterThan(0);
    expect(screen.getAllByText('CV901').length).toBeGreaterThan(0);
    expect(screen.getByText('1')).toBeTruthy(); // discrepancias badge count
    expect(screen.getByText('Hold')).toBeTruthy(); // held row badge
  });

  it('filters by free-text search', async () => {
    render(<PrealertasView />);
    await waitFor(() => expect(screen.getByText('369-94705516')).toBeTruthy());
    apiGetMock.mockClear();

    fireEvent.change(screen.getByPlaceholderText('Buscar por guía máster o vuelo'), { target: { value: '369-1111' } });

    await waitFor(() => {
      const called = apiGetMock.mock.calls.some(([url]) => typeof url === 'string' && url.includes('q=369-1111'));
      expect(called).toBeTruthy();
    }, { timeout: 1000 });
  });

  it('opens the detail modal showing state axes, English semáforo, and declared vs observed flight', async () => {
    render(<PrealertasView />);
    await waitFor(() => expect(screen.getByText('369-94705516')).toBeTruthy());

    fireEvent.click(screen.getByText('369-94705516'));

    await waitFor(() => expect(screen.getByText('Vuelo declarado vs. observado')).toBeTruthy());
    // Semáforo shown verbatim in English, not translated to "verde".
    expect(screen.getByText('green')).toBeTruthy();
    // Declared vs observed comparison — both sides present.
    expect(screen.getByText('Declarado (prealerta)')).toBeTruthy();
    expect(screen.getByText('Observado (feed de vuelo)')).toBeTruthy();
  });

  it('shows the full SHA-256 hash and parser warnings in the evidence block', async () => {
    render(<PrealertasView />);
    await waitFor(() => expect(screen.getByText('369-94705516')).toBeTruthy());
    fireEvent.click(screen.getByText('369-94705516'));

    await waitFor(() => expect(screen.getByText('awb-369-94705516.pdf')).toBeTruthy());
    expect(screen.getByText('a'.repeat(64))).toBeTruthy();
    expect(screen.getByText('piezas_no_encontrado')).toBeTruthy();
  });

  it('shows "sin verificar" when there is no observed flight data', async () => {
    apiGetMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/operaciones/')) return { ...detail, vuelo: null };
      if (url.startsWith('/api/operaciones')) return [listItem, heldItem];
      throw new Error('unexpected');
    });
    render(<PrealertasView />);
    await waitFor(() => expect(screen.getByText('369-94705516')).toBeTruthy());
    fireEvent.click(screen.getByText('369-94705516'));

    await waitFor(() => expect(screen.getByText(/Sin verificar — no hay datos de vuelo/)).toBeTruthy());
  });

  it('shows the timeline with both ocurrido and registrado when they differ', async () => {
    render(<PrealertasView />);
    await waitFor(() => expect(screen.getByText('369-94705516')).toBeTruthy());
    fireEvent.click(screen.getByText('369-94705516'));

    await waitFor(() => expect(screen.getByText(/ocurrió .* · registrado /)).toBeTruthy());
  });

  it('renders an empty state when there are no operaciones', async () => {
    apiGetMock.mockImplementation(async () => []);
    render(<PrealertasView />);
    await waitFor(() => expect(screen.getByText('Sin prealertas')).toBeTruthy());
  });
});
