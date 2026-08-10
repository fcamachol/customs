import { Fragment, useEffect, useState } from 'react';
import { Search, Truck, PackageSearch, X } from 'lucide-react';
import { apiGet } from '../api';
import { Card, EmptyState } from './ui';
import { ESTADOS_DESPACHO, etiquetaTipoUnidad } from '../../shared/operaciones/catalogos';

/**
 * TRAZABILIDAD paquete ↔ transportista (PRD-02 R21–R29).
 *
 * THE QUESTION THIS SCREEN EXISTS FOR is the one that used to cost a phone call in both directions:
 * "¿con quién salió esta guía?" and "¿qué le mandamos a esta línea?". The data was already in the
 * system after #29 — the trip knew its load and the caso knew its events — but neither could be
 * read from the other without opening every despacho one at a time.
 *
 * TWO TABS BECAUSE THEY ARE TWO QUESTIONS, asked by different people with different things in hand.
 * The coordinator has a carrier and wants the period; the client's contact — or the person on the
 * phone with them — has a guía and wants the truck. Collapsing them into one filtered table would
 * serve whichever half happened to match the default.
 *
 * The unit of the carrier answer is a PACKAGE, not a trip, because a trip-per-row table hides the
 * multi-client truck (R29): one unit, several clients, one address. Read-only throughout — planning
 * and state changes live in the despacho endpoints, and this view never writes.
 */

// ---- API contract types --------------------------------------------------------------------

interface TransportistaListItem {
  id: string;
  razonSocial: string;
  estado: string;
  unidadesActivas: number;
  convenioVigente: boolean;
}

interface Paquete {
  partidaId: string;
  despachoId: string;
  folio: string;
  fechaOperacion: string | null;
  estado: string;
  tipoUnidad: string;
  tipoUnidadLabel: string;
  placas: string | null;
  operadorNombre: string | null;
  destino: string | null;
  salidaAt: string | null;
  arriboReal: string | null;
  operacionId: string;
  mawb: string;
  guia: string | null;
  guiaEstado: string | null;
  cliente: string | null;
  piezas: number | null;
  cartonesPlaneados: number | null;
  cartonesCargados: number | null;
  ordenCarga: number | null;
}

interface PaquetesResponse {
  transportistaId: string;
  transportista: string;
  filtros: { desde: string | null; hasta: string | null; estado: string | null };
  totales: {
    despachos: number;
    paquetes: number;
    piezas: number;
    cartonesPlaneados: number;
    cartonesCargados: number;
  };
  paquetes: Paquete[];
}

interface OperacionListItem {
  id: string;
  mawb: string;
  clienteNombre: string | null;
  numeroVuelo: string | null;
  etapa: string;
  holdActivo: boolean;
}

interface PartidaDeCaso {
  id: string;
  guia: string | null;
  guiaEstado: string | null;
  cliente: string | null;
  piezas: number | null;
  cartonesPlaneados: number | null;
  cartonesCargados: number | null;
  ordenCarga: number | null;
}

interface DespachoDeCaso {
  id: string;
  folio: string;
  fechaOperacion: string | null;
  estado: string;
  tipoUnidad: string;
  tipoUnidadLabel: string;
  transportistaId: string | null;
  transportista: string | null;
  placas: string | null;
  operadorNombre: string | null;
  destino: string | null;
  citaAt: string | null;
  salidaAt: string | null;
  etaCalculado: string | null;
  arriboReal: string | null;
  desviacionArriboMin: number | null;
  partidasTotales: number;
  partidas: PartidaDeCaso[];
}

interface DespachosDeCasoResponse {
  operacionId: string;
  mawb: string;
  totales: { despachos: number; transportistas: number; partidas: number };
  despachos: DespachoDeCaso[];
}

// ---- Formatting ------------------------------------------------------------------------------

const SELECT_CLS =
  'rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-navy-500 focus:ring-2 focus:ring-navy-500/25';

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' });
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function fmtNumber(n: number | null): string {
  if (n === null || n === undefined) return '—';
  return n.toLocaleString('es-MX');
}

function humanize(v: string): string {
  return v.replace(/_/g, ' ');
}

/** The despacho FSM (R21) as a chip. `cancelado` reads red; the rest are positions on the line. */
const ESTADO_STYLE: Record<string, string> = {
  planeado: 'bg-slate-100 text-slate-600 ring-slate-500/20',
  solicitado: 'bg-slate-100 text-slate-600 ring-slate-500/20',
  confirmado: 'bg-blue-50 text-blue-700 ring-blue-600/20',
  en_patio: 'bg-blue-50 text-blue-700 ring-blue-600/20',
  en_aduana: 'bg-blue-50 text-blue-700 ring-blue-600/20',
  cargando: 'bg-amber-50 text-amber-700 ring-amber-600/20',
  cargado: 'bg-amber-50 text-amber-700 ring-amber-600/20',
  modulado: 'bg-amber-50 text-amber-700 ring-amber-600/20',
  en_transito: 'bg-blue-50 text-blue-700 ring-blue-600/20',
  entregado: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  cancelado: 'bg-red-50 text-red-700 ring-red-600/20',
  en_espera: 'bg-amber-50 text-amber-700 ring-amber-600/20',
};

