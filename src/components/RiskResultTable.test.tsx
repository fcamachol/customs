import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RiskSummary, RiskResultTable, type RiskRow } from './RiskResultTable';
import { AuthProvider } from '../context/AuthContext';
import { apiGet, apiPost } from '../api';

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return { ApiError: actual.ApiError, apiGet: vi.fn(), apiPost: vi.fn() };
});

const mGet = apiGet as ReturnType<typeof vi.fn>;
const mPost = apiPost as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

/** Renderiza la tabla dentro de un `AuthProvider` con el rol pedido (la compuerta lo lee de ahí). */
function renderConRol(rol: 'capturista' | 'admin' | 'super_admin', props: Parameters<typeof RiskResultTable>[0]) {
  localStorage.setItem('token', 't');
  mGet.mockResolvedValue({ id: 'u1', username: 'u', role: rol });
  return render(<AuthProvider><RiskResultTable {...props} /></AuthProvider>);
}

describe('RiskSummary', () => {
  it('renders the four buckets with labels and numbers (3-bucket PRD mapping)', () => {
    render(
      <RiskSummary summary={{ analizados: 10, aprobados: 6, noIdentificados: 3, validarEnPrevio: 1 }} />
    );
    expect(screen.getByText('Analizados')).toBeTruthy();
    expect(screen.getByText('Aprobados')).toBeTruthy();
    expect(screen.getByText('No identificados')).toBeTruthy();
    expect(screen.getByText('Validar en previo')).toBeTruthy();
    expect(screen.getByText('10')).toBeTruthy();
    expect(screen.getByText('6')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByText('1')).toBeTruthy();
  });

  it('enseña la cifra del motor como secundaria SÓLO en los cubos donde difiere del efectivo', () => {
    render(
      <RiskSummary
        summary={{ analizados: 10, aprobados: 7, noIdentificados: 3, validarEnPrevio: 0 }}
        motor={{ analizados: 10, aprobados: 6, noIdentificados: 3, validarEnPrevio: 1 }}
      />
    );
    expect(screen.getByText('motor: 6')).toBeTruthy();   // Aprobados difiere
    expect(screen.getByText('motor: 1')).toBeTruthy();   // Validar en previo difiere
    expect(screen.queryByText('motor: 10')).toBeNull();  // Analizados coincide → sin ruido
    expect(screen.queryByText('motor: 3')).toBeNull();
  });
});

describe('RiskResultTable', () => {
  const rows: RiskRow[] = [
    {
      mwb: 'MWB-001',
      guide: 'G-001',
      consignee: 'Acme Corp',
      senderCity: 'Shenzhen',
      senderCountry: 'CN',
      description: 'Pantalones, Funda protectora',
      resultado: 'rojo',
      motivo: 'Sender flagged on watchlist',
    },
    {
      mwb: 'MWB-002',
      guide: 'G-002',
      consignee: 'Beta LLC',
      senderCity: 'Miami',
      senderCountry: 'US',
      description: 'Camiseta',
      resultado: 'verde',
      motivo: 'Sin observaciones',
    },
  ];

  it('renders both rows with descripción de la mercancía and resultado labels', () => {
    render(<RiskResultTable rows={rows} />);
    expect(screen.getByText('Descripción de la mercancía')).toBeTruthy();
    expect(screen.getByText('MWB-001')).toBeTruthy();
    expect(screen.getByText('MWB-002')).toBeTruthy();
    expect(screen.getByText('Acme Corp')).toBeTruthy();
    expect(screen.getByText('Beta LLC')).toBeTruthy();
    expect(screen.getByText('Pantalones, Funda protectora')).toBeTruthy();
    expect(screen.getByText('Camiseta')).toBeTruthy();
    // The País remitente column was replaced by the merchandise description (client observation).
    expect(screen.queryByText('País remitente')).toBeNull();
    expect(screen.getByText('Rojo')).toBeTruthy();
    expect(screen.getByText('Verde')).toBeTruthy();
  });

  it('shows the motivo text for the rojo row', () => {
    render(<RiskResultTable rows={rows} />);
    expect(screen.getByText('Sender flagged on watchlist')).toBeTruthy();
  });

  it('sin manifestId no hay acción Disponer: no habría a dónde mandar la afirmación', () => {
    render(<RiskResultTable rows={rows} />);
    expect(screen.queryByRole('button', { name: /Disponer/i })).toBeNull();
  });
});

// =================================================================================================
// La gramática visual: dos causas distintas, dos etiquetas
// =================================================================================================

