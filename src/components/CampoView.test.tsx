// src/components/CampoView.test.tsx
//
// Coverage note on the App.tsx fallback fix: the task asked for App.tsx's active-section fallback
// to use the role's first visible section instead of a hardcoded 'dashboard' (since 'tramitador'
// never has 'dashboard' in its visible set — see nav.ts visibleSectionsFor). That change IS
// covered here: the last test in this file mocks '../context/AuthContext' to return a tramitador
// user, renders the real <App />, and asserts CampoView actually mounts (via its "Captura de
// Campo" page title and its own empty-state copy) rather than the app rendering nothing / crashing
// on an invalid SECTION_META lookup.
import type { ReactNode } from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import CampoView from './CampoView';
import App from '../App';
import { visibleSectionsFor } from '../nav';

const tarea1 = {
  id: 'op-1', mawb: '369-94705516', etapa: 'documental',
  arriboVueloAt: '2026-08-01T10:00:00.000Z', disponibleAt: null,
  semaforo: null as 'green' | 'red' | null, numeroVuelo: 'CV901',
};

const tarea2 = {
  id: 'op-2', mawb: '369-11112222', etapa: 'en_patio',
  arriboVueloAt: '2026-08-01T09:00:00.000Z', disponibleAt: '2026-08-01T09:30:00.000Z',
  semaforo: 'green' as const, numeroVuelo: 'CV902',
};

const apiGetMock = vi.fn(async (url: string): Promise<unknown> => {
  if (url === '/api/campo/tareas') return [tarea1, tarea2];
  if (url.includes('branding')) return { key: 'branding', value: null };
  return [];
});
const apiPostMock = vi.fn(async (_url: string, _body: unknown) => ({ ok: true }));
const apiUploadMock = vi.fn(async (_url: string, _form: FormData) => ({ ok: true, hash: 'abcdef0123456789' }));

// vi.mock factories are hoisted above the rest of the module, so the ApiError stand-in must be
// created via vi.hoisted rather than a plain class declaration (which would still be in the
// temporal dead zone when the hoisted factory runs).
const { MockApiError } = vi.hoisted(() => ({
  MockApiError: class MockApiError extends Error {
    status: number;
    body: Record<string, unknown>;
    constructor(message: string, status: number, body: Record<string, unknown>) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.body = body;
    }
  },
}));

vi.mock('../api', () => ({
  ApiError: MockApiError,
  apiGet: (url: string) => apiGetMock(url),
  apiPost: (url: string, body: unknown) => apiPostMock(url, body),
  apiUpload: (url: string, form: FormData) => apiUploadMock(url, form),
}));

// Silent by default — geolocation is a best-effort side channel the component must never block on.
beforeEach(() => {
  vi.stubGlobal('navigator', {
    ...navigator,
    geolocation: { getCurrentPosition: vi.fn((_ok, err) => err?.({ code: 1, message: 'denied' } as GeolocationPositionError)) },
  });
});

async function openPanel() {
  render(<CampoView />);
  await waitFor(() => expect(screen.getByText('369-94705516')).toBeTruthy());
  fireEvent.click(screen.getByText('369-94705516'));
  await waitFor(() => expect(screen.getByText('Disponible')).toBeTruthy());
}

