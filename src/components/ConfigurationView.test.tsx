import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import ConfigurationView from './ConfigurationView';
import { AuthProvider } from '../context/AuthContext';
// Mock api module — must be hoisted before any imports
vi.mock('../api', () => ({
  apiGet: vi.fn(async (path: string) => {
    if (path.includes('/api/auth/me')) return { id: '1', username: 'superadmin', role: 'super_admin' };
    if (path.includes('prohibited')) return { key: 'prohibited', value: ['faro', 'llanta'] };
    if (path.includes('piracy_brands')) return { key: 'piracy_brands', value: ['TestBrand'] };
    if (path.includes('branding')) return { key: 'branding', value: null };
    if (path.includes('validation_params')) return { key: 'validation_params', value: null };
    if (path.includes('tasa_vigencias')) return { key: 'tasa_vigencias', value: null };
    if (path.includes('/clients')) return [];
    if (path.includes('/validated-rfcs')) return [];
    if (path.includes('/agentes-aduanales')) return [];
    if (path.includes('/importadores')) return [];
    return { key: '', value: null };
  }),
  apiPut: vi.fn(async () => ({ key: 'prohibited', value: [] })),
  apiPost: vi.fn(async () => ({ id: '1' })),
  apiDelete: vi.fn(async () => ({ ok: true })),
  apiDownload: vi.fn(async () => undefined),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

function Wrapper({ children }: { children: import('react').ReactNode }) {
  return (
    <AuthProvider>{children}</AuthProvider>
  );
}

describe('ConfigurationView', () => {
  it('renders the Motor de riesgo domain: params + exclusion lists together', () => {
    render(
      <Wrapper>
        <ConfigurationView domain="cfg_motor" onToast={() => {}} />
      </Wrapper>,
    );
    expect(screen.getByText(/Parámetros de validación/)).toBeTruthy();
    expect(screen.getByText(/Artículos prohibidos/)).toBeTruthy();
    expect(screen.getByText(/Marcas de piratería/)).toBeTruthy();
  });

  it('renders Clientes on its own domain pane', () => {
    render(
      <Wrapper>
        <ConfigurationView domain="cfg_clientes" onToast={() => {}} />
      </Wrapper>,
    );
    // The section title comes from the page layout (SECTION_META), not the pane itself;
    // assert on the Clientes-pane search field, which is unique to this domain.
    expect(screen.getByPlaceholderText('Buscar por nombre, RFC o email')).toBeTruthy();
  });

  it('loads config from the API on mount', async () => {
    const { apiGet } = await import('../api');
    const spy = vi.mocked(apiGet);
    render(
      <Wrapper>
        <ConfigurationView domain="cfg_motor" onToast={() => {}} />
      </Wrapper>,
    );
    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith('/api/catalogs/config/prohibited');
      expect(spy).toHaveBeenCalledWith('/api/catalogs/config/piracy_brands');
      expect(spy).toHaveBeenCalledWith('/api/catalogs/config/branding');
    });
  });

  it('shows restricted banner for non-admin users', () => {
    render(
      <Wrapper>
        <ConfigurationView domain="cfg_motor" onToast={() => {}} />
      </Wrapper>,
    );
    // No user logged in → isAdmin is false
    expect(screen.getByText(/restringid/i)).toBeTruthy();
  });

  it('hides platforms in the table and reveals them in the client detail modal', async () => {
    const { apiGet } = await import('../api');
    vi.mocked(apiGet).mockImplementation(async (path: string) => {
      if (path.includes('/clients')) {
        return [{ id: 'cl1', name: 'ACME', platforms: [{ id: 'p1', commercialName: 'Shop A', countryOfOrigin: 'CN' }] }];
      }
      if (path.includes('/validated-rfcs')) return [];
      return { key: '', value: null };
    });
    render(
      <Wrapper>
        <ConfigurationView domain="cfg_clientes" onToast={() => {}} />
      </Wrapper>,
    );
    // The row shows the client but not its platform name…
    await waitFor(() => expect(screen.getByText('ACME')).toBeTruthy());
    expect(screen.queryByText('Shop A')).toBeNull();
    // …clicking the row opens the detail modal where the platform is listed.
    fireEvent.click(screen.getByText('ACME'));
    await waitFor(() => expect(screen.getByText('Shop A')).toBeTruthy());
  });
});

/** Base apiGet mock for cfg_entidades tests: super_admin user + empty catalogs + all other config
 *  endpoints inert, unless overridden per-test. */
function mockEntidadesApi(overrides: Record<string, unknown> = {}) {
  return async (path: string) => {
    if (path.includes('/api/auth/me')) return overrides.me ?? { id: '1', username: 'superadmin', role: 'super_admin' };
    if (path.includes('/agentes-aduanales')) return overrides.agentes ?? [];
    if (path.includes('/importadores')) return overrides.importadores ?? [];
    if (path.includes('prohibited')) return { key: 'prohibited', value: [] };
    if (path.includes('piracy_brands')) return { key: 'piracy_brands', value: [] };
    if (path.includes('branding')) return { key: 'branding', value: null };
    if (path.includes('validation_params')) return { key: 'validation_params', value: null };
    if (path.includes('tasa_vigencias')) return { key: 'tasa_vigencias', value: null };
    if (path.includes('/clients')) return [];
    if (path.includes('/validated-rfcs')) return [];
    return { key: '', value: null };
  };
}

const AGENTE_FIXTURE = {
  id: 'ag1', patente: '3210', name: 'AGENTE SA', agentRfc: 'AGT010101ZZZ', agencyRfc: 'AGC010101ZZZ',
  verified: false, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
};
const IMPORTADOR_FIXTURE = {
  id: 'im1', rfc: 'IMP010101AAA', name: 'IMPORTADOR SA', fiscalAddress: 'Calle 1',
  verified: false, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
};

describe('ConfigurationView — cfg_entidades (Agentes aduanales / Importadores)', () => {
  // Set a token in localStorage so AuthProvider restores the super_admin user
  beforeEach(() => {
    localStorage.setItem('token', 'mock-token');
    vi.clearAllMocks();
  });

  afterEach(() => {
    localStorage.removeItem('token');
  });

  it('renders both tables from GET, with rows and an "Sin verificar" badge', async () => {
    const { apiGet } = await import('../api');
    vi.mocked(apiGet).mockImplementation(mockEntidadesApi({ agentes: [AGENTE_FIXTURE], importadores: [IMPORTADOR_FIXTURE] }));

    render(
      <Wrapper>
        <ConfigurationView domain="cfg_entidades" onToast={() => {}} />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(screen.getByText(/agentes aduanales/i)).toBeTruthy();
      expect(screen.getByText(/importadores/i)).toBeTruthy();
    });
    expect(screen.getByText('3210')).toBeTruthy();
    expect(screen.getByText('AGENTE SA')).toBeTruthy();
    expect(screen.getByText('IMP010101AAA')).toBeTruthy();
    expect(screen.getByText('IMPORTADOR SA')).toBeTruthy();
    expect(screen.getAllByText('Sin verificar').length).toBe(2);
  });

  it('shows an empty state when no entities are registered', async () => {
    const { apiGet } = await import('../api');
    vi.mocked(apiGet).mockImplementation(mockEntidadesApi());

    render(
      <Wrapper>
        <ConfigurationView domain="cfg_entidades" onToast={() => {}} />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(screen.getAllByText(/se registran automáticamente al subir/i).length).toBeGreaterThan(0);
    });
  });

  it('"Verificar" PUTs { verified: true } and the badge updates to "Verificado"', async () => {
    const { apiGet, apiPut } = await import('../api');
    // Mutate a shared fixture in the apiPut mock so the refetch triggered by
    // onAgentesChanged() reflects the server-side update, like the real API would.
    const agentesData = [{ ...AGENTE_FIXTURE }];
    vi.mocked(apiGet).mockImplementation(mockEntidadesApi({ agentes: agentesData }));
    vi.mocked(apiPut).mockImplementation(async (_path: string, body: unknown) => {
      Object.assign(agentesData[0], body as object);
      return agentesData[0];
    });

    render(
      <Wrapper>
        <ConfigurationView domain="cfg_entidades" onToast={() => {}} />
      </Wrapper>,
    );

    await waitFor(() => expect(screen.getByText('3210')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /verificar/i }));

    await waitFor(() => {
      expect(vi.mocked(apiPut)).toHaveBeenCalledWith('/api/catalogs/agentes-aduanales/ag1', { verified: true });
    });

    await waitFor(() => expect(screen.getByText('Verificado')).toBeTruthy());
  });

  it('row edit PUTs the changed fields for the importador', async () => {
    const { apiGet, apiPut } = await import('../api');
    vi.mocked(apiGet).mockImplementation(mockEntidadesApi({ importadores: [IMPORTADOR_FIXTURE] }));
    vi.mocked(apiPut).mockResolvedValue({ ...IMPORTADOR_FIXTURE, name: 'IMPORTADOR NUEVO SA' });

    render(
      <Wrapper>
        <ConfigurationView domain="cfg_entidades" onToast={() => {}} />
      </Wrapper>,
    );

    await waitFor(() => expect(screen.getByText('IMP010101AAA')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /editar/i }));

    const nameInput = screen.getByDisplayValue('IMPORTADOR SA');
    fireEvent.change(nameInput, { target: { value: 'IMPORTADOR NUEVO SA' } });
    fireEvent.click(screen.getByRole('button', { name: /guardar/i }));

    await waitFor(() => {
      expect(vi.mocked(apiPut)).toHaveBeenCalledWith('/api/catalogs/importadores/im1', {
        name: 'IMPORTADOR NUEVO SA',
        fiscalAddress: 'Calle 1',
      });
    });
  });

  it('shows edit/verify actions for admin (server gate is admin+super_admin)', async () => {
    const { apiGet } = await import('../api');
    vi.mocked(apiGet).mockImplementation(mockEntidadesApi({ me: { id: '2', username: 'admin', role: 'admin' }, agentes: [AGENTE_FIXTURE] }));

    render(
      <Wrapper>
        <ConfigurationView domain="cfg_entidades" onToast={() => {}} />
      </Wrapper>,
    );

    await waitFor(() => expect(screen.getByText('3210')).toBeTruthy());
    expect(screen.getByRole('button', { name: /verificar/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /editar/i })).toBeTruthy();
  });

  it('hides edit/verify actions for capturista', async () => {
    const { apiGet } = await import('../api');
    vi.mocked(apiGet).mockImplementation(mockEntidadesApi({ me: { id: '3', username: 'cap', role: 'capturista' }, agentes: [AGENTE_FIXTURE] }));

    render(
      <Wrapper>
        <ConfigurationView domain="cfg_entidades" onToast={() => {}} />
      </Wrapper>,
    );

    await waitFor(() => expect(screen.getByText('3210')).toBeTruthy());
    expect(screen.queryByRole('button', { name: /verificar/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /editar/i })).toBeNull();
  });
});