const DISPUESTA: RiskRow = {
  mwb: 'MWB-003', guide: 'G-003', consignee: 'Gamma SA', senderCity: 'Bogotá', senderCountry: 'CO',
  description: 'Playera', resultado: 'verde', motivo: 'pirateria',
  shipmentId: 's-3', resultadoMotor: 'rojo', resultadoAnterior: null, versionAnterior: null,
  datoCambio: true, revalidacionPendiente: false,
  reasons: [{ signalId: 'pirateria', points: 100, weight: 100, detail: 'Piratería (nike)', evidence: { matched: 'nike' }, forcesBand: 'rojo', hallazgoHash: 'h1' }],
  disposiciones: [{
    id: 'd1', signalId: 'pirateria', hallazgoHash: 'h1', estado: 'falso_positivo',
    motivo: 'La marca está en el empaque, no en el producto.',
    createdAt: '2026-08-10T12:00:00.000Z', createdBy: 'u9', createdByUsuario: 'ana', revalidacionPendiente: false,
  }],
};

const CORREGIDA: RiskRow = {
  mwb: 'MWB-004', guide: 'G-004', consignee: 'Delta SA', senderCity: 'Lima', senderCountry: 'PE',
  description: 'Zapatos', resultado: 'rojo', motivo: 'agregado',
  shipmentId: 's-4', resultadoMotor: 'rojo', resultadoAnterior: 'verde', versionAnterior: 2,
  datoCambio: false, revalidacionPendiente: false,
  reasons: [{ signalId: 'agregado', points: 40, weight: 60, detail: 'Valor agregado por consignatario excede el umbral', hallazgoHash: 'h2' }],
  disposiciones: [],
};