describe('CampoView', () => {
  beforeEach(() => {
    apiGetMock.mockClear();
    apiPostMock.mockClear();
    apiPostMock.mockImplementation(async () => ({ ok: true }));
    apiUploadMock.mockClear();
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('renders the tareas queue as cards with mawb, etapa, vuelo and arribo', async () => {
    render(<CampoView />);
    await waitFor(() => expect(screen.getByText('369-94705516')).toBeTruthy());
    expect(screen.getByText('369-11112222')).toBeTruthy();
    expect(screen.getByText(/documental/)).toBeTruthy();
    expect(screen.getByText(/CV901/)).toBeTruthy();
  });

  it('polls the queue every 60s and stops after unmount', async () => {
    vi.useFakeTimers();
    const { unmount } = render(<CampoView />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(apiGetMock).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(apiGetMock).toHaveBeenCalledTimes(2);

    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(apiGetMock).toHaveBeenCalledTimes(2);
  });

  it('tapping a card opens the full capture panel for that operación', async () => {
    await openPanel();
    expect(screen.getByText('Ingreso a patio')).toBeTruthy();
    expect(screen.getByText('Ingreso a aduana')).toBeTruthy();
    expect(screen.getByText('Inicio de carga')).toBeTruthy();
    expect(screen.getByText('Fin de carga')).toBeTruthy();
    expect(screen.getByText('Modulación')).toBeTruthy();
    expect(screen.getByText('Salida de rojo')).toBeTruthy();
    // Back button returns to the queue.
    fireEvent.click(screen.getByText('Volver a la cola'));
    await waitFor(() => expect(screen.queryByText('Disponible')).toBeNull());
  });

  it.each([
    ['Disponible', 'CARGA_DISPONIBLE'],
    ['Ingreso a patio', 'INGRESO_PATIO'],
    ['Inicio de carga', 'INICIO_CARGA'],
    ['Fin de carga', 'FIN_CARGA'],
    ['Salida de rojo', 'SALIDA_ROJO'],
  ])('tapping "%s" posts tipo %s and shows a success mark', async (label, tipo) => {
    await openPanel();
    fireEvent.click(screen.getByText(label));
    await waitFor(() => expect(apiPostMock).toHaveBeenCalledWith(
      '/api/campo/operaciones/op-1/evento',
      expect.objectContaining({ tipo }),
    ));
    await waitFor(() => expect(screen.getByText(/^✓/)).toBeTruthy());
  });

  it('modulación requires the green/red choice and posts semaforo + ocurridoAt', async () => {
    await openPanel();
    // No POST until a color is chosen.
    fireEvent.click(screen.getByText('Modulación'));
    expect(apiPostMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('green'));
    await waitFor(() => expect(apiPostMock).toHaveBeenCalledWith(
      '/api/campo/operaciones/op-1/evento',
      expect.objectContaining({ tipo: 'MODULACION', semaforo: 'green', ocurridoAt: expect.any(String) }),
    ));
  });

  it('409 renders the server message with etapaActual', async () => {
    apiPostMock.mockImplementation(async () => {
      throw new MockApiError('La operación ya no está en esa etapa.', 409, { error: 'La operación ya no está en esa etapa.', etapaActual: 'en_aduana' });
    });
    await openPanel();
    fireEvent.click(screen.getByText('Ingreso a patio'));
    await waitFor(() => expect(screen.getByText(/La operación ya no está en esa etapa\./)).toBeTruthy());
    expect(screen.getByText(/en aduana/)).toBeTruthy();
  });

  it('a noop response renders as an already-registered state, not an error', async () => {
    apiPostMock.mockImplementation(async () => ({ ok: true, noop: true }));
    await openPanel();
    fireEvent.click(screen.getByText('Fin de carga'));
    await waitFor(() => expect(screen.getByText('Ya registrado')).toBeTruthy());
  });

  it('uploads evidencia via apiUpload with a FormData containing tipo and capturadoAt', async () => {
    await openPanel();
    const file = new File(['x'], 'foto.jpg', { type: 'image/jpeg' });
    const input = screen.getByTestId('foto-inicio_carga') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(apiUploadMock).toHaveBeenCalled());
    const [url, form] = apiUploadMock.mock.calls[0];
    expect(url).toBe('/api/campo/operaciones/op-1/evidencia');
    expect(form instanceof FormData).toBe(true);
    expect((form as FormData).get('tipo')).toBe('inicio_carga');
    expect((form as FormData).get('capturadoAt')).toBeTruthy();
    expect((form as FormData).get('file')).toBe(file);

    await waitFor(() => expect(screen.getByText('abcdef012345')).toBeTruthy());
  });
});

describe('visibleSectionsFor(tramitador)', () => {
  it('returns exactly ops_campo — the tramitador sees nothing else', () => {
    expect(visibleSectionsFor('tramitador')).toEqual(['ops_campo']);
  });
});

// Mocking AuthContext only affects the App-mount test below (CampoView itself never imports it),
// so it's safe to declare at module scope alongside the ../api mock above.
vi.mock('../context/AuthContext', () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => ({
    user: { id: 'u-1', username: 'tramitador1', role: 'tramitador' },
    loading: false,
    logout: vi.fn(),
    login: vi.fn(),
    enrollMfa: vi.fn(),
  }),
}));

describe('App fallback section for a role without dashboard', () => {
  it('mounts CampoView (not a blank/dashboard screen) for a tramitador user', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('Captura de Campo')).toBeTruthy());
    // The queue (CampoView's own content) rendered — proof the fallback section resolved to
    // ops_campo rather than the old hardcoded 'dashboard' (which tramitador cannot see).
    await waitFor(() => expect(screen.getByText('369-94705516')).toBeTruthy());
  });
});
