import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import ConfigurationView from './ConfigurationView';
import { AuthProvider } from '../context/AuthContext';
// Mock api module — must be hoisted before any imports
vi.mock('../api', () => ({
  apiGet: vi.fn(async (path: string) => {
    if (path.includes('prohibited')) return { key: 'prohibited', value: ['faro', 'llanta'] };
    if (path.includes('piracy_brands')) return { key: 'piracy_brands', value: ['TestBrand'] };
    if (path.includes('branding')) return { key: 'branding', value: null };
    if (path.includes('validation_params')) return { key: 'validation_params', value: null };
    if (path.includes('tasa_vigencias')) return { key: 'tasa_vigencias', value: null };
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
    expect(screen.getByText('Clientes')).toBeTruthy();
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
});
