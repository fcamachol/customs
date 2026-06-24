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
    if (path.includes('importer_of_record')) return { key: 'importer_of_record', value: null };
    if (path.includes('customs_agent')) return { key: 'customs_agent', value: null };
    if (path.includes('/clients')) return [];
    if (path.includes('/validated-rfcs')) return [];
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

describe('ConfigurationView — cfg_entidades (Entidades de pedimento)', () => {
  // Set a token in localStorage so AuthProvider restores the super_admin user
  beforeEach(() => {
    localStorage.setItem('token', 'mock-token');
    vi.clearAllMocks();
  });

  afterEach(() => {
    localStorage.removeItem('token');
  });

  it('renders importer-of-record and customs-agent forms for a super_admin user', async () => {
    render(
      <Wrapper>
        <ConfigurationView domain="cfg_entidades" onToast={() => {}} />
      </Wrapper>,
    );

    // Wait for the auth restore effect + config load
    await waitFor(() => {
      // Importer section
      expect(screen.getByText(/importador de registro/i)).toBeTruthy();
      // Customs agent section
      expect(screen.getByText(/agente aduanal/i)).toBeTruthy();
    });
  });

  it('importer-of-record "Guardar" calls apiPut with correct endpoint and value shape', async () => {
    const { apiGet, apiPut } = await import('../api');
    vi.mocked(apiGet).mockImplementation(async (path: string) => {
      if (path.includes('/api/auth/me')) return { id: '1', username: 'superadmin', role: 'super_admin' };
      if (path.includes('importer_of_record')) return { key: 'importer_of_record', value: { rfc: 'IMP010101AAA', name: 'IMPORTADOR SA', fiscalAddress: 'Calle 1' } };
      if (path.includes('customs_agent')) return { key: 'customs_agent', value: null };
      if (path.includes('prohibited')) return { key: 'prohibited', value: [] };
      if (path.includes('piracy_brands')) return { key: 'piracy_brands', value: [] };
      if (path.includes('branding')) return { key: 'branding', value: null };
      if (path.includes('validation_params')) return { key: 'validation_params', value: null };
      if (path.includes('tasa_vigencias')) return { key: 'tasa_vigencias', value: null };
      if (path.includes('/clients')) return [];
      if (path.includes('/validated-rfcs')) return [];
      return { key: '', value: null };
    });

    render(
      <Wrapper>
        <ConfigurationView domain="cfg_entidades" onToast={() => {}} />
      </Wrapper>,
    );

    // Wait for the section to load and the user to be restored
    await waitFor(() => expect(screen.getByText(/importador de registro/i)).toBeTruthy());

    // The RFC field should be pre-filled from loaded data
    await waitFor(() => {
      const rfcInput = screen.getByDisplayValue('IMP010101AAA');
      expect(rfcInput).toBeTruthy();
    });

    // Click the importer "Guardar" button
    const guardarButtons = screen.getAllByRole('button', { name: /guardar/i });
    // First Guardar is for importer
    fireEvent.click(guardarButtons[0]);

    await waitFor(() => {
      expect(vi.mocked(apiPut)).toHaveBeenCalledWith(
        '/api/catalogs/config/importer_of_record',
        { value: { rfc: 'IMP010101AAA', name: 'IMPORTADOR SA', fiscalAddress: 'Calle 1' } },
      );
    });
  });

  it('customs-agent "Guardar" calls apiPut with correct endpoint and four-field value shape', async () => {
    const { apiGet, apiPut } = await import('../api');
    vi.mocked(apiGet).mockImplementation(async (path: string) => {
      if (path.includes('/api/auth/me')) return { id: '1', username: 'superadmin', role: 'super_admin' };
      if (path.includes('importer_of_record')) return { key: 'importer_of_record', value: null };
      if (path.includes('customs_agent')) return { key: 'customs_agent', value: { patente: '3210', name: 'AGENTE SA', agentRfc: 'AGT010101ZZZ', agencyRfc: 'AGC010101ZZZ' } };
      if (path.includes('prohibited')) return { key: 'prohibited', value: [] };
      if (path.includes('piracy_brands')) return { key: 'piracy_brands', value: [] };
      if (path.includes('branding')) return { key: 'branding', value: null };
      if (path.includes('validation_params')) return { key: 'validation_params', value: null };
      if (path.includes('tasa_vigencias')) return { key: 'tasa_vigencias', value: null };
      if (path.includes('/clients')) return [];
      if (path.includes('/validated-rfcs')) return [];
      return { key: '', value: null };
    });

    render(
      <Wrapper>
        <ConfigurationView domain="cfg_entidades" onToast={() => {}} />
      </Wrapper>,
    );

    await waitFor(() => expect(screen.getByText(/agente aduanal/i)).toBeTruthy());

    // The patente field should be pre-filled from loaded data
    await waitFor(() => {
      const patenteInput = screen.getByDisplayValue('3210');
      expect(patenteInput).toBeTruthy();
    });

    // Click the agent "Guardar" button (second Guardar button)
    const guardarButtons = screen.getAllByRole('button', { name: /guardar/i });
    fireEvent.click(guardarButtons[1]);

    await waitFor(() => {
      expect(vi.mocked(apiPut)).toHaveBeenCalledWith(
        '/api/catalogs/config/customs_agent',
        { value: { patente: '3210', name: 'AGENTE SA', agentRfc: 'AGT010101ZZZ', agencyRfc: 'AGC010101ZZZ' } },
      );
    });
  });

  it('disables "Guardar" buttons when user is not super_admin', async () => {
    const { apiGet } = await import('../api');
    vi.mocked(apiGet).mockImplementation(async (path: string) => {
      if (path.includes('/api/auth/me')) return { id: '2', username: 'admin', role: 'admin' };
      if (path.includes('importer_of_record')) return { key: 'importer_of_record', value: null };
      if (path.includes('customs_agent')) return { key: 'customs_agent', value: null };
      if (path.includes('prohibited')) return { key: 'prohibited', value: [] };
      if (path.includes('piracy_brands')) return { key: 'piracy_brands', value: [] };
      if (path.includes('branding')) return { key: 'branding', value: null };
      if (path.includes('validation_params')) return { key: 'validation_params', value: null };
      if (path.includes('tasa_vigencias')) return { key: 'tasa_vigencias', value: null };
      if (path.includes('/clients')) return [];
      if (path.includes('/validated-rfcs')) return [];
      return { key: '', value: null };
    });

    render(
      <Wrapper>
        <ConfigurationView domain="cfg_entidades" onToast={() => {}} />
      </Wrapper>,
    );

    await waitFor(() => expect(screen.getByText(/importador de registro/i)).toBeTruthy());

    const guardarButtons = screen.getAllByRole('button', { name: /guardar/i });
    guardarButtons.forEach((btn) => {
      expect((btn as HTMLButtonElement).disabled).toBe(true);
    });
  });
});
