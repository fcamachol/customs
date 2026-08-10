// src/components/TransportistasTab.test.tsx
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import ConfigurationView from './ConfigurationView';
import { AuthProvider } from '../context/AuthContext';
import { visibleSectionsFor, SECTION_META, NAV_GROUPS, isParent } from '../nav';

/**
 * What the carrier catalog has to get right:
 *  - it is admin territory, exactly as the server gates it (requireRole('admin'), super_admin being
 *    a superset). A capturista must not even see the destination.
 *  - the list is the readiness summary: fleet and whether there is an agreement in force TODAY.
 *  - creating a carrier posts the fields the API actually accepts, with empty optionals omitted
 *    rather than sent as '' (the RFC carries a UNIQUE constraint).
 *  - D9, the load-bearing one: a rate under a convenio that is not signed-and-in-force is not a
 *    price, and the screen has to say so instead of showing the number on its own.
 */

const TRANSPORTISTAS = [
  {
    id: 't-1', razonSocial: 'Transportes del Bajío', rfc: 'TBA010101AAA',
    contactoNombre: 'Luis Ruiz', contactoTelefono: '5511223344', contactoEmail: 'luis@bajio.mx',
    estado: 'activo', documentosOk: true, unidadesActivas: 2, convenioVigente: false,
  },
  {
    id: 't-2', razonSocial: 'Fletes del Norte', rfc: null,
    contactoNombre: null, contactoTelefono: null, contactoEmail: null,
    estado: 'suspendido', documentosOk: false, unidadesActivas: 0, convenioVigente: true,
  },
];

/**
 * What a DATE column actually looks like on the wire: node-pg parses it to LOCAL midnight and
 * `JSON.stringify` writes that instant in UTC. A bare 'YYYY-MM-DD' in a fixture would be parsed as
 * UTC midnight instead and read back one day early west of Greenwich — the exact bug `diaDe` exists
 * to avoid, so the fixture has to be faithful or the test proves the opposite of what it claims.
 */
const fechaWire = (dia: string): string => new Date(`${dia}T00:00:00`).toISOString();

/** t-1 in full: a fleet, and a DRAFT convenio that nonetheless already carries a negotiated rate. */
const DETALLE_T1 = {
  ...TRANSPORTISTAS[0],
  unidades: [
    {
      id: 'u-1', placas: 'ABC1234', tipoUnidad: 'tracto', numeroEconomico: 'E-01',
      vigenciaSeguro: '2026-12-31', vigenciaVerificacion: '2025-01-31',
      activo: true, seguroVencido: false, verificacionVencida: true,
    },
  ],
  convenios: [
    {
      id: 'c-1', fileId: null, vigenciaDesde: fechaWire('2026-01-01'), vigenciaHasta: fechaWire('2026-12-31'),
      estadoFirma: 'borrador', firmadoAt: null, firmaProveedor: null, firmaReferencia: null,
      firmaEvidenciaFileId: null, notas: null, renovadoDeConvenioId: null, renovadoPorConvenioId: null,
      createdAt: '2026-01-02T00:00:00Z', vigente: false,
      tarifas: [
        {
          id: 'tf-1', tipoUnidad: 'tracto', direccionEntregaId: 'dir-1',
          // Joined server-side: the screen no longer fans out over every client to name a destination.
          destinoAlias: 'IMILE Cuautitlán', clienteNombre: 'ACME',
          tarifa: 18500, moneda: 'MXN', vigenciaDesde: null, vigenciaHasta: null, activo: true,
        },
      ],
    },
  ],
};

/** The same carrier with the convenio SIGNED — the state in which its terms are frozen. */
const DETALLE_T1_FIRMADO = {
  ...DETALLE_T1,
  convenios: [{
    ...DETALLE_T1.convenios[0],
    estadoFirma: 'firmado', vigente: true,
    firmadoAt: '2026-01-03T00:00:00Z', firmaProveedor: 'Mifiel', firmaReferencia: 'REF-9',
  }],
};

