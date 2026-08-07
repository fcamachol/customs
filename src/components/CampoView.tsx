import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, Camera, Smartphone } from 'lucide-react';
import { apiGet, apiPost, apiUpload, ApiError } from '../api';
import { EmptyState } from './ui';

// ---- API contract types (GET /api/campo/tareas — the tramitador's queue, arribo first) ---------

interface TareaItem {
  id: string;
  mawb: string;
  etapa: string;
  arriboVueloAt: string | null;
  disponibleAt: string | null;
  semaforo: 'green' | 'red' | null;
  numeroVuelo: string | null;
}

type EventoTipo =
  | 'CARGA_DISPONIBLE' | 'INGRESO_PATIO' | 'INGRESO_ADUANA'
  | 'INICIO_CARGA' | 'FIN_CARGA' | 'MODULACION' | 'SALIDA_ROJO';

interface EventoResponse { ok: true; etapa?: string; noop?: boolean; [k: string]: unknown }

interface EventoState {
  status: 'idle' | 'loading' | 'success' | 'noop' | 'error';
  message?: string;
  at?: string;
}

const IDLE_EVENTO: EventoState = { status: 'idle' };

type EvidenciaTipo = 'inicio_carga' | 'fin_carga';

interface EvidenciaState {
  status: 'idle' | 'uploading' | 'success' | 'error';
  hash?: string;
  message?: string;
}

const IDLE_EVIDENCIA: EvidenciaState = { status: 'idle' };

// ---- Formatting helpers -----------------------------------------------------------------

function fmtDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('es-MX', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtTime(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
}

function humanize(v: string): string {
  return v.replace(/_/g, ' ');
}

function toDatetimeLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---- Queue (default view) ----------------------------------------------------------------

const POLL_MS = 60_000;

export default function CampoView() {
  const [tareas, setTareas] = useState<TareaItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<TareaItem | null>(null);
  const inFlight = useRef(false);

  async function load() {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    try {
      const rows = await apiGet<TareaItem[]>('/api/campo/tareas');
      setTareas(rows);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al cargar la cola de tareas.');
    } finally {
      setLoading(false);
      inFlight.current = false;
    }
  }

  useEffect(() => {
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, []);

  if (selected) {
    // Keyed by tarea id (via the Fragment — see the codebase-wide convention of never keying a
    // custom component directly) so every capture panel mounts fresh state (events, coords,
    // modulación choice, evidencia) — no leftover state from a previously captured tarea.
    return (
      <Fragment key={selected.id}>
        <CapturaPanel tarea={selected} onBack={() => { setSelected(null); load(); }} />
      </Fragment>
    );
  }

  return (
    <div className="mx-auto max-w-md space-y-3">
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">{error}</div>
      )}

      {loading && tareas.length === 0 && !error && <p className="px-1 text-sm text-slate-500">Cargando…</p>}

      {!loading && !error && tareas.length === 0 && (
        <EmptyState icon={Smartphone} title="Sin tareas" message="No hay operaciones pendientes de captura." />
      )}

      {tareas.map((t) => (
        <Fragment key={t.id}>
          <TareaCard tarea={t} onOpen={() => setSelected(t)} />
        </Fragment>
      ))}
    </div>
  );
}

function TareaCard({ tarea, onOpen }: { tarea: TareaItem; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full rounded-xl border border-slate-200 bg-white p-4 text-left shadow-sm transition active:bg-slate-50"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-lg font-bold text-slate-900">{tarea.mawb}</span>
        <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600 ring-1 ring-inset ring-slate-500/20">
          {humanize(tarea.etapa)}
        </span>
      </div>
      <div className="mt-1 text-sm text-slate-500">
        {tarea.numeroVuelo ?? '—'} · arribo {fmtDateTime(tarea.arriboVueloAt)}
      </div>
    </button>
  );
}

// ---- Capture panel (full-screen takeover) ------------------------------------------------