describe('RiskResultTable — el color del motor y las dos etiquetas', () => {
  it('el pill lleva el EFECTIVO y el motor queda escrito debajo cuando difieren', () => {
    render(<RiskResultTable rows={[DISPUESTA]} />);
    expect(screen.getByText('Verde')).toBeTruthy();       // pill = efectivo
    expect(screen.getByText('motor: rojo')).toBeTruthy(); // la palabra del motor no desaparece
  });

  it('no escribe el caption cuando el motor y el efectivo coinciden', () => {
    render(<RiskResultTable rows={[CORREGIDA]} />);
    expect(screen.queryByText(/^motor:/)).toBeNull();
  });

  it('la disposición humana lleva tag ÁMBAR `Dispuesto` y badge con el lenguaje de Override', () => {
    render(<RiskResultTable rows={[DISPUESTA]} />);
    expect(screen.getByRole('button', { name: 'Dispuesto' })).toBeTruthy();
    expect(screen.getByText('Falso positivo')).toBeTruthy();
  });

  it('la corrección de manifiesto lleva un tag NEUTRO `vN`, no el ámbar', () => {
    render(<RiskResultTable rows={[CORREGIDA]} version={3} />);
    expect(screen.getByRole('button', { name: 'v3' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Dispuesto' })).toBeNull();
  });

  it('marca `Revalidar` en ámbar cuando hay revalidación pendiente', () => {
    render(<RiskResultTable rows={[{ ...DISPUESTA, revalidacionPendiente: true }]} />);
    expect(screen.getByText('Revalidar')).toBeTruthy();
  });

  it('el popover se abre con CLIC (debe funcionar en tablet) y enseña la historia', () => {
    render(<RiskResultTable rows={[DISPUESTA]} />);
    expect(screen.queryByText(/Historia de la línea/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Dispuesto' }));
    expect(screen.getByText(/Historia de la línea G-003/)).toBeTruthy();
    expect(screen.getByText('La marca está en el empaque, no en el producto.')).toBeTruthy();
    expect(screen.getByText(/ana/)).toBeTruthy();
  });

  it('el popover distingue «cambió el conjunto» de «cambió su dato»', () => {
    const { unmount } = render(<RiskResultTable rows={[CORREGIDA]} version={3} />);
    fireEvent.click(screen.getByRole('button', { name: 'v3' }));
    expect(screen.getByText('Su dato no cambió; cambió el conjunto en la v3.')).toBeTruthy();
    unmount();

    render(<RiskResultTable rows={[{ ...CORREGIDA, datoCambio: true }]} version={3} />);
    fireEvent.click(screen.getByRole('button', { name: 'v3' }));
    expect(screen.getByText('Su dato cambió en la v3.')).toBeTruthy();
  });

  it('una línea con las dos causas enseña los dos tags a la vez', () => {
    render(<RiskResultTable rows={[{ ...DISPUESTA, resultadoAnterior: 'amarillo', versionAnterior: 1 }]} version={2} />);
    expect(screen.getByRole('button', { name: 'Dispuesto' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'v2' })).toBeTruthy();
  });
});

// =================================================================================================
// El formulario de disposición: en línea, en dos pasos, con el bloqueo escrito
// =================================================================================================

const ROJA_FORZADA: RiskRow = {
  mwb: 'MWB-005', guide: 'G-005', consignee: 'Eps SA', senderCity: 'Quito', senderCountry: 'EC',
  description: 'Bolsa', resultado: 'rojo', motivo: 'pirateria',
  shipmentId: 's-5', resultadoMotor: 'rojo', resultadoAnterior: null, versionAnterior: null,
  datoCambio: true, revalidacionPendiente: false, disposiciones: [],
  reasons: [{ signalId: 'pirateria', points: 100, weight: 100, detail: 'Piratería (rolex)', evidence: { matched: 'rolex' }, forcesBand: 'rojo', hallazgoHash: 'h5' }],
};

describe('RiskResultTable — formulario Disponer', () => {
  it('abre un formulario EN LÍNEA (sin modal) con las señales que dispararon', async () => {
    renderConRol('admin', { rows: [ROJA_FORZADA], manifestId: 'm1' });
    fireEvent.click(screen.getByRole('button', { name: /Disponer/i }));
    expect(await screen.findByText(/Disponer un hallazgo — guía G-005/)).toBeTruthy();
    expect(screen.getByText('Piratería (rolex)')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('deshabilita el envío con el motivo del bloqueo escrito cuando el rol no alcanza', async () => {
    renderConRol('capturista', { rows: [ROJA_FORZADA], manifestId: 'm1' });
    fireEvent.click(screen.getByRole('button', { name: /Disponer/i }));
    await screen.findByText(/Disponer un hallazgo/);
    await waitFor(() =>
      expect(screen.getByText(/no alcanza para suprimir un hallazgo que fuerza rojo/i)).toBeTruthy());
    const enviar = screen.getByRole('button', { name: /Registrar disposición/i });
    expect((enviar as HTMLButtonElement).disabled).toBe(true);
  });

  it('exige motivo y confirma en dos pasos antes de escribir nada', async () => {
    mPost.mockResolvedValue({ disposicionId: 'd9', resultado: 'gris', resultadoMotor: 'rojo', suprimidas: ['pirateria'] });
    const onDisposicion = vi.fn();
    renderConRol('admin', { rows: [ROJA_FORZADA], manifestId: 'm1', onDisposicion });
    fireEvent.click(screen.getByRole('button', { name: /Disponer/i }));
    await screen.findByText(/Disponer un hallazgo/);

    // Sin motivo el botón está bloqueado y lo dice.
    await waitFor(() =>
      expect((screen.getByRole('button', { name: /Registrar disposición/i }) as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByText('El motivo es obligatorio.')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: 'La marca no es la del producto.' } });
    fireEvent.click(screen.getByRole('button', { name: /Registrar disposición/i }));

    // Paso 2: nada se ha mandado todavía.
    expect(mPost).not.toHaveBeenCalled();
    expect(screen.getByText(/¿Registrar esta disposición\?/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Confirmar/i }));
    await waitFor(() =>
      expect(mPost).toHaveBeenCalledWith('/api/manifests/m1/riesgo/disposiciones', {
        shipmentId: 's-5', signalId: 'pirateria', estado: 'falso_positivo',
        motivo: 'La marca no es la del producto.',
      }));
    await waitFor(() => expect(onDisposicion).toHaveBeenCalled());
  });

  it('una mitigación sin requerimiento que la respalde no se puede enviar', async () => {
    renderConRol('admin', { rows: [ROJA_FORZADA], manifestId: 'm1' });
    fireEvent.click(screen.getByRole('button', { name: /Disponer/i }));
    await screen.findByText(/Disponer un hallazgo/);
    fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: 'Resuelto con el cliente.' } });
    fireEvent.click(screen.getByLabelText('Mitigado'));
    await waitFor(() =>
      expect(screen.getByText(/necesita citar un requerimiento/i)).toBeTruthy());
    expect((screen.getByRole('button', { name: /Registrar disposición/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('traduce el 409 por análisis rancio en vez de enseñar el código de la API', async () => {
    const { ApiError } = await import('../api');
    mPost.mockRejectedValue(new ApiError('analisis_rancio', 409, { error: 'analisis_rancio' }));
    renderConRol('admin', { rows: [ROJA_FORZADA], manifestId: 'm1' });
    fireEvent.click(screen.getByRole('button', { name: /Disponer/i }));
    await screen.findByText(/Disponer un hallazgo/);
    fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: 'motivo suficiente' } });
    fireEvent.click(screen.getByRole('button', { name: /Registrar disposición/i }));
    fireEvent.click(screen.getByRole('button', { name: /Confirmar/i }));
    expect(await screen.findByText(/Vuelva a correr el análisis de riesgo antes de disponer/)).toBeTruthy();
  });
});