interface MockOpts {
  me?: unknown;
  transportistas?: unknown;
  detalle?: unknown;
}

/** ConfigurationView loads every Configuración catalog on mount, whatever pane is showing. */
function mockApi(o: MockOpts = {}) {
  return async (path: string) => {
    if (path.includes('/api/auth/me')) return o.me ?? { id: '1', username: 'admin', role: 'admin' };
    if (path === '/api/transportistas') return o.transportistas ?? TRANSPORTISTAS;
    if (path === '/api/transportistas/t-1') return o.detalle ?? DETALLE_T1;
    if (path === '/api/catalogs/clients') return [{ id: 'cl-1', name: 'ACME' }];
    // One flat catalog for the rate picker. The old per-client fan-out is gone.
    if (path === '/api/catalogs/direcciones') {
      return [{ id: 'dir-1', clientId: 'cl-1', cliente: 'ACME', alias: 'IMILE Cuautitlán', activo: true }];
    }
    if (path.includes('prohibited')) return { key: 'prohibited', value: [] };
    if (path.includes('piracy_brands')) return { key: 'piracy_brands', value: [] };
    if (path.includes('branding')) return { key: 'branding', value: null };
    if (path.includes('validation_params')) return { key: 'validation_params', value: null };
    if (path.includes('tasa_vigencias')) return { key: 'tasa_vigencias', value: null };
    if (path.includes('/agentes-aduanales')) return [];
    if (path.includes('/importadores')) return [];
    if (path.includes('/validated-rfcs')) return [];
    return { key: '', value: null };
  };
}

vi.mock('../api', () => ({
  apiGet: vi.fn(),
  apiPut: vi.fn(async () => ({ ok: true })),
  apiPost: vi.fn(async () => ({ id: 'nuevo', razonSocial: 'Fletes del Norte' })),
  apiDelete: vi.fn(async () => ({ ok: true })),
  apiUpload: vi.fn(async () => ({ ok: true })),
  apiDownload: vi.fn(async () => undefined),
}));