function CapturaPanel({ tarea, onBack }: { tarea: TareaItem; onBack: () => void }) {
  const [eventos, setEventos] = useState<Partial<Record<EventoTipo, EventoState>>>({});
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [moduloOpen, setModuloOpen] = useState(false);
  const [moduloAt, setModuloAt] = useState(() => toDatetimeLocal(new Date()));
  const [citaAt, setCitaAt] = useState('');
  const [evidencia, setEvidencia] = useState<Record<EvidenciaTipo, EvidenciaState>>({
    inicio_carga: IDLE_EVIDENCIA,
    fin_carga: IDLE_EVIDENCIA,
  });

  // One silent attempt at geolocation when the panel opens. Never blocks capture — a failure
  // (denied permission, no GPS, etc.) just means lat/lng are omitted from the posts below.
  useEffect(() => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => setCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => { /* silent failure — no GPS, denied permission, etc. */ },
    );
  }, []);

  function errorMessageFor(err: unknown, fallback: string): string {
    if (err instanceof ApiError) {
      const etapaActual = (err.body as Record<string, unknown> | undefined)?.etapaActual;
      return typeof etapaActual === 'string' ? `${err.message} (etapa actual: ${humanize(etapaActual)})` : err.message;
    }
    if (err instanceof Error) return err.message;
    return fallback;
  }

  // Posts a single evento and reflects the server's answer verbatim — a 201 is a success, a
  // 200/noop means it was already registered, and a 409/400 surfaces the server's Spanish
  // message. Buttons are NEVER disabled client-side based on the tarea's etapa: the server is
  // the sole authority on the operational state machine, so its noop/409 responses ARE the
  // truth about whether an action is valid right now — not anything computed here.
  async function postEvento(tipo: EventoTipo, extra?: Record<string, unknown>) {
    setEventos((prev) => ({ ...prev, [tipo]: { status: 'loading' } }));
    try {
      const body: Record<string, unknown> = { tipo, ...extra };
      if (coords) { body.lat = coords.lat; body.lng = coords.lng; }
      const resp = await apiPost<EventoResponse>(`/api/campo/operaciones/${tarea.id}/evento`, body);
      setEventos((prev) => ({
        ...prev,
        [tipo]: { status: resp.noop ? 'noop' : 'success', at: new Date().toISOString() },
      }));
    } catch (err) {
      const message = errorMessageFor(err, 'Error al registrar el evento.');
      setEventos((prev) => ({ ...prev, [tipo]: { status: 'error', message } }));
    }
  }

  async function postEvidencia(tipo: EvidenciaTipo, file: File) {
    setEvidencia((prev) => ({ ...prev, [tipo]: { status: 'uploading' } }));
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('tipo', tipo);
      // Phones are banned at the semáforo and photos are often taken minutes late — prefer the
      // file's own timestamp when the device exposes one, falling back to "now".
      const capturadoAt = file.lastModified ? new Date(file.lastModified).toISOString() : new Date().toISOString();
      form.append('capturadoAt', capturadoAt);
      if (coords) {
        form.append('lat', String(coords.lat));
        form.append('lng', String(coords.lng));
      }
      const resp = await apiUpload<{ hash?: string; contentHash?: string }>(
        `/api/campo/operaciones/${tarea.id}/evidencia`,
        form,
      );
      setEvidencia((prev) => ({ ...prev, [tipo]: { status: 'success', hash: resp.hash ?? resp.contentHash } }));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Error al subir la evidencia.';
      setEvidencia((prev) => ({ ...prev, [tipo]: { status: 'error', message } }));
    }
  }

  async function handleModulacion(semaforo: 'green' | 'red') {
    const ocurridoAt = moduloAt ? new Date(moduloAt).toISOString() : new Date().toISOString();
    await postEvento('MODULACION', { semaforo, ocurridoAt });
  }

  function handleIngresoAduana() {
    const extra = citaAt ? { citaAt: new Date(citaAt).toISOString() } : undefined;
    void postEvento('INGRESO_ADUANA', extra);
  }

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-50">
      <div className="mx-auto max-w-md space-y-4 p-4 pb-12">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-navy-700"
        >
          <ArrowLeft className="h-4 w-4" /> Volver a la cola
        </button>

        <div>
          <div className="font-mono text-xl font-bold text-slate-900">{tarea.mawb}</div>
          <div className="text-sm text-slate-500">{tarea.numeroVuelo ?? '—'} · {humanize(tarea.etapa)}</div>
        </div>

        <CampoButton label="Disponible" evento={eventos.CARGA_DISPONIBLE ?? IDLE_EVENTO} onClick={() => void postEvento('CARGA_DISPONIBLE')} />

        <CampoButton label="Ingreso a patio" evento={eventos.INGRESO_PATIO ?? IDLE_EVENTO} onClick={() => void postEvento('INGRESO_PATIO')} />

        <CampoButton label="Ingreso a aduana" evento={eventos.INGRESO_ADUANA ?? IDLE_EVENTO} onClick={handleIngresoAduana}>
          <label className="mt-2 block text-xs font-medium text-slate-500">
            Hora citada (opcional)
            <input
              type="datetime-local"
              value={citaAt}
              onChange={(e) => setCitaAt(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-navy-500 focus:ring-2 focus:ring-navy-500/25"
            />
          </label>
        </CampoButton>

        <CampoButton label="Inicio de carga" evento={eventos.INICIO_CARGA ?? IDLE_EVENTO} onClick={() => void postEvento('INICIO_CARGA')}>
          <FotoControl tipo="inicio_carga" label="inicio de carga" state={evidencia.inicio_carga} onSelect={(f) => void postEvidencia('inicio_carga', f)} />
        </CampoButton>

        <CampoButton label="Fin de carga" evento={eventos.FIN_CARGA ?? IDLE_EVENTO} onClick={() => void postEvento('FIN_CARGA')}>
          <FotoControl tipo="fin_carga" label="fin de carga" state={evidencia.fin_carga} onSelect={(f) => void postEvidencia('fin_carga', f)} />
        </CampoButton>

        <ModulacionSection
          evento={eventos.MODULACION ?? IDLE_EVENTO}
          open={moduloOpen}
          at={moduloAt}
          onToggle={() => setModuloOpen((o) => !o)}
          onAtChange={setModuloAt}
          onChoose={(s) => void handleModulacion(s)}
        />

        <CampoButton label="Salida de rojo" evento={eventos.SALIDA_ROJO ?? IDLE_EVENTO} onClick={() => void postEvento('SALIDA_ROJO')} />
      </div>
    </div>
  );
}

