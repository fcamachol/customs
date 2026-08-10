/**
 * TRANSPORTISTAS — the carrier catalog (PRD-02 R24, R25/D9).
 *
 * WHY IT LIVES IN CONFIGURACIÓN AND NOT IN LOGÍSTICA. This screen is master data, not dispatch: it
 * answers "who may we contract, with what fleet, under which agreement, at what price?" — a question
 * settled before a truck is ever planned. Planning consumes what is registered here through
 * `GET /api/despachos/opciones`; nothing on this screen moves cargo.
 *
 * THE GATE MIRRORS THE SERVER, exactly. `server/src/routes/transportistas.ts` reads with `requireAuth`
 * and writes with `requireRole('admin')` (super_admin is a superset). So the pane renders for
 * admin/super_admin — every write it offers would otherwise come back 403 — and every mutating
 * control is additionally guarded by `isAdmin` rather than merely hidden, because a read-only
 * Configuración pane is a house convention (see ConfigurationView's restricted banner).
 *
 * WHAT THE SCREEN INSISTS ON SAYING OUT LOUD is the D9 rule: a rate only counts if the convenio that
 * carries it is `firmado` AND in force today. The API is happy to store a rate on a draft agreement —
 * that is what a negotiation looks like — but `GET /api/despachos/opciones` will never resolve it, so
 * a price sitting under an unsigned convenio is a number nobody can act on. A table that showed those
 * rates without saying so would let somebody quote from them. Hence the amber "Tarifas sin efecto"
 * banner, which names the specific reason (unsigned / expired / not yet in force) rather than a
 * generic warning.
 *
 * CONTACT DETAILS are encrypted at rest server-side (fieldCrypto, §8.5) and arrive decrypted; the UI
 * simply shows them and posts them back in the clear over TLS. There is nothing to do here beyond
 * not copying them anywhere else.
 */

import { Fragment, useCallback, useEffect, useState } from 'react';
import {
  Truck,
  Plus,
  Search,
  ChevronRight,
  ShieldAlert,
  FileSignature,
  PenLine,
  Coins,
  Upload,
  Route,
  Power,
  X,
} from 'lucide-react';
import { apiGet, apiPost, apiPut, apiDelete, apiUpload, apiDownload } from '../api';
import { Card, Button, Field, Input, Modal, StatusPill, EmptyState, type Resultado } from './ui';
import { TIPOS_UNIDAD, ESTADOS_TRANSPORTISTA, etiquetaTipoUnidad } from '../../shared/operaciones/catalogos';

// ---- API contract types ------------------------------------------------------------------------

export interface Transportista {
  id: string;
  razonSocial: string;
  rfc: string | null;
  contactoNombre: string | null;
  contactoTelefono: string | null;
  contactoEmail: string | null;
  estado: string;
  documentosOk: boolean;
  /** Present on the list endpoint only: both are computed against TODAY, never stored. */
  unidadesActivas?: number;
  convenioVigente?: boolean;
}

interface Unidad {
  id: string;
  placas: string;
  tipoUnidad: string;
  numeroEconomico: string | null;
  vigenciaSeguro: string | null;
  vigenciaVerificacion: string | null;
  activo: boolean;
  seguroVencido?: boolean;
  verificacionVencida?: boolean;
}

interface Tarifa {
  id: string;
  tipoUnidad: string;
  direccionEntregaId: string | null;
  /** numeric column: a JSON number through json_build_object, a string on a bare RETURNING. */
  tarifa: number | string;
  moneda: string;
  vigenciaDesde: string | null;
  vigenciaHasta: string | null;
}

interface Convenio {
  id: string;
  fileId: string | null;
  vigenciaDesde: string | null;
  vigenciaHasta: string | null;
  estadoFirma: string;
  firmadoAt: string | null;
  firmaProveedor: string | null;
  firmaReferencia: string | null;
  firmaEvidenciaFileId: string | null;
  createdAt: string;
  /** Computed by the server: `firmado` AND within its vigencia, asked of the DB's clock. */
  vigente: boolean;
  tarifas: Tarifa[];
}

interface TransportistaDetalle extends Transportista {
  unidades: Unidad[];
  convenios: Convenio[];
}

/** A delivery address, flattened across clients — see `cargarDestinos` for why it is assembled here. */
interface Destino {
  id: string;
  alias: string;
  cliente: string;
}

// ---- Formatting --------------------------------------------------------------------------------

const SELECT_CLS =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-navy-500 focus:ring-2 focus:ring-navy-500/25 disabled:bg-slate-50';

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : 'Error inesperado';
}

/**
 * The LOCAL calendar day of a DATE column, as YYYY-MM-DD.
 *
 * node-pg parses a `date` into a JS Date at local midnight, so reading it back with `getFullYear()`
 * recovers the day that was stored. `toISOString().slice(0,10)` would shift it west of UTC and show
 * a convenio expiring a day early.
 */
function diaDe(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' });
}

function fmtMonto(v: number | string, moneda: string): string {
  const n = typeof v === 'number' ? v : Number(v);
  if (Number.isNaN(n)) return String(v);
  return `${n.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${moneda}`;
}

const ESTADO_PILL: Record<string, { resultado: Resultado; label: string }> = {
  activo: { resultado: 'verde', label: 'Activo' },
  suspendido: { resultado: 'amarillo', label: 'Suspendido' },
  baja: { resultado: 'gris', label: 'Baja' },
};

function EstadoTransportistaPill({ estado }: { estado: string }) {
  const s = ESTADO_PILL[estado] ?? { resultado: 'gris' as Resultado, label: estado };
  return <StatusPill resultado={s.resultado} label={s.label} />;
}

const ETIQUETA_FIRMA: Record<string, string> = {
  borrador: 'Borrador',
  enviado: 'Enviado',
  firmado: 'Firmado',
  vencido: 'Vencido',
};

const FIRMA_STYLE: Record<string, string> = {
  borrador: 'bg-slate-100 text-slate-600 ring-slate-500/20',
  enviado: 'bg-blue-50 text-blue-700 ring-blue-600/20',
  firmado: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  vencido: 'bg-red-50 text-red-700 ring-red-600/20',
};

