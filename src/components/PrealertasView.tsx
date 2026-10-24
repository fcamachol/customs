import { useEffect, useMemo, useState } from 'react';
import { Search, X, Inbox, AlertTriangle, Download, RefreshCw, Plane } from 'lucide-react';
import { apiGet, apiPost, apiDownload } from '../api';
import { Card, EmptyState, Modal, StatusPill, Button } from './ui';
import type { Resultado } from './ui';

// ---- API contract types (Sistema de Operaciones — read-only from this view) ----------------

interface OperacionListItem {
  id: string; mawb: string; mawbRaw: string | null; clienteNombre: string | null;
  origenIata: string | null; destinoIata: string | null; numeroVuelo: string | null;
  etdOrigen: string | null; etaPais: string | null;
  cartonesPrealerta: number | null; piezasPrealerta: number | null; pesoKgPrealerta: number | null;
  etapa: string; estadoDocumental: string; estadoPlaneacion: string;
  semaforo: 'green' | 'red' | null; holdActivo: boolean;
  createdAt: string; vueloEstado: string | null; vueloEtaEstimado: string | null;
  vueloArriboReal: string | null; discrepanciasCount: number; prealertaVersion: number;
}

interface Discrepancia {
  codigo: string;
  severidad: string;
  /** Human-readable, Spanish, produced by shared/operaciones/cotejo.ts — the primary line to show. */
  mensaje?: string;
  /** Machine-readable evidence: what was compared and what each side said. Rendered as a definition
   * list, never as raw JSON or String(object) — see the 2026-08 [object Object] incident. */
  detalle?: Record<string, unknown>;
}

interface VueloObservado {
  numeroVuelo: string; callsign: string | null; aerolinea: string | null;
  origenIata: string | null; destinoIata: string | null; fechaOperacion: string | null;
  etdProgramado: string | null; etaProgramado: string | null; etdReal: string | null;
  etaEstimado: string | null; arriboReal: string | null; estado: string;
  fuente: string | null; ultimaLat: number | null; ultimaLon: number | null;
  ultimaAltitudFt: number | null; ultimaConsultaAt: string | null;
  aeronaveTipo: string | null; matricula: string | null; progresoPct: number | null;
}

/** Lo que responde POST /api/operaciones/:id/vuelo/refresh. */
interface RefreshVueloResult {
  status: 'sin_vuelo_declarado' | 'no_identificado' | 'actualizado' | 'sin_cambio' | 'error_proveedor';
  estadoVuelo?: string;
  discrepancias?: number;
  errores?: Array<{ provider: string; message: string }>;
}

interface ParserWarning { code: string; field?: string; detail?: string }

interface Adjunto {
  id: string; tipo: 'awb' | 'manifiesto' | 'otro'; originalName: string | null;
  contentHash: string | null; scanVerdict: string | null; fileId: string | null;
}

interface Prealerta {
  id: string; version: number; recibidoAt: string; remitente: string | null; asunto: string | null;
  estado: string; motivoRechazo: string | null; parserVersion: string | null; messageId: string | null;
  parsed: { fields: Record<string, unknown>; warnings: ParserWarning[] } | null;
  rawFileId: string | null;
  adjuntos: Adjunto[];
}

interface TimelineEvent {
  id: string; tipo: string; origen: string; ocurridoAt: string;
  registradoAt: string; override: boolean; motivo: string | null; payload: unknown;
}

interface OperacionDetail extends OperacionListItem {
  discrepancias: Discrepancia[] | null;
  cotejoVersion: string | null; arriboVueloAt: string | null; disponibleAt: string | null;
  agoraConversationId: string | null; manifestId: string | null;
  vuelo: VueloObservado | null;
  prealertas: Prealerta[];
  timeline: TimelineEvent[];
}

// ---- Formatting helpers -----------------------------------------------------------------

function fmtDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('es-MX', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtTimeOnly(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
}

function sameDay(a: string, b: string): boolean {
  const da = new Date(a);
  const db = new Date(b);
  if (Number.isNaN(da.getTime()) || Number.isNaN(db.getTime())) return false;
  return da.toDateString() === db.toDateString();
}

// The gap between "ocurrió" (client-declared / real-world event time) and "registrado" (when it
// landed in our system) is meaningful — e.g. a late capture at the semáforo — so it's always
// surfaced explicitly rather than collapsed into a single timestamp.
function formatTimelineWhen(ev: TimelineEvent): string {
  if (ev.ocurridoAt === ev.registradoAt) return fmtDateTime(ev.ocurridoAt);
  const compact = sameDay(ev.ocurridoAt, ev.registradoAt);
  const ocurrido = compact ? fmtTimeOnly(ev.ocurridoAt) : fmtDateTime(ev.ocurridoAt);
  const registrado = compact ? fmtTimeOnly(ev.registradoAt) : fmtDateTime(ev.registradoAt);
  return `ocurrió ${ocurrido} · registrado ${registrado}`;
}

function fmtNumber(n: number | null): string {
  if (n === null || n === undefined) return '—';
  return n.toLocaleString('es-MX');
}

function fmtRoute(origen: string | null, destino: string | null): string {
  if (!origen && !destino) return '—';
  return `${origen ?? '—'} → ${destino ?? '—'}`;
}

// Un feed de vuelo sin fecha de consulta miente por omisión: un dato de hace tres días se ve
// idéntico a uno de hace un minuto. Por eso la antigüedad se muestra SIEMPRE, en lenguaje llano.
function fmtAntiguedad(iso: string | null): string {
  if (!iso) return 'nunca consultado';
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return 'nunca consultado';
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'hace unos segundos';
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h} h`;
  return `hace ${Math.floor(h / 24)} d`;
}

// Nombre del proveedor tal como lo emite services/flightProviders, traducido a algo que un
// operador pueda citarle a la autoridad.
const FUENTE_LABELS: Record<string, string> = {
  'flightaware.aeroapi': 'FlightAware AeroAPI',
  'adsb.lol': 'ADS-B comunitario',
};

// El estado del vuelo es la única parte del panel que debe leerse de un vistazo: el color va por
// consecuencia operativa, no por estética. Rojo = la carga no llega como se planeó.
const ESTADO_VUELO_STYLE: Record<string, string> = {
  aterrizado: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  en_ruta: 'bg-blue-50 text-blue-700 ring-blue-600/20',
  demorado: 'bg-amber-50 text-amber-700 ring-amber-600/20',
  cancelado: 'bg-red-50 text-red-700 ring-red-600/20',
  desviado: 'bg-red-50 text-red-700 ring-red-600/20',
  programado: 'bg-slate-100 text-slate-600 ring-slate-500/20',
  desconocido: 'bg-slate-100 text-slate-600 ring-slate-500/20',
};

/** Minutos de diferencia entre lo programado y lo real, con signo legible. */
function fmtDesfase(programado: string | null, real: string | null): string | null {
  if (!programado || !real) return null;
  const d = (new Date(real).getTime() - new Date(programado).getTime()) / 60000;
  if (!Number.isFinite(d) || Math.abs(d) < 1) return null;
  const m = Math.round(Math.abs(d));
  const txt = m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
  return d > 0 ? `+${txt} tarde` : `−${txt} antes`;
}

function humanize(v: string): string {
  return v.replace(/_/g, ' ');
}

// Parser-warning codes (shared/operaciones/prealerta.ts PrealertaWarningCode) mapped to the Spanish
// sentence an operator should read. Unknown codes fall back to the raw code rather than disappearing.
const WARNING_MESSAGES: Record<string, string> = {
  etd_no_encontrado: 'No se encontró la fecha estimada de salida (ETD)',
  eta_no_encontrado: 'No se encontró la fecha estimada de arribo (ETA)',
  ruta_no_encontrada: 'No se encontró la ruta origen–destino',
  cartones_no_encontrado: 'No se encontró cartones en la prealerta',
  piezas_no_encontrado: 'No se encontró piezas en la prealerta',
  peso_no_encontrado: 'No se encontró peso en la prealerta',
  vuelo_no_encontrado: 'No se encontró el número de vuelo',
  mawb_no_encontrado: 'No se encontró la guía máster',
  mawb_multiple: 'La prealerta menciona varias guías máster',
  fecha_ambigua: 'Fecha ambigua (día/mes)',
  anio_inferido: 'El año de la fecha fue inferido',
  valor_no_numerico: 'Valor no numérico',
};

function warningMessage(w: ParserWarning): string {
  return WARNING_MESSAGES[w.code] ?? w.code;
}

// severidad values (shared/operaciones/cotejo.ts SeveridadDiscrepancia) mapped onto the shared
// StatusPill palette: error is a hard red flag, advertencia needs a look, informativa is FYI.
const SEVERIDAD_RESULTADO: Record<string, Resultado> = {
  error: 'rojo', advertencia: 'amarillo', informativa: 'gris',
};

function SeveridadPill({ value }: { value: string }) {
  return <StatusPill resultado={SEVERIDAD_RESULTADO[value] ?? 'gris'} label={value} />;
}

// Discrepancia.detalle is machine-readable evidence (PA-01..PA-10 shapes vary: numbers, strings,
// arrays of guías, nested fuente objects). Rendered as text — NEVER via String(object), which is
// what produced the "[object Object]" incident this view exists to fix.
function formatDetalleValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') return v.toLocaleString('es-MX');
  if (typeof v === 'boolean') return v ? 'sí' : 'no';
  if (Array.isArray(v)) {
    return v.map((x) => (x !== null && typeof x === 'object' ? JSON.stringify(x) : String(x))).join(', ');
  }
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

const ADJUNTO_TIPO_LABEL: Record<Adjunto['tipo'], string> = { awb: 'AWB', manifiesto: 'Manifiesto', otro: 'Otro' };

// scanVerdict values come from the antivirus/content scan pipeline; map them onto the shared
// StatusPill palette without inventing translations for values not documented here.
const SCAN_VERDICT_RESULTADO: Record<string, Resultado> = {
  clean: 'verde', suspicious: 'amarillo', unscannable: 'amarillo', blocked: 'rojo',
};

const SCAN_VERDICT_LABEL: Record<string, string> = {
  clean: 'Limpio',
  suspicious: 'Sospechoso',
  unscannable: 'No se pudo escanear',
  infected: 'Infectado',
};

function ScanVerdictPill({ verdict }: { verdict: string | null }) {
  if (!verdict) return <StatusPill resultado="gris" label="Sin escanear" />;
  // Los veredictos llegan del pipeline de escaneo en inglés (`clean`, `suspicious`,
  // `unscannable`). Mostrarlos crudos deja al operador adivinando; la pantalla de captura ya los
  // traducía y ésta no, así que decían cosas distintas sobre el mismo dato.
  return <StatusPill resultado={SCAN_VERDICT_RESULTADO[verdict] ?? 'gris'} label={SCAN_VERDICT_LABEL[verdict] ?? verdict} />;
}

// Semáforo is deliberately shown in English (green/red) — the client sees this exact value, so
// the UI must not relabel it into verde/rojo.
function SemaforoPill({ value }: { value: 'green' | 'red' | null }) {
  if (!value) return <StatusPill resultado="gris" label="Sin semáforo" />;
  const cls = value === 'green'
    ? 'bg-emerald-50 text-emerald-700 ring-emerald-600/20'
    : 'bg-red-50 text-red-700 ring-red-600/20';
  const dot = value === 'green' ? 'bg-emerald-500' : 'bg-red-500';
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${cls}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {value}
    </span>
  );
}

function StatePill({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{label}</div>
      <span className="mt-1 inline-flex items-center rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700 ring-1 ring-inset ring-slate-500/20">
        {humanize(value)}
      </span>
    </div>
  );
}

const SELECT_CLS =
  'rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-navy-500 focus:ring-2 focus:ring-navy-500/25';

export default function PrealertasView() {
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [etapa, setEtapa] = useState('');
  const [conDiscrepancias, setConDiscrepancias] = useState(false);

  const [operaciones, setOperaciones] = useState<OperacionListItem[]>([]);
  const [etapaOptions, setEtapaOptions] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<OperacionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  // Debounce free-text search, matching ConsultaView's idiom.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(t);
  }, [query]);

  // Seed the etapa filter options from an unfiltered read — there's no separate catalog endpoint.
  useEffect(() => {
    let active = true;
    apiGet<OperacionListItem[]>('/api/operaciones')
      .then((rows) => {
        if (!active) return;
        setEtapaOptions(Array.from(new Set(rows.map((r) => r.etapa))).sort());
      })
      .catch(() => { /* filter degrades to no options */ });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (debouncedQuery.trim()) params.set('q', debouncedQuery.trim());
    if (etapa) params.set('etapa', etapa);
    if (conDiscrepancias) params.set('conDiscrepancias', 'true');
    apiGet<OperacionListItem[]>(`/api/operaciones?${params.toString()}`)
      .then((rows) => { if (active) setOperaciones(rows); })
      .catch((err) => { if (active) setError(err instanceof Error ? err.message : 'Error al buscar operaciones.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [debouncedQuery, etapa, conDiscrepancias]);

  async function openDetail(id: string) {
    setSelectedId(id);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    try {
      const d = await apiGet<OperacionDetail>(`/api/operaciones/${id}`);
      setDetail(d);
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : 'Error al cargar la operación.');
    } finally {
      setDetailLoading(false);
    }
  }

  function closeDetail() {
    setSelectedId(null);
    setDetail(null);
    setDetailError(null);
  }

  const hasFilters = useMemo(() => Boolean(debouncedQuery.trim() || etapa || conDiscrepancias), [debouncedQuery, etapa, conDiscrepancias]);

  return (
    <div className="space-y-6">
      <Card className="p-4 shadow-sm">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <div className="relative sm:col-span-2">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar por guía máster o vuelo"
              className={`w-full rounded-lg border border-slate-300 bg-white py-2.5 pr-3.5 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-navy-500 focus:ring-2 focus:ring-navy-500/25 ${query ? 'px-10' : 'pl-10'}`}
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label="Limpiar búsqueda"
                className="absolute right-3 top-1/2 -translate-y-1/2 rounded p-0.5 text-slate-400 transition hover:text-slate-700"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          <select
            className={`${SELECT_CLS} w-full`}
            value={etapa}
            onChange={(e) => setEtapa(e.target.value)}
            aria-label="Filtrar por etapa"
          >
            <option value="">Etapa: todas</option>
            {etapaOptions.map((o) => <option key={o} value={o}>{humanize(o)}</option>)}
          </select>
          <label className="flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={conDiscrepancias}
              onChange={(e) => setConDiscrepancias(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-navy-700 focus:ring-navy-500/25"
            />
            Sólo con discrepancias
          </label>
        </div>
      </Card>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">{error}</div>
      )}

      {loading && <p className="px-1 text-sm text-slate-500">Cargando…</p>}

      {!loading && !error && operaciones.length === 0 && (
        <EmptyState
          icon={Inbox}
          title="Sin prealertas"
          message={hasFilters ? 'No hay operaciones que coincidan con estos filtros.' : 'Aún no se ha recibido ninguna prealerta del cliente.'}
        />
      )}

      {!loading && !error && operaciones.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-xs font-bold uppercase tracking-wide text-slate-400">
                <th className="px-4 py-3">Guía máster</th>
                <th className="px-4 py-3">Cliente</th>
                <th className="px-4 py-3">Ruta</th>
                <th className="px-4 py-3">Vuelo</th>
                <th className="px-4 py-3">ETA</th>
                <th className="px-4 py-3 text-right">Piezas</th>
                <th className="px-4 py-3 text-right">Cartones</th>
                <th className="px-4 py-3 text-right">Peso (kg)</th>
                <th className="px-4 py-3">Etapa</th>
                <th className="px-4 py-3">Discrepancias</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {operaciones.map((op) => (
                <tr
                  key={op.id}
                  onClick={() => openDetail(op.id)}
                  className={`cursor-pointer border-l-4 text-sm transition-colors hover:bg-slate-50 ${
                    op.holdActivo ? 'border-red-500 bg-red-50/40' : 'border-transparent'
                  } ${selectedId === op.id ? 'bg-navy-50/40' : ''}`}
                >
                  <td className="px-4 py-3 font-mono text-slate-800">
                    {op.mawb}
                    {op.holdActivo && (
                      <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-red-700">Hold</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-700">{op.clienteNombre ?? '—'}</td>
                  <td className="px-4 py-3 text-slate-700">{fmtRoute(op.origenIata, op.destinoIata)}</td>
                  <td className="px-4 py-3 text-slate-700">{op.numeroVuelo ?? '—'}</td>
                  <td className="px-4 py-3 text-slate-700">{fmtDateTime(op.etaPais)}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-slate-700">{fmtNumber(op.piezasPrealerta)}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-slate-700">{fmtNumber(op.cartonesPrealerta)}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-slate-700">{fmtNumber(op.pesoKgPrealerta)}</td>
                  <td className="px-4 py-3 text-slate-700">{humanize(op.etapa)}</td>
                  <td className="px-4 py-3">
                    {op.discrepanciasCount > 0 ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-700 ring-1 ring-inset ring-amber-600/20">
                        <AlertTriangle className="h-3 w-3" /> {op.discrepanciasCount}
                      </span>
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selectedId && (
        <Modal open onClose={closeDetail} title={detail ? detail.mawb : 'Operación'} size="2xl">
          {detailLoading && <p className="px-1 py-6 text-sm text-slate-500">Cargando…</p>}
          {detailError && (
            <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">{detailError}</p>
          )}
          {detail && !detailLoading && (
            <OperacionDetailBody detail={detail} onRefreshed={() => { void openDetail(detail.id); }} />
          )}
        </Modal>
      )}
    </div>
  );
}

function OperacionDetailBody({ detail, onRefreshed }: { detail: OperacionDetail; onRefreshed: () => void }) {
  const [vueloRefreshing, setVueloRefreshing] = useState(false);
  const [vueloMsg, setVueloMsg] = useState<{ tono: 'ok' | 'aviso' | 'error'; texto: string } | null>(null);

  /**
   * Consulta el feed AHORA. Los cinco `status` del servicio se traducen a mensajes distintos a
   * propósito: `error_proveedor` (el feed falló) NO significa lo mismo que `no_identificado`
   * (el feed contestó y no conoce el vuelo). Colapsarlos en un "no se pudo" genérico sería
   * exactamente la ambigüedad que este sistema existe para eliminar.
   */
  async function refrescarVuelo(id: string) {
    setVueloRefreshing(true);
    setVueloMsg(null);
    try {
      const r = await apiPost<RefreshVueloResult>(`/api/operaciones/${id}/vuelo/refresh`, {});
      if (r.status === 'error_proveedor') {
        const detalle = r.errores?.map((e) => `${e.provider}: ${e.message}`).join(' · ') ?? '';
        setVueloMsg({ tono: 'error', texto: `El proveedor de vuelos falló — no dice nada sobre este vuelo. ${detalle}` });
      } else if (r.status === 'no_identificado') {
        setVueloMsg({ tono: 'aviso', texto: 'El proveedor respondió y no reconoce este vuelo en la fecha declarada.' });
      } else if (r.status === 'sin_vuelo_declarado') {
        setVueloMsg({ tono: 'aviso', texto: 'La prealerta no declara un número de vuelo que se pueda consultar.' });
      } else {
        const disc = r.discrepancias ? ` · ${r.discrepancias} discrepancia(s) de cotejo` : '';
        setVueloMsg({ tono: 'ok', texto: `Verificado contra el feed${disc}.` });
      }
      onRefreshed();
    } catch (err) {
      setVueloMsg({ tono: 'error', texto: err instanceof Error ? err.message : 'No se pudo consultar el feed de vuelo.' });
    } finally {
      setVueloRefreshing(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* The three state axes + semáforo — the axes are free-form operational states, semáforo is
          the client-facing traffic-light value and is shown verbatim in English. */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatePill label="Etapa" value={detail.etapa} />
        <StatePill label="Estado documental" value={detail.estadoDocumental} />
        <StatePill label="Estado de planeación" value={detail.estadoPlaneacion} />
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Semáforo</div>
          <div className="mt-1"><SemaforoPill value={detail.semaforo} /></div>
        </div>
      </div>

      {/* Declared (client email) vs observed (flight-tracking feed). The client DECLARES; the feed
          VERIFIES — those are different sources and must never be conflated. */}
      <Card className="p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-slate-800">Vuelo declarado vs. observado</h3>
          <Button
            variant="secondary"
            className="px-3 py-1.5 text-xs"
            disabled={vueloRefreshing}
            onClick={() => refrescarVuelo(detail.id)}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${vueloRefreshing ? 'animate-spin' : ''}`} />
            {vueloRefreshing ? 'Consultando…' : 'Consultar feed'}
          </Button>
        </div>

        {vueloMsg && (
          <p
            role="status"
            className={`mb-3 rounded-lg border px-3 py-2 text-xs ${
              vueloMsg.tono === 'ok'
                ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                : vueloMsg.tono === 'aviso'
                  ? 'border-amber-200 bg-amber-50 text-amber-800'
                  : 'border-red-200 bg-red-50 text-red-800'
            }`}
          >
            {vueloMsg.texto}
          </p>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Declarado (prealerta)</div>
            <dl className="mt-2 space-y-1 text-sm">
              <div className="flex justify-between gap-2"><dt className="text-slate-500">Vuelo</dt><dd className="font-mono text-slate-800">{detail.numeroVuelo ?? '—'}</dd></div>
              <div className="flex justify-between gap-2"><dt className="text-slate-500">Ruta</dt><dd className="font-mono text-slate-800">{fmtRoute(detail.origenIata, detail.destinoIata)}</dd></div>
              <div className="flex justify-between gap-2"><dt className="text-slate-500">ETA declarada</dt><dd className="text-slate-800">{fmtDateTime(detail.etaPais)}</dd></div>
            </dl>
          </div>
          <div>
            <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Observado (feed de vuelo)</div>
            {detail.vuelo ? (
              <>
                <dl className="mt-2 space-y-1 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-slate-500">Vuelo</dt>
                    <dd className="font-mono text-slate-800">
                      {detail.vuelo.numeroVuelo}
                      {detail.vuelo.callsign && detail.vuelo.callsign !== detail.vuelo.numeroVuelo && (
                        <span className="ml-1.5 text-xs text-slate-400" title="Identificador que transmite la aeronave (ICAO)">
                          {detail.vuelo.callsign}
                        </span>
                      )}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-slate-500">Estado</dt>
                    <dd>
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset ${
                        ESTADO_VUELO_STYLE[detail.vuelo.estado] ?? ESTADO_VUELO_STYLE.desconocido}`}>
                        {humanize(detail.vuelo.estado)}
                      </span>
                    </dd>
                  </div>
                  {/* La ruta observada va JUNTO a la declarada a propósito: esa comparación es
                      literalmente lo que evalúan PA-04 y PA-05, y verla lado a lado permite que un
                      humano confirme en un segundo lo que la regla concluyó. */}
                  <div className="flex justify-between gap-2">
                    <dt className="text-slate-500">Ruta</dt>
                    <dd className={`font-mono ${
                      detail.origenIata && detail.vuelo.origenIata &&
                      (detail.origenIata !== detail.vuelo.origenIata || detail.destinoIata !== detail.vuelo.destinoIata)
                        ? 'font-semibold text-red-700' : 'text-slate-800'}`}>
                      {fmtRoute(detail.vuelo.origenIata, detail.vuelo.destinoIata)}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-slate-500">Salida real</dt>
                    <dd className="text-right text-slate-800">
                      {fmtDateTime(detail.vuelo.etdReal)}
                      {fmtDesfase(detail.vuelo.etdProgramado, detail.vuelo.etdReal) && (
                        <span className="ml-1.5 text-xs text-amber-700">{fmtDesfase(detail.vuelo.etdProgramado, detail.vuelo.etdReal)}</span>
                      )}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2"><dt className="text-slate-500">ETA estimada</dt><dd className="text-slate-800">{fmtDateTime(detail.vuelo.etaEstimado)}</dd></div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-slate-500">Arribo real</dt>
                    <dd className="text-right text-slate-800">
                      {fmtDateTime(detail.vuelo.arriboReal)}
                      {fmtDesfase(detail.vuelo.etaProgramado, detail.vuelo.arriboReal) && (
                        <span className="ml-1.5 text-xs text-amber-700">{fmtDesfase(detail.vuelo.etaProgramado, detail.vuelo.arriboReal)}</span>
                      )}
                    </dd>
                  </div>
                  {(detail.vuelo.aeronaveTipo || detail.vuelo.matricula) && (
                    <div className="flex justify-between gap-2">
                      <dt className="text-slate-500">Aeronave</dt>
                      <dd className="font-mono text-slate-800">
                        {[detail.vuelo.aeronaveTipo, detail.vuelo.matricula].filter(Boolean).join(' · ')}
                      </dd>
                    </div>
                  )}
                </dl>

                {typeof detail.vuelo.progresoPct === 'number' && detail.vuelo.estado === 'en_ruta' && (
                  <div className="mt-2.5">
                    <div className="mb-1 flex items-center justify-between text-[11px] text-slate-500">
                      <span className="inline-flex items-center gap-1"><Plane className="h-3 w-3" />En vuelo</span>
                      <span className="font-mono">{detail.vuelo.progresoPct}%</span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-slate-200">
                      <div className="h-full rounded-full bg-navy-800 transition-[width]" style={{ width: `${Math.min(100, Math.max(0, detail.vuelo.progresoPct))}%` }} />
                    </div>
                  </div>
                )}

                {/* La procedencia del dato y su antigüedad NO son adorno: sin ellas, un valor de
                    hace tres días se ve igual que uno recién verificado, y eso es precisamente la
                    clase de silencio que este sistema no se permite. */}
                <p className="mt-3 border-t border-slate-100 pt-2 text-[11px] text-slate-500">
                  {detail.vuelo.fuente
                    ? <>Fuente: <span className="text-slate-700">{FUENTE_LABELS[detail.vuelo.fuente] ?? detail.vuelo.fuente}</span></>
                    : <span className="text-amber-700">Sin fuente registrada</span>}
                  {' · '}
                  <span className={detail.vuelo.ultimaConsultaAt ? '' : 'font-semibold text-amber-700'}>
                    {fmtAntiguedad(detail.vuelo.ultimaConsultaAt)}
                  </span>
                </p>
              </>
            ) : (
              <div className="mt-2 rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-2">
                <p className="text-sm text-slate-500">Sin verificar — no hay datos de vuelo</p>
                <p className="mt-0.5 text-[11px] text-slate-400">
                  Nadie ha consultado el feed para este caso, o el proveedor no reconoció el vuelo declarado.
                </p>
              </div>
            )}
          </div>
        </div>
      </Card>

      {/* Evidencia — per prealerta version, every attachment with its scan verdict and the FULL
          SHA-256 hash. Showing the whole hash (not a truncated prefix) is the point: it's the
          proof the file cannot be altered after the fact. */}
      <Card className="p-4">
        <h3 className="mb-3 text-sm font-semibold text-slate-800">Evidencia</h3>
        {detail.prealertas.length === 0 && <p className="text-sm text-slate-500">Sin prealertas registradas.</p>}
        <div className="space-y-4">
          {detail.prealertas.map((p) => (
            <div key={p.id} className="rounded-lg border border-slate-200 p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-slate-700">Versión {p.version}</span>
                  {p.parserVersion && (
                    <span className="font-mono text-[10px] text-slate-400" title="Versión del parser que produjo este parse">
                      parser {p.parserVersion}
                    </span>
                  )}
                </span>
                <span className="text-xs text-slate-400">
                  recibido {fmtDateTime(p.recibidoAt)}{p.remitente ? ` de ${p.remitente}` : ''}
                </span>
              </div>
              {p.asunto && <p className="mb-2 text-xs text-slate-500">Asunto: {p.asunto}</p>}

              {p.adjuntos.length === 0 ? (
                <p className="text-sm text-slate-500">Sin adjuntos.</p>
              ) : (
                <ul className="space-y-2">
                  {p.adjuntos.map((a) => (
                    <li key={a.id} className="rounded-lg bg-slate-50 p-2.5 text-sm">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-600">
                            {ADJUNTO_TIPO_LABEL[a.tipo]}
                          </span>
                          <span className="text-slate-700">{a.originalName ?? 'Sin nombre'}</span>
                          <ScanVerdictPill verdict={a.scanVerdict} />
                        </span>
                        {a.fileId && (
                          <Button
                            variant="ghost"
                            className="!px-2 !py-1 text-xs"
                            onClick={() => apiDownload(`/api/files/${a.fileId}`, a.originalName ?? 'archivo')}
                          >
                            <Download className="h-3.5 w-3.5" /> Descargar
                          </Button>
                        )}
                      </div>
                      {a.contentHash && (
                        <div className="mt-1.5 break-all font-mono text-[11px] text-slate-500">{a.contentHash}</div>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              {p.parsed?.warnings && p.parsed.warnings.length > 0 && (
                <div className="mt-2 space-y-1">
                  {p.parsed.warnings.map((w, i) => (
                    <div key={`${w.code}-${i}`} className="rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800">
                      {warningMessage(w)}
                      {w.detail ? ` — ${w.detail}` : ''}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </Card>

      {(detail.discrepancias?.length ?? 0) > 0 && (
        <Card className="p-4">
          <h3 className="mb-3 text-sm font-semibold text-slate-800">Discrepancias</h3>
          <ul className="space-y-2">
            {detail.discrepancias!.map((d, i) => (
              <li key={`${d.codigo}-${i}`} className="rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 text-xs text-amber-900">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{d.codigo}</span>
                  <SeveridadPill value={d.severidad} />
                </div>
                {/* mensaje is the primary, human-readable line — a discrepancia without one falls
                    back to its código rather than rendering nothing. */}
                <p className="mt-1 text-slate-700">{d.mensaje ?? d.codigo}</p>
                {d.detalle && (
                  <dl className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1 border-t border-amber-200/70 pt-1.5 sm:grid-cols-3">
                    {Object.entries(d.detalle).map(([k, v]) => (
                      <div key={k}>
                        <dt className="text-[11px] font-semibold uppercase text-slate-500">{k}</dt>
                        <dd className={`text-slate-800 ${typeof v === 'number' ? 'tabular-nums' : ''}`}>
                          {formatDetalleValue(v)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card className="p-4">
        <h3 className="mb-3 text-sm font-semibold text-slate-800">Bitácora</h3>
        {detail.timeline.length === 0 ? (
          <p className="text-sm text-slate-500">Sin eventos registrados.</p>
        ) : (
          <ul className="space-y-2">
            {detail.timeline.map((ev) => (
              <li key={ev.id} className="flex flex-wrap items-baseline justify-between gap-2 border-l-2 border-slate-200 pl-3 text-sm">
                <span>
                  <span className="font-semibold text-slate-700">{humanize(ev.tipo)}</span>
                  <span className="text-slate-400"> · {ev.origen}</span>
                  {ev.override && <span className="ml-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-amber-700">Override</span>}
                </span>
                <span className="text-xs text-slate-400">{formatTimelineWhen(ev)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
