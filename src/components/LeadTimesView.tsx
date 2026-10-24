import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Timer, Download } from 'lucide-react';
import { apiGet, apiDownload } from '../api';
import { Card, Field, Input, Button, SearchSelect, EmptyState } from './ui';
import type { SearchSelectOption } from './ui';
import type { Client } from './AddClientModal';
import {
  METRICAS_LEAD_TIME,
  type MetricaLeadTime,
  type ResumenMetrica,
} from '../../shared/operaciones/leadTimes';

// The screen for GET /api/reportes/lead-times (PRD-02 §14 point 7). The arithmetic is NOT here:
// it lives in shared/operaciones/leadTimes.ts, version-stamped and unit-tested, and the server
// aggregates with the same function the export uses. This file only decides how to SHOW it — and
// the three rules it has to honour are the same three the module refuses to break:
//
//   1. `null` IS NOT ZERO. A shipment whose POD is not signed has an UNKNOWN lead time. Every
//      missing value renders as "—", never as 0 and never as a blank that could be read as 0.
//   2. `muestras` TRAVELS WITH THE AVERAGE. "Average warehouse time 214 min" over three of ninety
//      guías is a sample, not a KPI. The denominator is printed under every tile; hiding it would
//      make this the spreadsheet it replaces.
//   3. NEGATIVES ARE SHOWN, NOT CLAMPED. A negative interval means two timestamps disagree — a
//      deferred capture, a device clock, a fact recorded out of order. It is flagged in amber so
//      somebody explains it, because clamping it to zero erases the only evidence there is a
//      problem.
//
// `rulesetVersion` is printed for the same reason the module stamps it: a figure somebody screenshots
// today has to be re-derivable months from now.

const TILES: MetricaLeadTime[] = [
  'almacenMin',
  'despachoMin',
  'transitoMin',
  'ultimaMillaMin',
  'leadTimeMin',
];

interface FilaLeadTime extends Record<MetricaLeadTime, number | null> {
  operacionId: string;
  mawb: string | null;
  guia: string | null;
  cliente: string | null;
  etapa: string | null;
  despachoFolio: string | null;
  podEstado: string | null;
  rulesetVersion: string;
}

interface RespuestaLeadTimes {
  rulesetVersion: string;
  resumen: Record<MetricaLeadTime, ResumenMetrica>;
  filas: FilaLeadTime[];
  total: number;
}

const ETIQUETAS = new Map<MetricaLeadTime, string>(
  METRICAS_LEAD_TIME.map((m) => [m.id, m.label.replace(' (min)', '')]),
);

/**
 * Minutes as "2h 14m" — operational figures get read out loud in meetings, and 134 does not.
 * The raw minute count stays in the `title` attribute, so the number in the XLSX (which is in
 * minutes, per the module's own labels) can always be reconciled with what the screen shows.
 *
 * `null` is "—" and NOT "0m": see rule 1 above. The sign is kept for the same reason the module
 * keeps it.
 */
function formatearMinutos(v: number | null): string {
  if (v == null) return '—';
  const negativo = v < 0;
  const abs = Math.abs(v);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  const cuerpo = h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
  return negativo ? `−${cuerpo}` : cuerpo;
}

function Celda({ valor }: { valor: number | null }) {
  const negativo = valor != null && valor < 0;
  return (
    <td
      className={`py-2 pr-3 text-right tabular-nums ${
        valor == null ? 'text-slate-300' : negativo ? 'font-semibold text-amber-600' : 'text-slate-700'
      }`}
      title={valor == null ? 'Sin dato: uno de los dos extremos no está registrado' : `${valor} min`}
    >
      {formatearMinutos(valor)}
    </td>
  );
}