function FirmaChip({ estadoFirma }: { estadoFirma: string }) {
  const cls = FIRMA_STYLE[estadoFirma] ?? 'bg-slate-100 text-slate-600 ring-slate-500/20';
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${cls}`}>
      {ETIQUETA_FIRMA[estadoFirma] ?? estadoFirma}
    </span>
  );
}

function hoyISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * WHY a rate under this convenio cannot be used — the sentence the D9 banner needs.
 *
 * `vigente` comes from the server (computed against the database's clock, which is the one the
 * constraints see); this only explains it. The three cases are genuinely different to the reader:
 * an unsigned agreement is waiting on somebody, an expired one is waiting on a renewal, and one that
 * has not started yet is simply early.
 */
function motivoSinVigencia(c: Convenio): string | null {
  if (c.vigente) return null;
  if (c.estadoFirma !== 'firmado') {
    return `el convenio no está firmado (${(ETIQUETA_FIRMA[c.estadoFirma] ?? c.estadoFirma).toLowerCase()})`;
  }
  const hoy = hoyISO();
  const hasta = diaDe(c.vigenciaHasta);
  const desde = diaDe(c.vigenciaDesde);
  if (hasta && hasta < hoy) return `el convenio venció el ${fmtDate(c.vigenciaHasta)}`;
  if (desde && desde > hoy) return `el convenio entra en vigor el ${fmtDate(c.vigenciaDesde)}`;
  return 'el convenio no está vigente';
}

// ---- The pane ----------------------------------------------------------------------------------

export interface TransportistasTabProps {
  isAdmin: boolean;
  onToast: (msg: string) => void;
  /** Jump to Trazabilidad with this carrier already selected. Absent = no affordance rendered. */
  onVerTrazabilidad?: (transportistaId: string) => void;
}

export function TransportistasTab({ isAdmin, onToast, onVerTrazabilidad }: TransportistasTabProps) {
  const [transportistas, setTransportistas] = useState<Transportista[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busqueda, setBusqueda] = useState('');
  const [nuevoAbierto, setNuevoAbierto] = useState(false);
  const [detalleId, setDetalleId] = useState<string | null>(null);

  const recargar = useCallback(() => {
    setCargando(true);
    return apiGet<Transportista[]>('/api/transportistas')
      .then((r) => { setTransportistas(Array.isArray(r) ? r : []); setError(null); })
      .catch((e) => setError(errMsg(e)))
      .finally(() => setCargando(false));
  }, []);

  useEffect(() => { void recargar(); }, [recargar]);

  const q = busqueda.trim().toLowerCase();
  const filtrados = q
    ? transportistas.filter((t) =>
        [t.razonSocial, t.rfc, t.contactoNombre].some((f) => (f ?? '').toLowerCase().includes(q)))
    : transportistas;

  return (
    <div className="space-y-6">
      <Card className="p-6 shadow-sm">
        <h3 className="mb-1 flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-slate-700">
          <Truck className="h-4 w-4 text-navy-700" />
          Transportistas
        </h3>
        <p className="mb-4 text-xs text-slate-500">
          Quién puede mover carga, con qué flota y bajo qué convenio. La planeación sólo ofrece
          transportistas con unidad activa del tipo pedido y tarifa dentro de un convenio firmado y vigente.
        </p>

        <div className="mb-4 flex items-center gap-3">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              type="text"
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              placeholder="Buscar por razón social, RFC o contacto"
              className="pl-10"
            />
          </div>
          {isAdmin && (
            <Button className="shrink-0" onClick={() => setNuevoAbierto(true)}>
              <Plus className="h-4 w-4" /> Agregar transportista
            </Button>
          )}
        </div>

        {error && (
          <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
            {error}
          </div>
        )}

        {cargando ? (
          <p className="py-4 text-sm text-slate-400">Cargando transportistas…</p>
        ) : transportistas.length === 0 ? (
          <EmptyState
            icon={Truck}
            title="Sin transportistas registrados"
            message="Registra la línea con la que ya operas: su flota y su convenio son lo que la planeación necesita para poder ofrecerla."
          />
        ) : filtrados.length === 0 ? (
          <p className="py-4 text-sm text-slate-400">Sin coincidencias para «{busqueda.trim()}».</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2 font-semibold">Razón social</th>
                  <th className="px-3 py-2 font-semibold">RFC</th>
                  <th className="px-3 py-2 font-semibold">Contacto</th>
                  <th className="px-3 py-2 font-semibold">Estado</th>
                  <th className="px-3 py-2 font-semibold">Unidades activas</th>
                  <th className="px-3 py-2 font-semibold">Convenio</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtrados.map((t) => (
                  <tr
                    key={t.id}
                    onClick={() => setDetalleId(t.id)}
                    className="cursor-pointer transition hover:bg-slate-50"
                  >
                    <td className="px-3 py-2 font-medium text-slate-800">{t.razonSocial}</td>
                    <td className="px-3 py-2 font-mono text-xs text-slate-600">{t.rfc || '—'}</td>
                    <td className="px-3 py-2 text-slate-600">{t.contactoNombre || '—'}</td>
                    <td className="px-3 py-2"><EstadoTransportistaPill estado={t.estado} /></td>
                    <td className="px-3 py-2 tabular-nums text-slate-700">{t.unidadesActivas ?? 0}</td>
                    <td className="px-3 py-2">
                      {t.convenioVigente ? (
                        <span className="inline-flex items-center rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-600/20">
                          Vigente
                        </span>
                      ) : (
                        <span className="inline-flex items-center rounded-full bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-700 ring-1 ring-inset ring-amber-600/20">
                          Sin convenio vigente
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <ChevronRight className="inline h-4 w-4 text-slate-400" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <NuevoTransportistaModal
        open={nuevoAbierto}
        onClose={() => setNuevoAbierto(false)}
        onCreated={(t) => { onToast(`Transportista «${t.razonSocial}» registrado`); setNuevoAbierto(false); void recargar(); }}
      />

      {detalleId && (
        <TransportistaDetalleModal
          transportistaId={detalleId}
          isAdmin={isAdmin}
          onClose={() => setDetalleId(null)}
          onToast={onToast}
          onChanged={() => void recargar()}
          onVerTrazabilidad={onVerTrazabilidad}
        />
      )}
    </div>
  );
}

// ---- Alta ---------------------------------------------------------------------------------------

const NUEVO_VACIO = {
  razonSocial: '',
  rfc: '',
  contactoNombre: '',
  contactoTelefono: '',
  contactoEmail: '',
  documentosOk: false,
};

function NuevoTransportistaModal({ open, onClose, onCreated }: {
  open: boolean;
  onClose: () => void;
  onCreated: (t: Transportista) => void;
}) {
  const [form, setForm] = useState(NUEVO_VACIO);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof typeof NUEVO_VACIO>(key: K, value: (typeof NUEVO_VACIO)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function cerrar() {
    setForm(NUEVO_VACIO);
    setError(null);
    onClose();
  }

  async function guardar() {
    if (!form.razonSocial.trim()) { setError('La razón social es obligatoria.'); return; }
    setGuardando(true);
    setError(null);
    try {
      // Empty optional fields are omitted rather than sent as '': the carrier's RFC carries a UNIQUE
      // constraint, and an empty string is a value, not an absence.
      const body: Record<string, unknown> = { razonSocial: form.razonSocial.trim() };
      if (form.rfc.trim()) body.rfc = form.rfc.trim().toUpperCase();
      if (form.contactoNombre.trim()) body.contactoNombre = form.contactoNombre.trim();
      if (form.contactoTelefono.trim()) body.contactoTelefono = form.contactoTelefono.trim();
      if (form.contactoEmail.trim()) body.contactoEmail = form.contactoEmail.trim();
      if (form.documentosOk) body.documentosOk = true;
      const creado = await apiPost<Transportista>('/api/transportistas', body);
      setForm(NUEVO_VACIO);
      onCreated(creado);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setGuardando(false);
    }
  }

  return (
    <Modal open={open} onClose={cerrar} title="Nuevo transportista">
      {error && (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
          {error}
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Razón social *" htmlFor="tr-razon">
          <Input id="tr-razon" value={form.razonSocial} onChange={(e) => set('razonSocial', e.target.value)} />
        </Field>
        <Field label="RFC" htmlFor="tr-rfc">
          <Input id="tr-rfc" value={form.rfc} onChange={(e) => set('rfc', e.target.value.toUpperCase())} className="font-mono" />
        </Field>
        <Field label="Contacto" htmlFor="tr-cnombre">
          <Input id="tr-cnombre" value={form.contactoNombre} onChange={(e) => set('contactoNombre', e.target.value)} />
        </Field>
        <Field label="Teléfono" htmlFor="tr-ctel">
          <Input id="tr-ctel" value={form.contactoTelefono} onChange={(e) => set('contactoTelefono', e.target.value)} />
        </Field>
        <Field label="Correo" htmlFor="tr-cmail">
          <Input id="tr-cmail" type="email" value={form.contactoEmail} onChange={(e) => set('contactoEmail', e.target.value)} />
        </Field>
        <div className="flex items-end">
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={form.documentosOk}
              onChange={(e) => set('documentosOk', e.target.checked)}
              className="h-4 w-4 rounded border-slate-300"
            />
            Documentación completa
          </label>
        </div>
      </div>
      <p className="mt-3 text-xs text-slate-500">
        Los datos de contacto se guardan cifrados. La flota y el convenio se agregan al abrir el transportista, una vez creado.
      </p>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" type="button" onClick={cerrar}>Cancelar</Button>
        <Button type="button" onClick={guardar} disabled={guardando}>Guardar transportista</Button>
      </div>
    </Modal>
  );
}

// ---- Detalle -------------------------------------------------------------------------------------

function TransportistaDetalleModal({ transportistaId, isAdmin, onClose, onToast, onChanged, onVerTrazabilidad }: {
  transportistaId: string;
  isAdmin: boolean;
  onClose: () => void;
  onToast: (msg: string) => void;
  onChanged: () => void;
  onVerTrazabilidad?: (id: string) => void;
}) {
  const [detalle, setDetalle] = useState<TransportistaDetalle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [destinos, setDestinos] = useState<Destino[]>([]);

  const recargar = useCallback(async () => {
    try {
      setDetalle(await apiGet<TransportistaDetalle>(`/api/transportistas/${transportistaId}`));
      setError(null);
    } catch (e) {
      setError(errMsg(e));
    }
  }, [transportistaId]);

  useEffect(() => { void recargar(); }, [recargar]);

  /**
   * Delivery addresses, assembled client by client.
   *
   * API GAP, worked around rather than papered over: there is no `GET /api/catalogs/direcciones`, only
   * the per-client `GET /api/catalogs/clients/:id/direcciones`, and a tarifa's `direccionEntregaId`
   * comes back as a bare uuid with no alias. Without this fan-out a destination-specific rate would
   * read as a uuid on screen and could only be created by pasting one. The clients catalog is small
   * (tens of rows) and this runs once, lazily, when a carrier is opened — never on the list.
   */
  useEffect(() => {
    let activo = true;
    async function cargarDestinos() {
      try {
        const clientes = await apiGet<{ id: string; name: string }[]>('/api/catalogs/clients');
        if (!Array.isArray(clientes)) return;
        const listas = await Promise.all(
          clientes.map((c) =>
            apiGet<{ id: string; alias: string; activo: boolean }[]>(`/api/catalogs/clients/${c.id}/direcciones`)
              .then((ds) => (Array.isArray(ds) ? ds.map((d) => ({ id: d.id, alias: d.alias, cliente: c.name })) : []))
              .catch(() => [] as Destino[]),
          ),
        );
        if (activo) setDestinos(listas.flat());
      } catch {
        // A carrier can still be administered without the destination catalog; rates just stay general.
      }
    }
    void cargarDestinos();
    return () => { activo = false; };
  }, []);

  async function cambiarEstado(estado: string) {
    if (!isAdmin || !detalle) return;
    try {
      await apiPut(`/api/transportistas/${detalle.id}`, { estado });
      onToast(estado === 'activo' ? 'Transportista activado' : `Transportista ${estado === 'baja' ? 'dado de baja' : 'suspendido'}`);
      await recargar();
      onChanged();
    } catch (e) {
      onToast(`Error: ${errMsg(e)}`);
    }
  }

  return (
    <Modal open onClose={onClose} title={detalle?.razonSocial ?? 'Transportista'} size="2xl">
      {error && (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
          {error}
        </div>
      )}
      {!detalle ? (
        <p className="py-6 text-sm text-slate-400">Cargando…</p>
      ) : (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center gap-2">
            <EstadoTransportistaPill estado={detalle.estado} />
            {detalle.documentosOk ? (
              <span className="inline-flex items-center rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-600/20">
                Documentación completa
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-700 ring-1 ring-inset ring-amber-600/20">
                <ShieldAlert className="h-3 w-3" /> Documentación incompleta
              </span>
            )}
            <div className="ml-auto flex gap-2">
              {onVerTrazabilidad && (
                <Button variant="secondary" onClick={() => onVerTrazabilidad(detalle.id)}>
                  <Route className="h-4 w-4" /> Ver trazabilidad
                </Button>
              )}
              {isAdmin && (
                detalle.estado === 'activo' ? (
                  <Button variant="secondary" onClick={() => void cambiarEstado('suspendido')}>
                    <Power className="h-4 w-4" /> Suspender
                  </Button>
                ) : (
                  <Button variant="secondary" onClick={() => void cambiarEstado('activo')}>
                    <Power className="h-4 w-4" /> Activar
                  </Button>
                )
              )}
            </div>
          </div>

          <DatosGenerales
            detalle={detalle}
            isAdmin={isAdmin}
            onToast={onToast}
            onSaved={async () => { await recargar(); onChanged(); }}
          />

          <UnidadesSeccion
            transportistaId={detalle.id}
            unidades={detalle.unidades}
            isAdmin={isAdmin}
            onToast={onToast}
            onChanged={async () => { await recargar(); onChanged(); }}
          />

          <ConveniosSeccion
            transportistaId={detalle.id}
            convenios={detalle.convenios}
            destinos={destinos}
            isAdmin={isAdmin}
            onToast={onToast}
            onChanged={async () => { await recargar(); onChanged(); }}
          />
        </div>
      )}
    </Modal>
  );
}

/* ---------- Datos generales ---------- */

function DatosGenerales({ detalle, isAdmin, onToast, onSaved }: {
  detalle: TransportistaDetalle;
  isAdmin: boolean;
  onToast: (msg: string) => void;
  onSaved: () => void | Promise<void>;
}) {
  const [editando, setEditando] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [form, setForm] = useState({
    razonSocial: detalle.razonSocial,
    rfc: detalle.rfc ?? '',
    contactoNombre: detalle.contactoNombre ?? '',
    contactoTelefono: detalle.contactoTelefono ?? '',
    contactoEmail: detalle.contactoEmail ?? '',
    estado: detalle.estado,
    documentosOk: detalle.documentosOk,
  });

  function abrir() {
    setForm({
      razonSocial: detalle.razonSocial,
      rfc: detalle.rfc ?? '',
      contactoNombre: detalle.contactoNombre ?? '',
      contactoTelefono: detalle.contactoTelefono ?? '',
      contactoEmail: detalle.contactoEmail ?? '',
      estado: detalle.estado,
      documentosOk: detalle.documentosOk,
    });
    setEditando(true);
  }

  async function guardar() {
    setGuardando(true);
    try {
      await apiPut(`/api/transportistas/${detalle.id}`, {
        razonSocial: form.razonSocial.trim(),
        rfc: form.rfc.trim(),
        contactoNombre: form.contactoNombre.trim(),
        contactoTelefono: form.contactoTelefono.trim(),
        contactoEmail: form.contactoEmail.trim(),
        estado: form.estado,
        documentosOk: form.documentosOk,
      });
      onToast('Transportista actualizado');
      setEditando(false);
      await onSaved();
    } catch (e) {
      onToast(`Error: ${errMsg(e)}`);
    } finally {
      setGuardando(false);
    }
  }

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-bold uppercase tracking-wide text-slate-700">Datos generales</h3>
        {isAdmin && !editando && (
          <button type="button" onClick={abrir} className="inline-flex items-center gap-1 text-xs font-semibold text-navy-700 hover:underline">
            <PenLine className="h-3.5 w-3.5" /> Editar
          </button>
        )}
      </div>

      {editando ? (
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Razón social" htmlFor="ed-razon">
              <Input id="ed-razon" value={form.razonSocial} onChange={(e) => setForm({ ...form, razonSocial: e.target.value })} />
            </Field>
            <Field label="RFC" htmlFor="ed-rfc">
              <Input id="ed-rfc" value={form.rfc} onChange={(e) => setForm({ ...form, rfc: e.target.value.toUpperCase() })} className="font-mono" />
            </Field>
            <Field label="Contacto" htmlFor="ed-cnombre">
              <Input id="ed-cnombre" value={form.contactoNombre} onChange={(e) => setForm({ ...form, contactoNombre: e.target.value })} />
            </Field>
            <Field label="Teléfono" htmlFor="ed-ctel">
              <Input id="ed-ctel" value={form.contactoTelefono} onChange={(e) => setForm({ ...form, contactoTelefono: e.target.value })} />
            </Field>
            <Field label="Correo" htmlFor="ed-cmail">
              <Input id="ed-cmail" value={form.contactoEmail} onChange={(e) => setForm({ ...form, contactoEmail: e.target.value })} />
            </Field>
            <Field label="Estado" htmlFor="ed-estado">
              <select
                id="ed-estado"
                className={SELECT_CLS}
                value={form.estado}
                onChange={(e) => setForm({ ...form, estado: e.target.value })}
              >
                {ESTADOS_TRANSPORTISTA.map((e) => (
                  <option key={e} value={e}>{ESTADO_PILL[e]?.label ?? e}</option>
                ))}
              </select>
            </Field>
          </div>
          <label className="mt-3 flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={form.documentosOk}
              onChange={(e) => setForm({ ...form, documentosOk: e.target.checked })}
              className="h-4 w-4 rounded border-slate-300"
            />
            Documentación completa
          </label>
          <div className="mt-4 flex gap-2">
            <Button onClick={guardar} disabled={guardando}>Guardar cambios</Button>
            <Button variant="secondary" onClick={() => setEditando(false)}>Cancelar</Button>
          </div>
        </div>
      ) : (
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 rounded-lg border border-slate-200 p-4 sm:grid-cols-2">
          <DetalleFila label="RFC" value={detalle.rfc} mono />
          <DetalleFila label="Contacto" value={detalle.contactoNombre} />
          <DetalleFila label="Teléfono" value={detalle.contactoTelefono} />
          <DetalleFila label="Correo" value={detalle.contactoEmail} />
        </dl>
      )}
    </section>
  );
}

function DetalleFila({ label, value, mono }: { label: string; value?: string | null; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-4 border-b border-slate-100 py-1.5 last:border-0">
      <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className={`text-sm text-slate-800 ${mono ? 'font-mono text-xs' : ''}`}>{value || '—'}</dd>
    </div>
  );
}

/* ---------- Unidades (la flota) ---------- */

const UNIDAD_VACIA = { placas: '', tipoUnidad: TIPOS_UNIDAD[0].id as string, numeroEconomico: '', vigenciaSeguro: '', vigenciaVerificacion: '' };

function UnidadesSeccion({ transportistaId, unidades, isAdmin, onToast, onChanged }: {
  transportistaId: string;
  unidades: Unidad[];
  isAdmin: boolean;
  onToast: (msg: string) => void;
  onChanged: () => void | Promise<void>;
}) {
  const [form, setForm] = useState(UNIDAD_VACIA);
  const [abierto, setAbierto] = useState(false);
  const [guardando, setGuardando] = useState(false);

  async function agregar() {
    if (!form.placas.trim()) { onToast('Error: las placas son obligatorias.'); return; }
    setGuardando(true);
    try {
      const body: Record<string, unknown> = { placas: form.placas.trim(), tipoUnidad: form.tipoUnidad };
      if (form.numeroEconomico.trim()) body.numeroEconomico = form.numeroEconomico.trim();
      if (form.vigenciaSeguro) body.vigenciaSeguro = form.vigenciaSeguro;
      if (form.vigenciaVerificacion) body.vigenciaVerificacion = form.vigenciaVerificacion;
      await apiPost(`/api/transportistas/${transportistaId}/unidades`, body);
      onToast('Unidad registrada');
      setForm(UNIDAD_VACIA);
      setAbierto(false);
      await onChanged();
    } catch (e) {
      onToast(`Error: ${errMsg(e)}`);
    } finally {
      setGuardando(false);
    }
  }

  /**
   * Retire, never delete. The server answers DELETE with `activo = false` for the same reason the UI
   * offers it as "Dar de baja": the unit is named in past despachos, and the question "which vehicle
   * carried this?" has to stay answerable after the vehicle leaves the fleet.
   */
  async function darDeBaja(u: Unidad) {
    try {
      await apiDelete(`/api/transportistas/${transportistaId}/unidades/${u.id}`);
      onToast(`Unidad ${u.placas} dada de baja`);
      await onChanged();
    } catch (e) {
      onToast(`Error: ${errMsg(e)}`);
    }
  }

  async function reactivar(u: Unidad) {
    try {
      await apiPut(`/api/transportistas/${transportistaId}/unidades/${u.id}`, { activo: true });
      onToast(`Unidad ${u.placas} reactivada`);
      await onChanged();
    } catch (e) {
      onToast(`Error: ${errMsg(e)}`);
    }
  }

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-slate-700">
          <Truck className="h-4 w-4 text-navy-700" /> Flota ({unidades.length})
        </h3>
        {isAdmin && !abierto && (
          <button type="button" onClick={() => setAbierto(true)} className="inline-flex items-center gap-1 text-xs font-semibold text-navy-700 hover:underline">
            <Plus className="h-3.5 w-3.5" /> Agregar unidad
          </button>
        )}
      </div>

      {unidades.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-300 px-4 py-6 text-center text-sm text-slate-400">
          Sin unidades registradas. Un transportista sin flota tipificada no puede ofrecerse para ningún tipo de unidad.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2 font-semibold">Placas</th>
                <th className="px-3 py-2 font-semibold">Tipo de unidad</th>
                <th className="px-3 py-2 font-semibold">Núm. económico</th>
                <th className="px-3 py-2 font-semibold">Seguro</th>
                <th className="px-3 py-2 font-semibold">Verificación</th>
                <th className="px-3 py-2 font-semibold">Estado</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {unidades.map((u) => (
                <tr key={u.id} className={u.activo ? '' : 'bg-slate-50/60 text-slate-400'}>
                  <td className="px-3 py-2 font-mono text-xs font-semibold text-slate-800">{u.placas}</td>
                  <td className="px-3 py-2 text-slate-700">{etiquetaTipoUnidad(u.tipoUnidad)}</td>
                  <td className="px-3 py-2 text-slate-600">{u.numeroEconomico || '—'}</td>
                  <td className={`px-3 py-2 ${u.seguroVencido ? 'font-semibold text-red-600' : 'text-slate-600'}`}>
                    {fmtDate(u.vigenciaSeguro)}{u.seguroVencido ? ' · vencido' : ''}
                  </td>
                  <td className={`px-3 py-2 ${u.verificacionVencida ? 'font-semibold text-red-600' : 'text-slate-600'}`}>
                    {fmtDate(u.vigenciaVerificacion)}{u.verificacionVencida ? ' · vencida' : ''}
                  </td>
                  <td className="px-3 py-2">
                    {u.activo ? (
                      <span className="text-xs font-semibold text-emerald-700">Activa</span>
                    ) : (
                      <span className="text-xs font-semibold text-slate-500">De baja</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {isAdmin && (
                      u.activo ? (
                        <button
                          type="button"
                          onClick={() => void darDeBaja(u)}
                          aria-label={`Dar de baja la unidad ${u.placas}`}
                          className="text-xs font-semibold text-slate-400 transition hover:text-red-600"
                        >
                          Dar de baja
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void reactivar(u)}
                          aria-label={`Reactivar la unidad ${u.placas}`}
                          className="text-xs font-semibold text-slate-400 transition hover:text-navy-700"
                        >
                          Reactivar
                        </button>
                      )
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {isAdmin && abierto && (
        <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-4">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-xs font-bold uppercase tracking-wide text-slate-600">Nueva unidad</p>
            <button type="button" onClick={() => setAbierto(false)} aria-label="Cancelar nueva unidad" className="text-slate-400 hover:text-slate-700">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Placas *" htmlFor="un-placas">
              <Input id="un-placas" value={form.placas} onChange={(e) => setForm({ ...form, placas: e.target.value.toUpperCase() })} className="font-mono" />
            </Field>
            <Field label="Tipo de unidad *" htmlFor="un-tipo">
              <select id="un-tipo" className={SELECT_CLS} value={form.tipoUnidad} onChange={(e) => setForm({ ...form, tipoUnidad: e.target.value })}>
                {TIPOS_UNIDAD.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
            </Field>
            <Field label="Núm. económico" htmlFor="un-eco">
              <Input id="un-eco" value={form.numeroEconomico} onChange={(e) => setForm({ ...form, numeroEconomico: e.target.value })} />
            </Field>
            <Field label="Vigencia del seguro" htmlFor="un-seguro">
              <Input id="un-seguro" type="date" value={form.vigenciaSeguro} onChange={(e) => setForm({ ...form, vigenciaSeguro: e.target.value })} />
            </Field>
            <Field label="Vigencia de verificación" htmlFor="un-verif">
              <Input id="un-verif" type="date" value={form.vigenciaVerificacion} onChange={(e) => setForm({ ...form, vigenciaVerificacion: e.target.value })} />
            </Field>
          </div>
          <Button className="mt-3" onClick={agregar} disabled={guardando || !form.placas.trim()}>
            <Plus className="h-4 w-4" /> Registrar unidad
          </Button>
        </div>
      )}
    </section>
  );
}

/* ---------- Convenios y tarifas ---------- */

function ConveniosSeccion({ transportistaId, convenios, destinos, isAdmin, onToast, onChanged }: {
  transportistaId: string;
  convenios: Convenio[];
  destinos: Destino[];
  isAdmin: boolean;
  onToast: (msg: string) => void;
  onChanged: () => void | Promise<void>;
}) {
  const [abierto, setAbierto] = useState(false);
  const [form, setForm] = useState({ vigenciaDesde: '', vigenciaHasta: '', estadoFirma: 'borrador' });
  const [guardando, setGuardando] = useState(false);

  async function crear() {
    setGuardando(true);
    try {
      const body: Record<string, unknown> = { estadoFirma: form.estadoFirma };
      if (form.vigenciaDesde) body.vigenciaDesde = form.vigenciaDesde;
      if (form.vigenciaHasta) body.vigenciaHasta = form.vigenciaHasta;
      await apiPost(`/api/transportistas/${transportistaId}/convenios`, body);
      onToast('Convenio creado');
      setForm({ vigenciaDesde: '', vigenciaHasta: '', estadoFirma: 'borrador' });
      setAbierto(false);
      await onChanged();
    } catch (e) {
      onToast(`Error: ${errMsg(e)}`);
    } finally {
      setGuardando(false);
    }
  }

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-slate-700">
          <FileSignature className="h-4 w-4 text-navy-700" /> Convenios y tarifas ({convenios.length})
        </h3>
        {isAdmin && !abierto && (
          <button type="button" onClick={() => setAbierto(true)} className="inline-flex items-center gap-1 text-xs font-semibold text-navy-700 hover:underline">
            <Plus className="h-3.5 w-3.5" /> Agregar convenio
          </button>
        )}
      </div>

      <p className="mb-3 text-xs text-slate-500">
        Una tarifa sólo puede vivir dentro de un convenio. Al planear un despacho únicamente se
        resuelven las tarifas de convenios <strong>firmados y vigentes</strong>: las demás quedan
        registradas como negociación, nunca como precio contratable.
      </p>

      {convenios.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-300 px-4 py-6 text-center text-sm text-slate-400">
          Sin convenios. Sin convenio firmado no hay tarifa que la planeación pueda usar.
        </p>
      ) : (
        <div className="space-y-4">
          {/* Fragment-wrapped like TrazabilidadView's KPI row: the prop types here do not carry `key`. */}
          {convenios.map((c) => (
            <Fragment key={c.id}>
              <ConvenioCard
                transportistaId={transportistaId}
                convenio={c}
                destinos={destinos}
                isAdmin={isAdmin}
                onToast={onToast}
                onChanged={onChanged}
              />
            </Fragment>
          ))}
        </div>
      )}

      {isAdmin && abierto && (
        <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-4">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-xs font-bold uppercase tracking-wide text-slate-600">Nuevo convenio</p>
            <button type="button" onClick={() => setAbierto(false)} aria-label="Cancelar nuevo convenio" className="text-slate-400 hover:text-slate-700">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Vigencia desde" htmlFor="cv-desde">
              <Input id="cv-desde" type="date" value={form.vigenciaDesde} onChange={(e) => setForm({ ...form, vigenciaDesde: e.target.value })} />
            </Field>
            <Field label="Vigencia hasta" htmlFor="cv-hasta">
              <Input id="cv-hasta" type="date" value={form.vigenciaHasta} onChange={(e) => setForm({ ...form, vigenciaHasta: e.target.value })} />
            </Field>
            <Field label="Estado" htmlFor="cv-estado">
              <select id="cv-estado" className={SELECT_CLS} value={form.estadoFirma} onChange={(e) => setForm({ ...form, estadoFirma: e.target.value })}>
                <option value="borrador">Borrador</option>
                <option value="enviado">Enviado</option>
              </select>
            </Field>
          </div>
          <p className="mt-2 text-[11px] text-slate-400">
            «Firmado» no se declara aquí: se registra al firmar, con proveedor y referencia verificables.
          </p>
          <Button className="mt-3" onClick={crear} disabled={guardando}>
            <Plus className="h-4 w-4" /> Crear convenio
          </Button>
        </div>
      )}
    </section>
  );
}

function ConvenioCard({ transportistaId, convenio, destinos, isAdmin, onToast, onChanged }: {
  transportistaId: string;
  convenio: Convenio;
  destinos: Destino[];
  isAdmin: boolean;
  onToast: (msg: string) => void;
  onChanged: () => void | Promise<void>;
}) {
  const motivo = motivoSinVigencia(convenio);
  const puedeFirmar = convenio.estadoFirma === 'borrador' || convenio.estadoFirma === 'enviado';

  return (
    <div className="rounded-lg border border-slate-200 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <FirmaChip estadoFirma={convenio.estadoFirma} />
        {convenio.vigente ? (
          <span className="inline-flex items-center rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-600/20">
            Vigente
          </span>
        ) : (
          <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600 ring-1 ring-inset ring-slate-500/20">
            No vigente
          </span>
        )}
        <span className="text-xs text-slate-500">
          {fmtDate(convenio.vigenciaDesde)} → {fmtDate(convenio.vigenciaHasta)}
        </span>
        {convenio.firmadoAt && (
          <span className="text-xs text-slate-400">
            Firmado el {fmtDate(convenio.firmadoAt)}
            {convenio.firmaProveedor ? ` · ${convenio.firmaProveedor}` : ''}
            {convenio.firmaReferencia ? ` · ref. ${convenio.firmaReferencia}` : ''}
          </span>
        )}
      </div>

      {/* D9 made visible: a rate under a convenio that is not signed-and-in-force is not a price. */}
      {motivo && convenio.tarifas.length > 0 && (
        <div className="mt-3 flex gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <p>
            <strong>Tarifas sin efecto:</strong> {motivo}. La planeación no resolverá estos precios;
            sólo un convenio firmado y vigente los vuelve contratables.
          </p>
        </div>
      )}

      <ArchivoConvenio transportistaId={transportistaId} convenio={convenio} isAdmin={isAdmin} onToast={onToast} onChanged={onChanged} />

      {isAdmin && puedeFirmar && (
        <FirmarConvenio transportistaId={transportistaId} convenioId={convenio.id} onToast={onToast} onChanged={onChanged} />
      )}

      <TarifasTabla
        transportistaId={transportistaId}
        convenio={convenio}
        destinos={destinos}
        isAdmin={isAdmin}
        onToast={onToast}
        onChanged={onChanged}
      />
    </div>
  );
}

function ArchivoConvenio({ transportistaId, convenio, isAdmin, onToast, onChanged }: {
  transportistaId: string;
  convenio: Convenio;
  isAdmin: boolean;
  onToast: (msg: string) => void;
  onChanged: () => void | Promise<void>;
}) {
  const [subiendo, setSubiendo] = useState(false);

  async function subir(file: File) {
    setSubiendo(true);
    try {
      const form = new FormData();
      form.append('file', file);
      await apiUpload(`/api/transportistas/${transportistaId}/convenios/${convenio.id}/archivo`, form);
      onToast('Archivo del convenio adjuntado');
      await onChanged();
    } catch (e) {
      onToast(`Error: ${errMsg(e)}`);
    } finally {
      setSubiendo(false);
    }
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
      {convenio.fileId ? (
        <button
          type="button"
          onClick={() => apiDownload(`/api/files/${convenio.fileId}`, `Convenio-${convenio.id}.pdf`).catch((e) => onToast(`Error: ${errMsg(e)}`))}
          className="font-semibold text-navy-700 hover:underline"
        >
          Descargar convenio
        </button>
      ) : (
        <span className="text-slate-400">Sin archivo adjunto</span>
      )}
      {isAdmin && (
        <label className="inline-flex cursor-pointer items-center gap-1 font-semibold text-navy-700 hover:underline">
          <Upload className="h-3.5 w-3.5" />
          {subiendo ? 'Subiendo…' : convenio.fileId ? 'Reemplazar archivo' : 'Adjuntar archivo'}
          <input
            type="file"
            accept="application/pdf,image/jpeg,image/png"
            aria-label="Adjuntar archivo del convenio"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void subir(f); e.target.value = ''; }}
          />
        </label>
      )}
    </div>
  );
}

/**
 * The only path to `firmado` (D9). Provider and reference are both required by the API because
 * "signed" without either would mean only that somebody pressed a button — and every rate in the
 * agreement would then rest on that button.
 */
function FirmarConvenio({ transportistaId, convenioId, onToast, onChanged }: {
  transportistaId: string;
  convenioId: string;
  onToast: (msg: string) => void;
  onChanged: () => void | Promise<void>;
}) {
  const [abierto, setAbierto] = useState(false);
  const [proveedor, setProveedor] = useState('');
  const [referencia, setReferencia] = useState('');
  const [guardando, setGuardando] = useState(false);

  async function firmar() {
    if (!proveedor.trim() || !referencia.trim()) {
      onToast('Error: el proveedor y la referencia de firma son obligatorios.');
      return;
    }
    setGuardando(true);
    try {
      await apiPost(`/api/transportistas/${transportistaId}/convenios/${convenioId}/firmar`, {
        firmaProveedor: proveedor.trim(),
        firmaReferencia: referencia.trim(),
      });
      onToast('Convenio firmado');
      setProveedor(''); setReferencia(''); setAbierto(false);
      await onChanged();
    } catch (e) {
      onToast(`Error: ${errMsg(e)}`);
    } finally {
      setGuardando(false);
    }
  }

  if (!abierto) {
    return (
      <button
        type="button"
        onClick={() => setAbierto(true)}
        className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-navy-700 hover:underline"
      >
        <PenLine className="h-3.5 w-3.5" /> Registrar firma
      </button>
    );
  }

  return (
    <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <p className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-600">Registrar firma</p>
      <p className="mb-3 text-[11px] text-slate-500">
        Se registra una firma realizada en el proveedor de firma electrónica; el sistema no firma por sí mismo.
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Proveedor de firma *" htmlFor={`fi-prov-${convenioId}`}>
          <Input id={`fi-prov-${convenioId}`} value={proveedor} onChange={(e) => setProveedor(e.target.value)} placeholder="p. ej. Mifiel" />
        </Field>
        <Field label="Referencia *" htmlFor={`fi-ref-${convenioId}`}>
          <Input id={`fi-ref-${convenioId}`} value={referencia} onChange={(e) => setReferencia(e.target.value)} className="font-mono" />
        </Field>
      </div>
      <div className="mt-3 flex gap-2">
        <Button onClick={firmar} disabled={guardando}>Firmar convenio</Button>
        <Button variant="secondary" onClick={() => setAbierto(false)}>Cancelar</Button>
      </div>
    </div>
  );
}

const TARIFA_VACIA = {
  tipoUnidad: TIPOS_UNIDAD[0].id as string,
  direccionEntregaId: '',
  tarifa: '',
  moneda: 'MXN',
  vigenciaDesde: '',
  vigenciaHasta: '',
};

function TarifasTabla({ transportistaId, convenio, destinos, isAdmin, onToast, onChanged }: {
  transportistaId: string;
  convenio: Convenio;
  destinos: Destino[];
  isAdmin: boolean;
  onToast: (msg: string) => void;
  onChanged: () => void | Promise<void>;
}) {
  const [abierto, setAbierto] = useState(false);
  const [form, setForm] = useState(TARIFA_VACIA);
  const [guardando, setGuardando] = useState(false);

  function etiquetaDestino(id: string | null): string {
    if (!id) return 'Cualquier destino';
    const d = destinos.find((x) => x.id === id);
    return d ? `${d.cliente} · ${d.alias}` : 'Destino específico';
  }

  async function agregar() {
    if (form.tarifa.trim() === '') { onToast('Error: la tarifa es obligatoria.'); return; }
    setGuardando(true);
    try {
      const body: Record<string, unknown> = {
        tipoUnidad: form.tipoUnidad,
        tarifa: Number(form.tarifa),
        moneda: form.moneda.trim().toUpperCase() || 'MXN',
      };
      if (form.direccionEntregaId) body.direccionEntregaId = form.direccionEntregaId;
      if (form.vigenciaDesde) body.vigenciaDesde = form.vigenciaDesde;
      if (form.vigenciaHasta) body.vigenciaHasta = form.vigenciaHasta;
      await apiPost(`/api/transportistas/${transportistaId}/convenios/${convenio.id}/tarifas`, body);
      onToast('Tarifa registrada');
      setForm(TARIFA_VACIA);
      setAbierto(false);
      await onChanged();
    } catch (e) {
      onToast(`Error: ${errMsg(e)}`);
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div className="mt-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-600">
          <Coins className="h-3.5 w-3.5 text-navy-700" /> Tarifas ({convenio.tarifas.length})
        </p>
        {isAdmin && !abierto && (
          <button type="button" onClick={() => setAbierto(true)} className="inline-flex items-center gap-1 text-xs font-semibold text-navy-700 hover:underline">
            <Plus className="h-3.5 w-3.5" /> Agregar tarifa
          </button>
        )}
      </div>

      {convenio.tarifas.length === 0 ? (
        <p className="text-xs text-slate-400">Sin tarifas en este convenio.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2 font-semibold">Tipo de unidad</th>
                <th className="px-3 py-2 font-semibold">Destino</th>
                <th className="px-3 py-2 font-semibold">Tarifa</th>
                <th className="px-3 py-2 font-semibold">Vigencia</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {convenio.tarifas.map((t) => (
                <tr key={t.id} className={convenio.vigente ? '' : 'text-slate-400'}>
                  <td className="px-3 py-2">{etiquetaTipoUnidad(t.tipoUnidad)}</td>
                  <td className="px-3 py-2">{etiquetaDestino(t.direccionEntregaId)}</td>
                  <td className="px-3 py-2 tabular-nums font-semibold">{fmtMonto(t.tarifa, t.moneda)}</td>
                  <td className="px-3 py-2 text-xs">{fmtDate(t.vigenciaDesde)} → {fmtDate(t.vigenciaHasta)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {isAdmin && abierto && (
        <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-xs font-bold uppercase tracking-wide text-slate-600">Nueva tarifa</p>
            <button type="button" onClick={() => setAbierto(false)} aria-label="Cancelar nueva tarifa" className="text-slate-400 hover:text-slate-700">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Tipo de unidad *" htmlFor={`tf-tipo-${convenio.id}`}>
              <select id={`tf-tipo-${convenio.id}`} className={SELECT_CLS} value={form.tipoUnidad} onChange={(e) => setForm({ ...form, tipoUnidad: e.target.value })}>
                {TIPOS_UNIDAD.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
            </Field>
            <Field label="Destino" htmlFor={`tf-dest-${convenio.id}`}>
              <select id={`tf-dest-${convenio.id}`} className={SELECT_CLS} value={form.direccionEntregaId} onChange={(e) => setForm({ ...form, direccionEntregaId: e.target.value })}>
                <option value="">Cualquier destino</option>
                {destinos.map((d) => <option key={d.id} value={d.id}>{d.cliente} · {d.alias}</option>)}
              </select>
            </Field>
            <Field label="Tarifa *" htmlFor={`tf-monto-${convenio.id}`}>
              <Input id={`tf-monto-${convenio.id}`} type="number" min="0" step="0.01" value={form.tarifa} onChange={(e) => setForm({ ...form, tarifa: e.target.value })} className="font-mono" />
            </Field>
            <Field label="Moneda" htmlFor={`tf-moneda-${convenio.id}`}>
              <Input id={`tf-moneda-${convenio.id}`} value={form.moneda} maxLength={3} onChange={(e) => setForm({ ...form, moneda: e.target.value.toUpperCase() })} className="font-mono" />
            </Field>
            <Field label="Vigencia desde" htmlFor={`tf-desde-${convenio.id}`}>
              <Input id={`tf-desde-${convenio.id}`} type="date" value={form.vigenciaDesde} onChange={(e) => setForm({ ...form, vigenciaDesde: e.target.value })} />
            </Field>
            <Field label="Vigencia hasta" htmlFor={`tf-hasta-${convenio.id}`}>
              <Input id={`tf-hasta-${convenio.id}`} type="date" value={form.vigenciaHasta} onChange={(e) => setForm({ ...form, vigenciaHasta: e.target.value })} />
            </Field>
          </div>
          <Button className="mt-3" onClick={agregar} disabled={guardando}>
            <Plus className="h-4 w-4" /> Registrar tarifa
          </Button>
        </div>
      )}
    </div>
  );
}
