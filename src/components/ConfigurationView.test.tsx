import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import ConfigurationView from './ConfigurationView';
import { AuthProvider } from '../context/AuthContext';
import { T1Provider } from '../context/T1Context';

// Mock api module — must be hoisted before any imports
vi.mock('../api', () => ({
  apiGet: vi.fn(async (path: string) => {
    if (path.includes('prohibited')) return { key: 'prohibited', value: ['faro', 'llanta'] };
    if (path.includes('piracy_brands')) return { key: 'piracy_brands', value: ['TestBrand'] };
    if (path.includes('branding')) return { key: 'branding', value: null };
    return { key: '', value: null };
  }),
  apiPut: vi.fn(async () => ({ key: 'prohibited', value: [] })),
  apiPost: vi.fn(async () => ({ token: 't', user: { id: '1', username: 'admin', role: 'admin' } })),
  apiDownload: vi.fn(async () => undefined),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

function Wrapper({ children }: { children: import('react').ReactNode }) {
  return (
    <AuthProvider>
      <T1Provider>{children}</T1Provider>
    </AuthProvider>
  );
}

describe('ConfigurationView', () => {
  it('mounts and renders DB catalogs section', async () => {
    render(
      <Wrapper>
        <ConfigurationView onToast={() => {}} />
      </Wrapper>,
    );
    // The catalog section renders (may be loading initially)
    // Heading is always rendered
    expect(screen.getByText(/Catálogos de Riesgo/)).toBeTruthy();
  });

  it('loads prohibited keywords and brands from the API on mount', async () => {
    const { apiGet } = await import('../api');
    const spy = vi.mocked(apiGet);
    render(
      <Wrapper>
        <ConfigurationView onToast={() => {}} />
      </Wrapper>,
    );
    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith('/api/catalogs/config/prohibited');
      expect(spy).toHaveBeenCalledWith('/api/catalogs/config/piracy_brands');
      expect(spy).toHaveBeenCalledWith('/api/catalogs/config/branding');
    });
  });

  it('shows the 78/LA simulator requirements', () => {
    render(
      <Wrapper>
        <ConfigurationView onToast={() => {}} />
      </Wrapper>,
    );
    expect(screen.getByText(/RFC activo/i)).toBeTruthy();
  });

  it('shows restricted banner for non-admin users', () => {
    render(
      <Wrapper>
        <ConfigurationView onToast={() => {}} />
      </Wrapper>,
    );
    // No user logged in → isAdmin is false
    expect(screen.getByText(/Configuración restringida/i)).toBeTruthy();
  });
});