export default function LeadTimesView() {
  const [desde, setDesde] = useState('');
  const [hasta, setHasta] = useState('');
  const [clientId, setClientId] = useState('');
  const [clients, setClients] = useState<Client[]>([]);
  const [data, setData] = useState<RespuestaLeadTimes | null>(null);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<Client[]>('/api/catalogs/clients').then(setClients).catch(() => setClients([]));
  }, []);

  const clientOptions: SearchSelectOption[] = useMemo(
    () => clients.map((c) => ({ value: c.id, label: c.name })),
    [clients],
  );

  // The filters are exactly `reporteOperativoQuery`: desde, hasta, clientId. Empty strings are
  // dropped rather than sent, because the server validates `desde`/`hasta` as dates and an empty
  // one is not "no filter", it is a 400.
  const queryString = useMemo(() => {
    const p = new URLSearchParams();
    if (desde) p.set('desde', desde);
    if (hasta) p.set('hasta', hasta);
    if (clientId) p.set('clientId', clientId);
    const s = p.toString();
    return s ? `?${s}` : '';
  }, [desde, hasta, clientId]);

  const cargar = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await apiGet<RespuestaLeadTimes>(`/api/reportes/lead-times${queryString}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudieron cargar los lead times.');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [queryString]);

  // Loads once on mount with no filters; afterwards only when the user submits, so typing a date
  // does not fire a query per keystroke.
  useEffect(() => {
    void cargar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    void cargar();
  }

  async function handleDownload() {
    setDownloading(true);
    setError(null);
    try {
      await apiDownload(`/api/reportes/lead-times.xlsx${queryString}`, 'Lead_times.xlsx');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo descargar el archivo.');
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="space-y-6">
      <Card className="p-5">
        <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-4">
          <Field label="Desde" htmlFor="lt-desde">
            <Input id="lt-desde" type="date" value={desde} onChange={(e) => setDesde(e.target.value)} />
          </Field>
          <Field label="Hasta" htmlFor="lt-hasta">
            <Input id="lt-hasta" type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} />
          </Field>
          <div className="min-w-[220px] flex-1">
            <Field label="Cliente" htmlFor="lt-cliente">
              <SearchSelect
                id="lt-cliente"
                value={clientId}
                onChange={setClientId}
                options={clientOptions}
                placeholder="Todos los clientes"
              />
            </Field>
          </div>
          <Button type="submit" disabled={loading}>
            {loading ? 'Calculando…' : 'Aplicar'}
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={handleDownload}
            disabled={downloading || !data || data.total === 0}
          >
            <Download className="h-4 w-4" />
            {downloading ? 'Generando…' : 'Descargar XLSX'}
          </Button>
        </form>
        <p className="mt-3 text-xs text-slate-500">
          La fecha filtra por el arribo real del vuelo; si no hay arribo registrado, por la fecha de
          alta del caso.
        </p>
      </Card>

      {error && (
        <Card className="border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</Card>
      )}

      {loading && !data && (
        <Card className="p-10 text-center text-sm text-slate-400">Calculando…</Card>
      )}

      {data && data.total === 0 && (
        <EmptyState
          icon={Timer}
          title="No hay operaciones en este rango"
          message="Ajusta las fechas o quita el filtro de cliente para ver lead times."
        />
      )}

      {data && data.total > 0 && (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
            {TILES.map((id) => {
              const r = data.resumen[id];
              return (
                <Fragment key={id}>
                <Card className="p-4">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                    {ETIQUETAS.get(id)}
                  </div>
                  <div
                    className={`mt-1.5 text-3xl font-bold tabular-nums tracking-tight ${
                      r.promedioMin == null ? 'text-slate-300' : 'text-slate-900'
                    }`}
                    title={r.promedioMin == null ? 'Sin muestras' : `${r.promedioMin} min`}
                  >
                    {formatearMinutos(r.promedioMin)}
                  </div>
                  {/* The denominator, printed. Rule 2: an average without its sample size is how a
                      dashboard starts lying to the people who run the operation. */}
                  <div className="mt-1 text-[11px] text-slate-500">
                    promedio de{' '}
                    <span className="font-semibold tabular-nums text-slate-600">{r.muestras}</span>
                    {' '}de {data.total} guía{data.total === 1 ? '' : 's'}
                  </div>
                </Card>
                </Fragment>
              );
            })}
          </div>

          <Card className="p-5">
            <h3 className="mb-4 text-sm font-bold text-slate-800">Resumen por métrica</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-[10px] font-bold uppercase tracking-wide text-slate-400">
                    <th className="py-2 pr-3 text-left">Métrica</th>
                    <th className="py-2 pr-3 text-right">Muestras</th>
                    <th className="py-2 pr-3 text-right">Promedio</th>
                    <th className="py-2 pr-3 text-right">Mediana</th>
                    <th className="py-2 pr-3 text-right">Mínimo</th>
                    <th className="py-2 text-right">Máximo</th>
                  </tr>
                </thead>
                <tbody>
                  {METRICAS_LEAD_TIME.map((m) => {
                    const r = data.resumen[m.id];
                    return (
                      <tr key={m.id} className="border-b border-slate-100 last:border-0">
                        <td className="py-2 pr-3 text-slate-700">{ETIQUETAS.get(m.id)}</td>
                        <td
                          className={`py-2 pr-3 text-right tabular-nums ${
                            r.muestras === 0 ? 'text-slate-300' : 'text-slate-500'
                          }`}
                        >
                          {r.muestras}
                        </td>
                        <Celda valor={r.promedioMin} />
                        <Celda valor={r.medianaMin} />
                        <Celda valor={r.minimoMin} />
                        <Celda valor={r.maximoMin} />
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          <Card className="p-5">
            <div className="mb-4 flex items-baseline justify-between gap-4">
              <h3 className="text-sm font-bold text-slate-800">
                Detalle por guía{' '}
                <span className="font-normal tabular-nums text-slate-400">({data.total})</span>
              </h3>
              <span className="text-[11px] text-slate-400">
                Ruleset <span className="font-mono">{data.rulesetVersion}</span>
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-slate-200 text-[10px] font-bold uppercase tracking-wide text-slate-400">
                    <th className="py-2 pr-3 text-left">Guía</th>
                    <th className="py-2 pr-3 text-left">MAWB</th>
                    <th className="py-2 pr-3 text-left">Cliente</th>
                    <th className="py-2 pr-3 text-left">Etapa</th>
                    {TILES.map((id) => (
                      <th key={id} className="py-2 pr-3 text-right">
                        {ETIQUETAS.get(id)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.filas.map((f) => (
                    <tr key={f.operacionId} className="border-b border-slate-100 last:border-0">
                      <td className="py-2 pr-3 font-medium text-slate-800">{f.guia ?? '—'}</td>
                      <td className="py-2 pr-3 text-slate-500">{f.mawb ?? '—'}</td>
                      <td className="py-2 pr-3 text-slate-500">{f.cliente ?? '—'}</td>
                      <td className="py-2 pr-3 text-slate-500">{f.etapa ?? '—'}</td>
                      {TILES.map((id) => (
                        <Fragment key={id}>
                          <Celda valor={f[id]} />
                        </Fragment>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
              «—» significa que uno de los dos extremos del intervalo no está registrado: el lead time
              es desconocido, no cero. Un valor en ámbar es negativo — las dos marcas de tiempo se
              contradicen y alguien tiene que explicarlo.
            </p>
          </Card>
        </>
      )}
    </div>
  );
}