/** apiGet mock for the demo-reset card: /me carries { role, demoMode } per test; catalogs are inert. */
function mockDemoApi(me: { role: string; demoMode?: boolean }) {
  return async (path: string) => {
    if (path.includes('/api/auth/me')) return { id: '1', username: 'u', ...me };
    if (path.includes('prohibited')) return { key: 'prohibited', value: [] };
    if (path.includes('piracy_brands')) return { key: 'piracy_brands', value: [] };
    if (path.includes('branding')) return { key: 'branding', value: null };
    if (path.includes('validation_params')) return { key: 'validation_params', value: null };
    if (path.includes('tasa_vigencias')) return { key: 'tasa_vigencias', value: null };
    if (path.includes('/clients')) return [];
    if (path.includes('/validated-rfcs')) return [];
    if (path.includes('/agentes-aduanales')) return [];
    if (path.includes('/importadores')) return [];
    return { key: '', value: null };
  };
}

describe('ConfigurationView — Modo demostración (demo-reset card)', () => {
  // A token in localStorage triggers AuthProvider to restore the user from /api/auth/me.
  beforeEach(() => {
    localStorage.setItem('token', 'mock-token');
    vi.clearAllMocks();
  });
  afterEach(() => {
    localStorage.removeItem('token');
  });

  it('hides the card when demoMode is false, even for an admin', async () => {
    const { apiGet } = await import('../api');
    vi.mocked(apiGet).mockImplementation(mockDemoApi({ role: 'admin', demoMode: false }));
    render(
      <Wrapper>
        <ConfigurationView domain="cfg_motor" onToast={() => {}} />
      </Wrapper>,
    );
    // Wait for the admin restore to complete (params section is admin-editable).
    await waitFor(() => expect(screen.getByText(/Parámetros de validación/)).toBeTruthy());
    expect(screen.queryByText('Modo demostración')).toBeNull();
    expect(screen.queryByRole('button', { name: /Restablecer datos de demostración/i })).toBeNull();
  });

  it('hides the card when demoMode is true but the user is a capturista', async () => {
    const { apiGet } = await import('../api');
    vi.mocked(apiGet).mockImplementation(mockDemoApi({ role: 'capturista', demoMode: true }));
    render(
      <Wrapper>
        <ConfigurationView domain="cfg_motor" onToast={() => {}} />
      </Wrapper>,
    );
    // capturista sees the restricted banner; the demo card must still be absent.
    await waitFor(() => expect(screen.getByText(/restringid/i)).toBeTruthy());
    expect(screen.queryByText('Modo demostración')).toBeNull();
  });

  it('shows the card for an admin in demo mode; the confirm button is gated on typing BORRAR', async () => {
    const { apiGet } = await import('../api');
    vi.mocked(apiGet).mockImplementation(mockDemoApi({ role: 'admin', demoMode: true }));
    render(
      <Wrapper>
        <ConfigurationView domain="cfg_motor" onToast={() => {}} />
      </Wrapper>,
    );
    await waitFor(() => expect(screen.getByText('Modo demostración')).toBeTruthy());

    // Open the confirm modal.
    fireEvent.click(screen.getByRole('button', { name: /Restablecer datos de demostración/i }));

    const confirmBtn = screen.getByRole('button', { name: /Eliminar todo/i }) as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);

    // Wrong text keeps it disabled.
    const input = screen.getByLabelText(/Confirmar escribiendo BORRAR/i);
    fireEvent.change(input, { target: { value: 'borrar' } });
    expect(confirmBtn.disabled).toBe(true);

    // Exact word enables it.
    fireEvent.change(input, { target: { value: 'BORRAR' } });
    expect(confirmBtn.disabled).toBe(false);
  });

  it('success path fires the API call and a toast with the deleted counts', async () => {
    const { apiGet, apiPost } = await import('../api');
    vi.mocked(apiGet).mockImplementation(mockDemoApi({ role: 'super_admin', demoMode: true }));
    vi.mocked(apiPost).mockResolvedValue({ deleted: { manifests: 3, pedimentos: 5, shipments: 7, files: 9 } });
    const onToast = vi.fn();

    render(
      <Wrapper>
        <ConfigurationView domain="cfg_motor" onToast={onToast} />
      </Wrapper>,
    );
    await waitFor(() => expect(screen.getByText('Modo demostración')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /Restablecer datos de demostración/i }));
    fireEvent.change(screen.getByLabelText(/Confirmar escribiendo BORRAR/i), { target: { value: 'BORRAR' } });
    fireEvent.click(screen.getByRole('button', { name: /Eliminar todo/i }));

    await waitFor(() => {
      expect(vi.mocked(apiPost)).toHaveBeenCalledWith('/api/admin/demo-reset', {});
    });
    await waitFor(() => {
      expect(onToast).toHaveBeenCalledWith('🔄 3 manifiestos y 5 pedimentos eliminados.');
    });
  });
});
