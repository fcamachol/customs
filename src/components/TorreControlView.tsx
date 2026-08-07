import { Fragment, useEffect, useRef, useState } from 'react';
import { RefreshCw, Radar, AlertTriangle } from 'lucide-react';
import { apiGet } from '../api';
import { Card, EmptyState } from './ui';

// ---- API contract types (Sistema de Operaciones — read-only board) ---------------------------

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

const ETAPAS_INACTIVAS = new Set(['entregado', 'cerrada', 'cancelada']);
const VUELO_ESTADOS_ALERTA = new Set(['demorado', 'cancelado']);

// ---- Formatting helpers -----------------------------------------------------------------

function fmtDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('es-MX', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function isToday(iso: string | null): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  return d.toDateString() === new Date().toDateString();
}

function fmtRoute(origen: string | null, destino: string | null): string {
  if (!origen && !destino) return '—';
  return `${origen ?? '—'} → ${destino ?? '—'}`;
}

function humanize(v: string): string {
  return v.replace(/_/g, ' ');
}

// ---- Vuelo estado chip -----------------------------------------------------------------

const VUELO_ESTADO_STYLE: Record<string, { cls: string; label: string }> = {
  en_ruta: { cls: 'bg-blue-50 text-blue-700 ring-blue-600/20', label: 'En ruta' },
  aterrizado: { cls: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20', label: 'Aterrizado' },
  demorado: { cls: 'bg-amber-50 text-amber-700 ring-amber-600/20', label: 'Demorado' },
  cancelado: { cls: 'bg-red-50 text-red-700 ring-red-600/20', label: 'Cancelado' },
  desviado: { cls: 'bg-red-50 text-red-700 ring-red-600/20', label: 'Desviado' },
  programado: { cls: 'bg-slate-100 text-slate-600 ring-slate-500/20', label: 'Programado' },
};

function VueloEstadoChip({ estado }: { estado: string | null }) {
  if (!estado || estado === 'desconocido') {
    return (
      <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-500 ring-1 ring-inset ring-slate-500/20">
        Sin verificar
      </span>
    );
  }
  const style = VUELO_ESTADO_STYLE[estado] ?? { cls: 'bg-slate-100 text-slate-600 ring-slate-500/20', label: humanize(estado) };
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${style.cls}`}>
      {style.label}
    </span>
  );
}

// Semáforo is deliberately shown in English (green/red) — this is the client-facing value, so the
// board must not relabel it into verde/rojo.
function SemaforoPill({ value }: { value: 'green' | 'red' | null }) {
  if (!value) return <span className="text-slate-300">—</span>;
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

function MiniPill({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600 ring-1 ring-inset ring-slate-500/20">
      <span className="text-[9px] font-bold uppercase tracking-wide text-slate-400">{label}</span>
      {humanize(value)}
    </span>
  );
}

// ---- Sort: holds first, then discrepancias desc, then createdAt desc -------------------------

function sortOperaciones(rows: OperacionListItem[]): OperacionListItem[] {
  return [...rows].sort((a, b) => {
    if (a.holdActivo !== b.holdActivo) return a.holdActivo ? -1 : 1;
    if (a.discrepanciasCount !== b.discrepanciasCount) return b.discrepanciasCount - a.discrepanciasCount;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}

const POLL_MS = 30_000;

export default function TorreControlView() {
  const [operaciones, setOperaciones] = useState<OperacionListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [nowTick, setNowTick] = useState(0);
  const inFlight = useRef(false);

  async function load() {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    try {
      const rows = await apiGet<OperacionListItem[]>('/api/operaciones');
      setOperaciones(rows);
      setError(null);
      setLastUpdated(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al cargar el estado de las operaciones.');
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

  // Tick every second purely to keep the "Actualizado hace Xs" indicator fresh.
  useEffect(() => {
    const id = setInterval(() => setNowTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const sorted = sortOperaciones(operaciones);
  const anyHold = operaciones.some((o) => o.holdActivo);

  const kpis = [
    { label: 'Operaciones activas', value: operaciones.filter((o) => !ETAPAS_INACTIVAS.has(o.etapa)).length, tone: 'text-slate-900' },
    { label: 'En vuelo', value: operaciones.filter((o) => o.vueloEstado === 'en_ruta').length, tone: 'text-blue-600' },
    { label: 'Arribadas hoy', value: operaciones.filter((o) => isToday(o.vueloArriboReal)).length, tone: 'text-emerald-600' },
    { label: 'Con banderas', value: operaciones.filter((o) => o.discrepanciasCount > 0).length, tone: 'text-amber-600' },
    { label: 'Demoradas / canceladas', value: operaciones.filter((o) => o.vueloEstado && VUELO_ESTADOS_ALERTA.has(o.vueloEstado)).length, tone: 'text-red-600' },
  ];

  const secsAgo = lastUpdated ? Math.max(0, Math.round((Date.now() - lastUpdated.getTime()) / 1000)) : null;
  // Reference nowTick so the indicator re-renders every second without affecting the computed value.
  void nowTick;

  return (
    <div className="space-y-6">
      {anyHold && (
        <div className="flex items-center gap-2 rounded-lg border border-red-300 bg-red-600 px-4 py-3 text-sm font-bold uppercase tracking-wide text-white shadow-sm">
          <AlertTriangle className="h-5 w-5 shrink-0" />
          Operación en hold — hay operaciones detenidas
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">{error}</div>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        {kpis.map((k) => (
          <Fragment key={k.label}>
            <Card className="p-4">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{k.label}</div>
              <div className={`mt-1.5 text-3xl font-bold tabular-nums tracking-tight ${k.tone}`}>{k.value}</div>
            </Card>
          </Fragment>
        ))}
      </div>

      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-slate-400">
          {secsAgo === null ? 'Sin datos aún' : `Actualizado hace ${secsAgo}s`}
        </span>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:border-navy-400 hover:text-navy-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /> Actualizar
        </button>
      </div>

      {!error && !loading && sorted.length === 0 && (
        <EmptyState icon={Radar} title="Sin operaciones activas" message="No hay operaciones en curso en este momento." />
      )}

      {sorted.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full min-w-[1100px] text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-xs font-bold uppercase tracking-wide text-slate-400">
                <th className="px-4 py-3">Guía máster</th>
                <th className="px-4 py-3">Ruta</th>
                <th className="px-4 py-3">Vuelo</th>
                <th className="px-4 py-3">ETA</th>
                <th className="px-4 py-3">Estado</th>
                <th className="px-4 py-3">Semáforo</th>
                <th className="px-4 py-3">Banderas</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {sorted.map((op) => {
                const etaValue = op.vueloEtaEstimado ?? op.etaPais;
                const etaSource = op.vueloEtaEstimado ? 'feed' : 'declarado';
                return (
                  <tr
                    key={op.id}
                    className={`border-l-4 text-sm ${op.holdActivo ? 'border-red-500 bg-red-50/40' : 'border-transparent'} ${
                      !op.holdActivo && op.discrepanciasCount > 0 ? 'bg-amber-50/40' : ''
                    }`}
                  >
                    <td className="px-4 py-3">
                      <div className="font-mono text-slate-800">
                        {op.mawb}
                        {op.holdActivo && (
                          <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-red-700">Hold</span>
                        )}
                      </div>
                      <div className="text-xs text-slate-500">{op.clienteNombre ?? '—'}</div>
                    </td>
                    <td className="px-4 py-3 text-slate-700">{fmtRoute(op.origenIata, op.destinoIata)}</td>
                    <td className="px-4 py-3">
                      <div className="text-slate-700">{op.numeroVuelo ?? '—'}</div>
                      <div className="mt-1"><VueloEstadoChip estado={op.vueloEstado} /></div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-slate-700">{fmtDateTime(etaValue)}</div>
                      {etaValue && (
                        <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{etaSource}</div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        <MiniPill label="Etapa" value={op.etapa} />
                        <MiniPill label="Doc" value={op.estadoDocumental} />
                        <MiniPill label="Plan" value={op.estadoPlaneacion} />
                      </div>
                    </td>
                    <td className="px-4 py-3"><SemaforoPill value={op.semaforo} /></td>
                    <td className="px-4 py-3">
                      {op.discrepanciasCount > 0 ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-xs font-bold text-red-700 ring-1 ring-inset ring-red-600/20">
                          <AlertTriangle className="h-3 w-3" /> {op.discrepanciasCount}
                        </span>
                      ) : (
                        <span className="text-slate-300">0</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