function Wrapper({ children }: { children: import('react').ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}

async function renderPane(o: MockOpts = {}) {
  const { apiGet } = await import('../api');
  vi.mocked(apiGet).mockImplementation(mockApi(o) as never);
  return render(
    <Wrapper>
      <ConfigurationView domain="cfg_transportistas" onToast={() => {}} />
    </Wrapper>,
  );
}

describe('Transportistas — navegación y visibilidad por rol', () => {
  it('is a Configuración destination for admin and super_admin only', () => {
    expect(visibleSectionsFor('admin')).toContain('cfg_transportistas');
    expect(visibleSectionsFor('super_admin')).toContain('cfg_transportistas');
    // Writes are requireRole('admin') server-side; nobody else gets the destination.
    expect(visibleSectionsFor('capturista')).not.toContain('cfg_transportistas');
    expect(visibleSectionsFor('autoridad')).not.toContain('cfg_transportistas');
    expect(visibleSectionsFor('tramitador')).not.toContain('cfg_transportistas');
  });

  it('appears as a child of the Configuración parent, with a title and subtitle', () => {
    const sistema = NAV_GROUPS.find((g) => g.label === 'Sistema')!;
    const config = sistema.items.find((i) => isParent(i) && i.parentId === 'configuracion')!;
    const labels = isParent(config) ? config.children.map((c) => c.label) : [];
    expect(labels).toContain('Transportistas');
    expect(SECTION_META.cfg_transportistas.title).toBe('Transportistas');
    expect(SECTION_META.cfg_transportistas.subtitle).toMatch(/convenios y tarifas/i);
  });
});

describe('TransportistasTab', () => {
  beforeEach(() => {
    localStorage.setItem('token', 'mock-token');
    vi.clearAllMocks();
  });
  afterEach(() => {
    localStorage.removeItem('token');
  });

  it('lists the carriers with fleet and agreement readiness', async () => {
    await renderPane();

    await waitFor(() => expect(screen.getByText('Transportes del Bajío')).toBeTruthy());
    expect(screen.getByText('TBA010101AAA')).toBeTruthy();
    expect(screen.getByText('Luis Ruiz')).toBeTruthy();
    expect(screen.getByText('Fletes del Norte')).toBeTruthy();
    // Both computed-today columns are stated, not implied.
    expect(screen.getByText('Sin convenio vigente')).toBeTruthy();
    expect(screen.getByText('Vigente')).toBeTruthy();
    expect(screen.getByText('Activo')).toBeTruthy();
    expect(screen.getByText('Suspendido')).toBeTruthy();
  });

  it('filters the list by razón social, RFC or contacto', async () => {
    await renderPane();
    await waitFor(() => expect(screen.getByText('Transportes del Bajío')).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText('Buscar por razón social, RFC o contacto'), {
      target: { value: 'norte' },
    });
    expect(screen.queryByText('Transportes del Bajío')).toBeNull();
    expect(screen.getByText('Fletes del Norte')).toBeTruthy();
  });

  it('creates a carrier with the body the API accepts, omitting empty optionals', async () => {
    const { apiPost } = await import('../api');
    await renderPane();
    await waitFor(() => expect(screen.getByText('Transportes del Bajío')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /agregar transportista/i }));
    fireEvent.change(screen.getByLabelText('Razón social *'), { target: { value: '  Fletes del Sur  ' } });
    fireEvent.change(screen.getByLabelText('RFC'), { target: { value: 'fsu010101aaa' } });
    fireEvent.change(screen.getByLabelText('Teléfono'), { target: { value: '5599887766' } });
    fireEvent.click(screen.getByRole('button', { name: /guardar transportista/i }));

    await waitFor(() =>
      expect(vi.mocked(apiPost)).toHaveBeenCalledWith('/api/transportistas', {
        razonSocial: 'Fletes del Sur',
        rfc: 'FSU010101AAA',
        contactoTelefono: '5599887766',
      }),
    );
  });

  it('opens a carrier and shows its fleet, with an expired inspection called out', async () => {
    await renderPane();
    await waitFor(() => expect(screen.getByText('Transportes del Bajío')).toBeTruthy());
    fireEvent.click(screen.getByText('Transportes del Bajío'));

    await waitFor(() => expect(screen.getByText('ABC1234')).toBeTruthy());
    // Both the fleet row and the rate row name the unit type from the shared glossary.
    expect(screen.getAllByText('Tracto').length).toBeGreaterThan(0);
    expect(screen.getByText(/vencida/)).toBeTruthy();
  });

  it('warns that a rate under an unsigned convenio is not a price (D9)', async () => {
    await renderPane();
    await waitFor(() => expect(screen.getByText('Transportes del Bajío')).toBeTruthy());
    fireEvent.click(screen.getByText('Transportes del Bajío'));

    await waitFor(() => expect(screen.getByText(/Tarifas sin efecto/)).toBeTruthy());
    expect(screen.getByText(/no está firmado/)).toBeTruthy();
    expect(screen.getAllByText(/borrador/i).length).toBeGreaterThan(0);
    // A draft can still be signed, and the affordance that fixes the warning is right there.
    expect(screen.getByRole('button', { name: /registrar firma/i })).toBeTruthy();
    // The rate is still shown — it is a real negotiation — and its destination is resolved to a
    // human label rather than left as the raw direccion uuid.
    await waitFor(() => expect(screen.getByText('ACME · IMILE Cuautitlán')).toBeTruthy());
    expect(screen.getByText(/18,500\.00 MXN/)).toBeTruthy();
  });

  it('drops the warning, and the signing affordance, once the convenio is firmado y vigente', async () => {
    await renderPane({ detalle: DETALLE_T1_FIRMADO });
    await waitFor(() => expect(screen.getByText('Transportes del Bajío')).toBeTruthy());
    fireEvent.click(screen.getByText('Transportes del Bajío'));

    await waitFor(() => expect(screen.getByText('Firmado')).toBeTruthy());
    expect(screen.queryByRole('button', { name: /registrar firma/i })).toBeNull();
    expect(screen.queryByText(/Tarifas sin efecto/)).toBeNull();
  });

  it('signs a convenio through /firmar with proveedor and referencia', async () => {
    const { apiPost } = await import('../api');
    await renderPane();
    await waitFor(() => expect(screen.getByText('Transportes del Bajío')).toBeTruthy());
    fireEvent.click(screen.getByText('Transportes del Bajío'));
    await waitFor(() => expect(screen.getByRole('button', { name: /registrar firma/i })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /registrar firma/i }));
    fireEvent.change(screen.getByLabelText('Proveedor de firma *'), { target: { value: 'Mifiel' } });
    fireEvent.change(screen.getByLabelText('Referencia *'), { target: { value: 'REF-9' } });
    fireEvent.click(screen.getByRole('button', { name: /firmar convenio/i }));

    await waitFor(() =>
      expect(vi.mocked(apiPost)).toHaveBeenCalledWith('/api/transportistas/t-1/convenios/c-1/firmar', {
        firmaProveedor: 'Mifiel',
        firmaReferencia: 'REF-9',
      }),
    );
  });

  /**
   * The three API gaps this screen surfaced, from the consumer's side.
   */
  it('reads the destination catalog ONCE and flat, never client by client', async () => {
    const { apiGet } = await import('../api');
    await renderPane();
    await waitFor(() => expect(screen.getByText('Transportes del Bajío')).toBeTruthy());
    fireEvent.click(screen.getByText('Transportes del Bajío'));

    await waitFor(() => expect(screen.getByText('ACME · IMILE Cuautitlán')).toBeTruthy());
    const rutas = vi.mocked(apiGet).mock.calls.map((c) => String(c[0]));
    expect(rutas).toContain('/api/catalogs/direcciones');
    // The fan-out is gone: no per-client address request, and the label came off the tarifa itself.
    expect(rutas.some((r) => /\/clients\/.+\/direcciones/.test(r))).toBe(false);
  });

  it('corrects a rate in place, sending the empty fields as null so an edit can erase', async () => {
    const { apiPut } = await import('../api');
    await renderPane();
    await waitFor(() => expect(screen.getByText('Transportes del Bajío')).toBeTruthy());
    fireEvent.click(screen.getByText('Transportes del Bajío'));
    await waitFor(() => expect(screen.getByRole('button', { name: /editar la tarifa de tracto/i })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /editar la tarifa de tracto/i }));
    // The form opens pre-filled with what the rate says today.
    expect((screen.getByLabelText('Tarifa *') as HTMLInputElement).value).toBe('18500');
    fireEvent.change(screen.getByLabelText('Tarifa *'), { target: { value: '19900' } });
    fireEvent.click(screen.getByRole('button', { name: /guardar tarifa/i }));

    await waitFor(() =>
      expect(vi.mocked(apiPut)).toHaveBeenCalledWith('/api/transportistas/t-1/convenios/c-1/tarifas/tf-1', {
        tipoUnidad: 'tracto',
        direccionEntregaId: 'dir-1',
        tarifa: 19900,
        moneda: 'MXN',
        vigenciaDesde: null,
        vigenciaHasta: null,
      }),
    );
  });

  it('retires a rate instead of deleting it', async () => {
    const { apiDelete } = await import('../api');
    await renderPane();
    await waitFor(() => expect(screen.getByText('Transportes del Bajío')).toBeTruthy());
    fireEvent.click(screen.getByText('Transportes del Bajío'));
    await waitFor(() => expect(screen.getByRole('button', { name: /desactivar la tarifa de tracto/i })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /desactivar la tarifa de tracto/i }));
    await waitFor(() =>
      expect(vi.mocked(apiDelete)).toHaveBeenCalledWith('/api/transportistas/t-1/convenios/c-1/tarifas/tf-1'),
    );
  });

  it('keeps a retired rate on screen, flagged, and offers to bring it back', async () => {
    const { apiPut } = await import('../api');
    const conRetirada = {
      ...DETALLE_T1,
      convenios: [{ ...DETALLE_T1.convenios[0], tarifas: [{ ...DETALLE_T1.convenios[0].tarifas[0], activo: false }] }],
    };
    await renderPane({ detalle: conRetirada });
    await waitFor(() => expect(screen.getByText('Transportes del Bajío')).toBeTruthy());
    fireEvent.click(screen.getByText('Transportes del Bajío'));

    // It stays visible — a despacho already points at it — and cannot be edited, only reactivated.
    await waitFor(() => expect(screen.getByText('Desactivada')).toBeTruthy());
    expect(screen.queryByRole('button', { name: /editar la tarifa de tracto/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /reactivar la tarifa de tracto/i }));
    await waitFor(() =>
      expect(vi.mocked(apiPut)).toHaveBeenCalledWith('/api/transportistas/t-1/convenios/c-1/tarifas/tf-1', { activo: true }),
    );
  });

  it('edits a pre-signature convenio: vigencia, estado and notas', async () => {
    const { apiPut } = await import('../api');
    await renderPane();
    await waitFor(() => expect(screen.getByText('Transportes del Bajío')).toBeTruthy());
    fireEvent.click(screen.getByText('Transportes del Bajío'));
    await waitFor(() => expect(screen.getByRole('button', { name: /^editar convenio$/i })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /^editar convenio$/i }));
    fireEvent.change(screen.getByLabelText('Vigencia hasta'), { target: { value: '2027-06-30' } });
    fireEvent.change(screen.getByLabelText('Notas'), { target: { value: 'Renegociado el 3 de junio' } });
    fireEvent.click(screen.getByRole('button', { name: /guardar convenio/i }));

    await waitFor(() =>
      expect(vi.mocked(apiPut)).toHaveBeenCalledWith('/api/transportistas/t-1/convenios/c-1', {
        vigenciaDesde: '2026-01-01',
        vigenciaHasta: '2027-06-30',
        estadoFirma: 'borrador',
        notas: 'Renegociado el 3 de junio',
      }),
    );
  });

  it('offers Renovar — never Editar — on a signed convenio, and says why the terms are locked', async () => {
    const { apiPost } = await import('../api');
    await renderPane({ detalle: DETALLE_T1_FIRMADO });
    await waitFor(() => expect(screen.getByText('Transportes del Bajío')).toBeTruthy());
    fireEvent.click(screen.getByText('Transportes del Bajío'));

    await waitFor(() => expect(screen.getByRole('button', { name: /renovar convenio/i })).toBeTruthy());
    expect(screen.queryByRole('button', { name: /^editar convenio$/i })).toBeNull();
    // The reason is stated on the card, not discovered as a 409.
    expect(screen.getByText(/no se editan/i)).toBeTruthy();
    expect(screen.getByText(/convenio sucesor/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /renovar convenio/i }));
    fireEvent.change(screen.getByLabelText('Vigencia desde *'), { target: { value: '2027-01-01' } });
    fireEvent.change(screen.getByLabelText('Vigencia hasta'), { target: { value: '2027-12-31' } });
    fireEvent.click(screen.getByRole('button', { name: /crear convenio sucesor/i }));

    await waitFor(() =>
      expect(vi.mocked(apiPost)).toHaveBeenCalledWith('/api/transportistas/t-1/convenios/c-1/renovar', {
        vigenciaDesde: '2027-01-01',
        vigenciaHasta: '2027-12-31',
        copiarTarifas: true,
      }),
    );
  });

  it('shows the renewal chain in both directions', async () => {
    const encadenado = {
      ...DETALLE_T1,
      convenios: [{
        ...DETALLE_T1_FIRMADO.convenios[0],
        renovadoDeConvenioId: 'c-0',
        renovadoPorConvenioId: 'c-2',
      }],
    };
    await renderPane({ detalle: encadenado });
    await waitFor(() => expect(screen.getByText('Transportes del Bajío')).toBeTruthy());
    fireEvent.click(screen.getByText('Transportes del Bajío'));

    await waitFor(() => expect(screen.getByText(/Renovación de un convenio anterior/i)).toBeTruthy());
    expect(screen.getByText(/Ya renovado/i)).toBeTruthy();
  });

  it('adds a unit against the TIPOS_UNIDAD glossary', async () => {
    const { apiPost } = await import('../api');
    await renderPane();
    await waitFor(() => expect(screen.getByText('Transportes del Bajío')).toBeTruthy());
    fireEvent.click(screen.getByText('Transportes del Bajío'));
    await waitFor(() => expect(screen.getByText('ABC1234')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /agregar unidad/i }));
    fireEvent.change(screen.getByLabelText('Placas *'), { target: { value: 'xyz-98-76' } });
    fireEvent.change(screen.getByLabelText('Tipo de unidad *'), { target: { value: 'rabon' } });
    fireEvent.click(screen.getByRole('button', { name: /registrar unidad/i }));

    await waitFor(() =>
      expect(vi.mocked(apiPost)).toHaveBeenCalledWith('/api/transportistas/t-1/unidades', {
        placas: 'XYZ-98-76',
        tipoUnidad: 'rabon',
      }),
    );
  });

  it('suspends an active carrier through PUT { estado }', async () => {
    const { apiPut } = await import('../api');
    await renderPane();
    await waitFor(() => expect(screen.getByText('Transportes del Bajío')).toBeTruthy());
    fireEvent.click(screen.getByText('Transportes del Bajío'));
    await waitFor(() => expect(screen.getByRole('button', { name: /suspender/i })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /suspender/i }));
    await waitFor(() =>
      expect(vi.mocked(apiPut)).toHaveBeenCalledWith('/api/transportistas/t-1', { estado: 'suspendido' }),
    );
  });

  it('is read-only for a non-admin: the list renders, every write control is gone', async () => {
    await renderPane({ me: { id: '9', username: 'capturista', role: 'capturista' } });

    await waitFor(() => expect(screen.getByText('Transportes del Bajío')).toBeTruthy());
    expect(screen.getByText(/restringid/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /agregar transportista/i })).toBeNull();

    fireEvent.click(screen.getByText('Transportes del Bajío'));
    await waitFor(() => expect(screen.getByText('ABC1234')).toBeTruthy());
    expect(screen.queryByRole('button', { name: /agregar unidad/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /agregar convenio/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /registrar firma/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^suspender$/i })).toBeNull();
    // The three new affordances are writes too, and the server would answer all three with a 403.
    expect(screen.queryByRole('button', { name: /^editar convenio$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /renovar convenio/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /desactivar la tarifa/i })).toBeNull();
  });

  it('hands the carrier over to Trazabilidad when the host offers the affordance', async () => {
    const { apiGet } = await import('../api');
    vi.mocked(apiGet).mockImplementation(mockApi() as never);
    const onVer = vi.fn();
    render(
      <Wrapper>
        <ConfigurationView domain="cfg_transportistas" onToast={() => {}} onVerTrazabilidad={onVer} />
      </Wrapper>,
    );

    await waitFor(() => expect(screen.getByText('Transportes del Bajío')).toBeTruthy());
    fireEvent.click(screen.getByText('Transportes del Bajío'));
    await waitFor(() => expect(screen.getByRole('button', { name: /ver trazabilidad/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /ver trazabilidad/i }));
    expect(onVer).toHaveBeenCalledWith('t-1');
  });

  it('says plainly when there is nothing registered yet', async () => {
    await renderPane({ transportistas: [] });
    await waitFor(() => expect(screen.getByText('Sin transportistas registrados')).toBeTruthy());
  });
});
