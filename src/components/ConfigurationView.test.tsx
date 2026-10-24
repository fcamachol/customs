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
    expect(screen.getByText(/Descripciones genéricas/)).toBeTruthy();
  });

  it('el editor de descripciones genéricas avisa que REEMPLAZA la lista de fábrica', () => {
    // No es un matiz de copy: quien escriba tres palabras aquí creyendo que las agrega a la lista
    // del motor apagaría en silencio las ~90 que trae de fábrica.
    render(
      <Wrapper>
        <ConfigurationView domain="cfg_motor" onToast={() => {}} />
      </Wrapper>,
    );
    expect(screen.getByText(/reemplaza/i)).toBeTruthy();
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
    if (path.includes('/clients')) return overrides.clients ?? [];
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

  /**
   * CORREGIR UN CLIENTE NO DEBE COSTAR SU EXPEDIENTE.
   *
   * El `PUT /api/catalogs/clients/:id` existía, pero el detalle era de sólo lectura: la única forma
   * de arreglar un RFC mal capturado era borrar el cliente, y ese DELETE va en cascada sobre
   * plataformas, direcciones, tarifas, mapeos de columnas y los convenios firmados NOM-151.
   */
  it('permite editar los datos del cliente en lugar de obligar a borrarlo', async () => {
    const { apiGet, apiPut } = await import('../api');
    vi.mocked(apiGet).mockImplementation(mockEntidadesApi({
      clients: [{ id: 'cl1', name: 'ACME', tax_id: 'AAA010101AAA', email: 'a@acme.mx', platforms: [] }],
    }));
    vi.mocked(apiPut).mockResolvedValue({ id: 'cl1', name: 'ACME' });

    render(<Wrapper><ConfigurationView domain="cfg_clientes" onToast={() => {}} /></Wrapper>);
    await waitFor(() => expect(screen.getByText('ACME')).toBeTruthy());
    fireEvent.click(screen.getByText('ACME'));

    await waitFor(() => expect(screen.getByRole('button', { name: /editar datos/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /editar datos/i }));

    fireEvent.change(screen.getByLabelText('Id fiscal'), { target: { value: 'bbb020202bbb' } });
    fireEvent.click(screen.getByRole('button', { name: /guardar datos/i }));

    await waitFor(() => {
      expect(vi.mocked(apiPut)).toHaveBeenCalledWith(
        '/api/catalogs/clients/cl1',
        expect.objectContaining({ tax_id: 'BBB020202BBB' }),
      );
    });
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
      // El RFC viaja en el patch desde que es editable: es la llave del catálogo y el OCR se
      // equivoca justo ahí, produciendo dos filas para la misma empresa.
      expect(vi.mocked(apiPut)).toHaveBeenCalledWith('/api/catalogs/importadores/im1', {
        rfc: 'IMP010101AAA',
        name: 'IMPORTADOR NUEVO SA',
        fiscalAddress: 'Calle 1',
      });
    });
  });

  // Lo que hacía imposible limpiar el catálogo: el RFC se pintaba como texto, no como campo.
  it('el RFC del importador es editable — es donde el OCR se equivoca', async () => {
    const { apiGet, apiPut } = await import('../api');
    vi.mocked(apiGet).mockImplementation(mockEntidadesApi({ importadores: [IMPORTADOR_FIXTURE] }));
    vi.mocked(apiPut).mockResolvedValue({ ...IMPORTADOR_FIXTURE, rfc: 'IMP010101AB7' });

    render(<Wrapper><ConfigurationView domain="cfg_entidades" onToast={() => {}} /></Wrapper>);
    await waitFor(() => expect(screen.getByText('IMP010101AAA')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /editar/i }));

    const rfcInput = screen.getByDisplayValue('IMP010101AAA');
    fireEvent.change(rfcInput, { target: { value: 'IMP010101AB7' } });
    fireEvent.click(screen.getByRole('button', { name: /guardar/i }));

    await waitFor(() => {
      expect(vi.mocked(apiPut)).toHaveBeenCalledWith(
        '/api/catalogs/importadores/im1',
        expect.objectContaining({ rfc: 'IMP010101AB7' }),
      );
    });
  });

  // La patente es la llave del agente: mal leída, deja la fila inservible y bloquea esa patente.
  it('la patente del agente es editable', async () => {
    const { apiGet, apiPut } = await import('../api');
    vi.mocked(apiGet).mockImplementation(mockEntidadesApi({ agentes: [AGENTE_FIXTURE] }));
    vi.mocked(apiPut).mockResolvedValue(AGENTE_FIXTURE);

    render(<Wrapper><ConfigurationView domain="cfg_entidades" onToast={() => {}} /></Wrapper>);
    await waitFor(() => expect(screen.getByText(AGENTE_FIXTURE.patente)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /editar/i }));

    const patenteInput = screen.getByDisplayValue(AGENTE_FIXTURE.patente);
    fireEvent.change(patenteInput, { target: { value: '9999' } });
    fireEvent.click(screen.getByRole('button', { name: /guardar/i }));

    await waitFor(() => {
      expect(vi.mocked(apiPut)).toHaveBeenCalledWith(
        `/api/catalogs/agentes-aduanales/${AGENTE_FIXTURE.id}`,
        expect.objectContaining({ patente: '9999' }),
      );
    });
  });

  // El endpoint sabía diagnosticar duplicados desde antes; esto es lo que faltaba para curarlos.
  it('ofrece eliminar el duplicado que el servidor detectó, nombrando cuál se conserva', async () => {
    const { apiGet, apiDelete } = await import('../api');
    const valido = { ...IMPORTADOR_FIXTURE, id: 'ok1', rfc: 'CCE180415AB7', name: 'CAPITAL SA' };
    const malo = { ...IMPORTADOR_FIXTURE, id: 'bad1', rfc: 'CCE180415AB2', name: 'CAPITAL SA' };
    vi.mocked(apiGet).mockImplementation((url: string) => {
      if (url.includes('/importadores/duplicados')) return Promise.resolve([{ valido, sospechoso: malo }]);
      return mockEntidadesApi({ importadores: [valido, malo] })(url);
    });
    vi.mocked(apiDelete).mockResolvedValue(undefined);

    render(<Wrapper><ConfigurationView domain="cfg_entidades" onToast={() => {}} /></Wrapper>);
    await waitFor(() => expect(screen.getByText(/importador duplicado/i)).toBeTruthy());
    expect(screen.getByText(/CCE180415AB7 · conservar/)).toBeTruthy();

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: /eliminar duplicado/i }));
    await waitFor(() => {
      expect(vi.mocked(apiDelete)).toHaveBeenCalledWith('/api/catalogs/importadores/bad1');
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

    // Unchecked (the default): the confirm modal carries no extra warning, and the body is the
    // pre-PRD-02 shape — no incluirOperaciones key at all.
    fireEvent.click(screen.getByRole('button', { name: /Restablecer datos de demostración/i }));
    expect(screen.queryByText(/bitácora de operaciones \(ledger\)/i)).toBeNull();
    fireEvent.change(screen.getByLabelText(/Confirmar escribiendo BORRAR/i), { target: { value: 'BORRAR' } });
    fireEvent.click(screen.getByRole('button', { name: /Eliminar todo/i }));

    await waitFor(() => {
      expect(vi.mocked(apiPost)).toHaveBeenCalledWith('/api/admin/demo-reset', {});
    });
    await waitFor(() => {
      expect(onToast).toHaveBeenCalledWith('🔄 3 manifiestos y 5 pedimentos eliminados.');
    });
  });

  it('the "Incluir operaciones" checkbox is unchecked by default', async () => {
    const { apiGet } = await import('../api');
    vi.mocked(apiGet).mockImplementation(mockDemoApi({ role: 'admin', demoMode: true }));
    render(
      <Wrapper>
        <ConfigurationView domain="cfg_motor" onToast={() => {}} />
      </Wrapper>,
    );
    await waitFor(() => expect(screen.getByText('Modo demostración')).toBeTruthy());
    const checkbox = screen.getByLabelText(/Incluir operaciones/i) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
  });

  it('checked: posts { incluirOperaciones: true }, warns about the wider blast radius, and shows the ops counts in the toast', async () => {
    const { apiGet, apiPost } = await import('../api');
    vi.mocked(apiGet).mockImplementation(mockDemoApi({ role: 'super_admin', demoMode: true }));
    vi.mocked(apiPost).mockResolvedValue({
      deleted: { manifests: 1, pedimentos: 2, shipments: 1, files: 1, operaciones: 4, prealertas: 0, despachos: 3, pods: 2, facturas: 1 },
      superficies: { manifiestos: true, archivos: true, operaciones: true, catalogosDurables: false },
      conservado: { catalogosDurables: ['transportistas', 'convenios'], transportistas: 5, convenios: 2 },
    });
    const onToast = vi.fn();

    render(
      <Wrapper>
        <ConfigurationView domain="cfg_motor" onToast={onToast} />
      </Wrapper>,
    );
    await waitFor(() => expect(screen.getByText('Modo demostración')).toBeTruthy());

    fireEvent.click(screen.getByLabelText(/Incluir operaciones/i));
    fireEvent.click(screen.getByRole('button', { name: /Restablecer datos de demostración/i }));

    // The confirm step names the bigger blast radius: the ledger goes, catalogs/convenios survive.
    expect(screen.getByText(/bitácora de operaciones \(ledger\)/i)).toBeTruthy();
    expect(screen.getByText(/catálogos durables — transportistas, convenios y tarifas — se conservan/i)).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/Confirmar escribiendo BORRAR/i), { target: { value: 'BORRAR' } });
    fireEvent.click(screen.getByRole('button', { name: /Eliminar todo/i }));

    await waitFor(() => {
      expect(vi.mocked(apiPost)).toHaveBeenCalledWith('/api/admin/demo-reset', { incluirOperaciones: true });
    });
    await waitFor(() => {
      expect(onToast).toHaveBeenCalledWith(
        '🔄 1 manifiesto y 2 pedimentos eliminados. También 3 despachos, 2 PODs, 1 factura y la bitácora de ' +
        'operaciones. Catálogos durables conservados: 5 transportistas, 2 convenios.',
      );
    });
  });
});