// One-tap event button: shows a ✓ + timestamp on success, "Ya registrado" on a noop response,
// or the server's error message (409/400) below. Disabled only while ITS OWN request is
// in flight — never disabled based on the tarea's etapa (see comment on postEvento above).
function CampoButton({ label, evento, onClick, children }: {
  label: string; evento: EventoState; onClick: () => void; children?: ReactNode;
}) {
  const loading = evento.status === 'loading';
  return (
    <div>
      <button
        type="button"
        onClick={onClick}
        disabled={loading}
        className="flex min-h-[56px] w-full items-center justify-between gap-2 rounded-xl border border-slate-300 bg-white px-4 text-lg font-semibold text-slate-800 shadow-sm transition active:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
      >
        <span>{label}</span>
        {loading && <span className="text-sm font-medium text-slate-400">Enviando…</span>}
        {evento.status === 'success' && <span className="text-sm font-medium text-emerald-600">✓ {fmtTime(evento.at)}</span>}
        {evento.status === 'noop' && <span className="text-sm font-medium text-slate-400">Ya registrado</span>}
      </button>
      {evento.status === 'error' && (
        <div className="mt-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700">{evento.message}</div>
      )}
      {children}
    </div>
  );
}

function FotoControl({ tipo, label, state, onSelect }: {
  tipo: EvidenciaTipo; label: string; state: EvidenciaState; onSelect: (file: File) => void;
}) {
  const inputId = `foto-${tipo}`;
  const uploading = state.status === 'uploading';
  return (
    <div className="mt-2">
      <input
        id={inputId}
        data-testid={inputId}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onSelect(file);
          e.target.value = '';
        }}
      />
      <label
        htmlFor={inputId}
        className={`inline-flex min-h-[44px] w-full cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-2 text-sm font-medium text-slate-600 transition hover:border-navy-400 hover:text-navy-800 ${uploading ? 'pointer-events-none opacity-60' : ''}`}
      >
        <Camera className="h-4 w-4" />
        {uploading ? 'Subiendo…' : `Tomar foto (${label})`}
      </label>
      {state.status === 'success' && (
        <div className="mt-1 text-xs font-medium text-emerald-600">✓ <span className="font-mono">{(state.hash ?? '').slice(0, 12)}</span></div>
      )}
      {state.status === 'error' && (
        <div className="mt-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700">{state.message}</div>
      )}
    </div>
  );
}

// Modulación is the one non-trivial capture: it needs the fiscal-traffic-light result (green/red
// — deliberately English, the client-facing value, never translated to verde/rojo) and a time
// field, since phones are banned at the semáforo and this is always captured minutes late.
function ModulacionSection({ evento, open, at, onToggle, onAtChange, onChoose }: {
  evento: EventoState; open: boolean; at: string;
  onToggle: () => void; onAtChange: (v: string) => void; onChoose: (s: 'green' | 'red') => void;
}) {
  const loading = evento.status === 'loading';
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className="flex min-h-[56px] w-full items-center justify-between gap-2 rounded-xl border border-slate-300 bg-white px-4 text-lg font-semibold text-slate-800 shadow-sm transition active:bg-slate-50"
      >
        <span>Modulación</span>
        {evento.status === 'success' && <span className="text-sm font-medium text-emerald-600">✓ {fmtTime(evento.at)}</span>}
        {evento.status === 'noop' && <span className="text-sm font-medium text-slate-400">Ya registrado</span>}
      </button>

      {evento.status === 'error' && (
        <div className="mt-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700">{evento.message}</div>
      )}

      {open && (
        <div className="mt-2 space-y-3 rounded-xl border border-slate-200 bg-white p-3">
          <p className="text-xs font-medium text-slate-500">Resultado del semáforo fiscal</p>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              disabled={loading}
              onClick={() => onChoose('green')}
              className="min-h-[56px] rounded-xl bg-emerald-600 text-lg font-bold text-white shadow-sm transition active:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              green
            </button>
            <button
              type="button"
              disabled={loading}
              onClick={() => onChoose('red')}
              className="min-h-[56px] rounded-xl bg-red-600 text-lg font-bold text-white shadow-sm transition active:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              red
            </button>
          </div>
          <label className="block text-xs font-medium text-slate-500">
            Hora
            <input
              type="datetime-local"
              value={at}
              onChange={(e) => onAtChange(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-navy-500 focus:ring-2 focus:ring-navy-500/25"
            />
          </label>
        </div>
      )}
    </div>
  );
}