function EstadoChip({ estado }: { estado: string }) {
  const cls = ESTADO_STYLE[estado] ?? 'bg-slate-100 text-slate-600 ring-slate-500/20';
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${cls}`}>
      {humanize(estado)}
    </span>
  );
}

function Totales({ items }: { items: { label: string; value: string }[] }) {
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
      {/* Fragment-wrapped like TorreControlView's KPI row: Card's prop type does not carry `key`. */}
      {items.map((k) => (
        <Fragment key={k.label}>
          <Card className="p-4">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{k.label}</div>
            <div className="mt-1.5 text-2xl font-bold tabular-nums tracking-tight text-slate-900">{k.value}</div>
          </Card>
        </Fragment>
      ))}
    </div>
  );
}

// ---- Tab 1: carrier → packages ---------------------------------------------------------------

function PorTransportista({ inicial }: { inicial?: string }) {
  const [transportistas, setTransportistas] = useState<TransportistaListItem[]>([]);
  // `inicial` is an INITIAL value, not a controlled one: the carrier catalog hands one over on the
  // way in ("ver trazabilidad"), and from that point the picker belongs to the reader.
  const [transportistaId, setTransportistaId] = useState(inicial ?? '');
  const [desde, setDesde] = useState('');
  const [hasta, setHasta] = useState('');
  const [estado, setEstado] = useState('');
  const [data, setData] = useState<PaquetesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    apiGet<TransportistaListItem[]>('/api/transportistas')
      .then((rows) => { if (active) setTransportistas(rows); })
      .catch((err) => { if (active) setError(err instanceof Error ? err.message : 'Error al cargar los transportistas.'); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!transportistaId) { setData(null); return; }
    let active = true;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (desde) params.set('desde', desde);
    if (hasta) params.set('hasta', hasta);
    if (estado) params.set('estado', estado);
    const qs = params.toString();
    apiGet<PaquetesResponse>(`/api/transportistas/${transportistaId}/paquetes${qs ? `?${qs}` : ''}`)
      .then((res) => { if (active) setData(res); })
      .catch((err) => { if (active) setError(err instanceof Error ? err.message : 'Error al cargar los paquetes.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [transportistaId, desde, hasta, estado]);

  return (
    <div className="space-y-6">
      <Card className="p-4 shadow-sm">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <select
            className={`${SELECT_CLS} w-full`}
            value={transportistaId}
            onChange={(e) => setTransportistaId(e.target.value)}
            aria-label="Transportista"
          >
            <option value="">Elige un transportista…</option>
            {transportistas.map((t) => (
              <option key={t.id} value={t.id}>{t.razonSocial}</option>
            ))}
          </select>
          <select
            className={`${SELECT_CLS} w-full`}
            value={estado}
            onChange={(e) => setEstado(e.target.value)}
            aria-label="Filtrar por estado del despacho"
          >
            <option value="">Estado: todos</option>
            {ESTADOS_DESPACHO.map((e) => <option key={e} value={e}>{humanize(e)}</option>)}
          </select>
          <input
            type="date"
            className={`${SELECT_CLS} w-full`}
            value={desde}
            onChange={(e) => setDesde(e.target.value)}
            aria-label="Desde"
          />
          <input
            type="date"
            className={`${SELECT_CLS} w-full`}
            value={hasta}
            onChange={(e) => setHasta(e.target.value)}
            aria-label="Hasta"
          />
        </div>
      </Card>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">{error}</div>
      )}

      {loading && <p className="px-1 text-sm text-slate-500">Cargando…</p>}

      {!transportistaId && !loading && (
        <EmptyState
          icon={Truck}
          title="Elige un transportista"
          message="Verás cada guía que llevó, en qué despacho viajó y de qué cliente era."
        />
      )}

      {data && !loading && (
        <>
          <Totales
            items={[
              { label: 'Despachos', value: fmtNumber(data.totales.despachos) },
              { label: 'Paquetes', value: fmtNumber(data.totales.paquetes) },
              { label: 'Piezas', value: fmtNumber(data.totales.piezas) },
              { label: 'Cartones planeados', value: fmtNumber(data.totales.cartonesPlaneados) },
              { label: 'Cartones cargados', value: fmtNumber(data.totales.cartonesCargados) },
            ]}
          />

          {data.paquetes.length === 0 ? (
            <EmptyState
              icon={Truck}
              title={`Sin paquetes de ${data.transportista}`}
              message="Esta línea no llevó carga en el periodo consultado."
            />
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
              <table className="w-full min-w-[1100px] text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-xs font-bold uppercase tracking-wide text-slate-400">
                    <th className="px-4 py-3">Despacho</th>
                    <th className="px-4 py-3">Fecha</th>
                    <th className="px-4 py-3">Unidad</th>
                    <th className="px-4 py-3">Guía máster</th>
                    <th className="px-4 py-3">Guía</th>
                    <th className="px-4 py-3">Cliente</th>
                    <th className="px-4 py-3 text-right">Piezas</th>
                    <th className="px-4 py-3 text-right">Cartones</th>
                    <th className="px-4 py-3">Destino</th>
                    <th className="px-4 py-3">Estado</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.paquetes.map((p) => (
                    <tr key={p.partidaId} className="text-sm">
                      <td className="px-4 py-3 font-mono text-slate-800">{p.folio}</td>
                      <td className="px-4 py-3 text-slate-700">{fmtDate(p.fechaOperacion)}</td>
                      <td className="px-4 py-3">
                        <div className="font-mono text-slate-800">{p.placas ?? '—'}</div>
                        <div className="text-xs text-slate-500">{p.tipoUnidadLabel ?? etiquetaTipoUnidad(p.tipoUnidad)}</div>
                      </td>
                      <td className="px-4 py-3 font-mono text-slate-800">{p.mawb}</td>
                      <td className="px-4 py-3">
                        <div className="font-mono text-slate-800">{p.guia ?? '—'}</div>
                        {p.guiaEstado && <div className="text-xs text-slate-500">{humanize(p.guiaEstado)}</div>}
                      </td>
                      <td className="px-4 py-3 text-slate-700">{p.cliente ?? '—'}</td>
                      <td className="px-4 py-3 text-right tabular-nums text-slate-700">{fmtNumber(p.piezas)}</td>
                      <td className="px-4 py-3 text-right tabular-nums text-slate-700">
                        {/* Planeado vs cargado: the gap is the number somebody has to explain. */}
                        {fmtNumber(p.cartonesCargados)} <span className="text-slate-400">/ {fmtNumber(p.cartonesPlaneados)}</span>
                      </td>
                      <td className="px-4 py-3 text-slate-700">{p.destino ?? '—'}</td>
                      <td className="px-4 py-3"><EstadoChip estado={p.estado} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---- Tab 2: package → carrier ----------------------------------------------------------------

function PorGuia() {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [casos, setCasos] = useState<OperacionListItem[]>([]);
  const [seleccionado, setSeleccionado] = useState<OperacionListItem | null>(null);
  const [data, setData] = useState<DespachosDeCasoResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 300);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    if (!debounced.trim()) { setCasos([]); return; }
    let active = true;
    setLoading(true);
    setError(null);
    apiGet<OperacionListItem[]>(`/api/operaciones?q=${encodeURIComponent(debounced.trim())}`)
      .then((rows) => { if (active) setCasos(rows); })
      .catch((err) => { if (active) setError(err instanceof Error ? err.message : 'Error al buscar la guía.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [debounced]);

  async function abrir(caso: OperacionListItem) {
    setSeleccionado(caso);
    setData(null);
    setError(null);
    setLoading(true);
    try {
      setData(await apiGet<DespachosDeCasoResponse>(`/api/operaciones/${caso.id}/despachos`));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al cargar los despachos del caso.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <Card className="p-4 shadow-sm">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar por guía máster o vuelo"
            aria-label="Buscar por guía máster o vuelo"
            className={`w-full rounded-lg border border-slate-300 bg-white py-2.5 pr-3.5 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-navy-500 focus:ring-2 focus:ring-navy-500/25 ${query ? 'px-10' : 'pl-10'}`}
          />
          {query && (
            <button
              type="button"
              onClick={() => { setQuery(''); setSeleccionado(null); setData(null); }}
              aria-label="Limpiar búsqueda"
              className="absolute right-3 top-1/2 -translate-y-1/2 rounded p-0.5 text-slate-400 transition hover:text-slate-700"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </Card>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">{error}</div>
      )}

      {loading && <p className="px-1 text-sm text-slate-500">Cargando…</p>}

      {!seleccionado && !loading && casos.length === 0 && (
        <EmptyState
          icon={PackageSearch}
          title="Busca una guía máster"
          message="Te dice en qué unidad salió, con qué transportista y qué más iba en ese viaje."
        />
      )}

      {casos.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-xs font-bold uppercase tracking-wide text-slate-400">
                <th className="px-4 py-3">Guía máster</th>
                <th className="px-4 py-3">Cliente</th>
                <th className="px-4 py-3">Vuelo</th>
                <th className="px-4 py-3">Etapa</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {casos.map((c) => (
                <tr
                  key={c.id}
                  onClick={() => abrir(c)}
                  className={`cursor-pointer transition-colors hover:bg-slate-50 ${seleccionado?.id === c.id ? 'bg-navy-50/40' : ''}`}
                >
                  <td className="px-4 py-3 font-mono text-slate-800">{c.mawb}</td>
                  <td className="px-4 py-3 text-slate-700">{c.clienteNombre ?? '—'}</td>
                  <td className="px-4 py-3 text-slate-700">{c.numeroVuelo ?? '—'}</td>
                  <td className="px-4 py-3 text-slate-700">{humanize(c.etapa)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && !loading && data.despachos.length === 0 && (
        <EmptyState
          icon={Truck}
          title={`${data.mawb} aún no sale en ninguna unidad`}
          message="Ninguna guía de este caso está cargada en un despacho todavía."
        />
      )}

      {data && !loading && data.despachos.length > 0 && (
        <div className="space-y-4">
          <p className="px-1 text-sm text-slate-600">
            <span className="font-mono font-semibold text-slate-800">{data.mawb}</span> salió en{' '}
            {data.totales.despachos} despacho(s) con {data.totales.transportistas} transportista(s).
          </p>
          {data.despachos.map((d) => (
            <Fragment key={d.id}>
            <Card className="p-4 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-semibold text-slate-900">{d.folio}</span>
                    <EstadoChip estado={d.estado} />
                  </div>
                  <div className="mt-1 text-sm text-slate-600">
                    {/* The answer to "¿con quién salió?" — carrier first, then the plate. */}
                    <span className="font-semibold text-slate-800">{d.transportista ?? 'Sin transportista asignado'}</span>
                    {' · '}
                    <span className="font-mono">{d.placas ?? 'sin placas'}</span>
                    {' · '}
                    {d.tipoUnidadLabel}
                  </div>
                </div>
                <div className="text-right text-xs text-slate-500">
                  <div>Fecha de operación: {fmtDate(d.fechaOperacion)}</div>
                  <div>Salida: {fmtDateTime(d.salidaAt)} · Arribo: {fmtDateTime(d.arriboReal)}</div>
                  <div>Destino: {d.destino ?? '—'}</div>
                </div>
              </div>

              <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200">
                <table className="w-full min-w-[640px] text-left text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-xs font-bold uppercase tracking-wide text-slate-400">
                      <th className="px-3 py-2">Orden</th>
                      <th className="px-3 py-2">Guía</th>
                      <th className="px-3 py-2">Cliente</th>
                      <th className="px-3 py-2 text-right">Piezas</th>
                      <th className="px-3 py-2 text-right">Cartones</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {d.partidas.map((p) => (
                      <tr key={p.id}>
                        <td className="px-3 py-2 tabular-nums text-slate-500">{fmtNumber(p.ordenCarga)}</td>
                        <td className="px-3 py-2 font-mono text-slate-800">{p.guia ?? '—'}</td>
                        <td className="px-3 py-2 text-slate-700">{p.cliente ?? '—'}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-slate-700">{fmtNumber(p.piezas)}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                          {fmtNumber(p.cartonesCargados)} <span className="text-slate-400">/ {fmtNumber(p.cartonesPlaneados)}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* R29: the rest of the truck. "Tus dos guías viajaron en una unidad que llevaba nueve"
                  is what explains a wait at the dock, so the number is stated rather than implied. */}
              {d.partidasTotales > d.partidas.length && (
                <p className="mt-2 text-xs text-slate-500">
                  Viaje compartido: la unidad llevó {d.partidasTotales} partidas en total, de las cuales{' '}
                  {d.partidas.length} son de este caso.
                </p>
              )}
            </Card>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- The view ---------------------------------------------------------------------------------

type Tab = 'transportista' | 'guia';

export default function TrazabilidadView({ transportistaId }: { transportistaId?: string } = {}) {
  const [tab, setTab] = useState<Tab>('transportista');

  const tabs: { id: Tab; label: string }[] = [
    { id: 'transportista', label: 'Por transportista' },
    { id: 'guia', label: 'Por guía' },
  ];

  return (
    <div className="space-y-6">
      <div className="flex gap-1 rounded-lg border border-slate-200 bg-white p-1 shadow-sm sm:w-fit">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`rounded-md px-4 py-2 text-sm font-semibold transition ${
              tab === t.id ? 'bg-navy-800 text-white' : 'text-slate-600 hover:bg-slate-50'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'transportista' ? <PorTransportista inicial={transportistaId} /> : <PorGuia />}
    </div>
  );
}
