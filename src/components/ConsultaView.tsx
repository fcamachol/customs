import { Fragment, useEffect, useMemo, useState } from 'react';
import { Search, X } from 'lucide-react';
import { apiGet } from '../api';
import { Card, Input, SearchSelect } from './ui';
import type { SearchSelectOption } from './ui';
import { RiskPanel, PedimentoReportTabs } from './ReportTabs';

interface RecordSummary {
  id: string;
  mawbReference: string;
  clientName: string;
  createdAt: string;
}

// A subdivisión (pedimento) attached to the manifest, each with its own PDF.
interface PedimentoItem {
  id: string;
  numeroPedimento: string | null;
  subdivisionOrdinal: number | null;
  isLast: boolean;
  pedimentoPdf: string | null;
}

interface RecordDetail {
  id: string;
  mawbReference: string;
  clientName: string;
  pedimentoFileId: string | null;
  shipmentCount: number;
  pedimentos: PedimentoItem[];
  artifacts: {
    riskAnalysis: string;
    pedimentoPdf: string | null;
  };
}

interface Platform {
  id: string;
  commercialName: string | null;
  legalName: string | null;
}
interface Client {
  id: string;
  name: string;
  platforms: Platform[];
}

type DatePreset = 'any' | 'today' | '7d' | 'month' | 'custom';
type ResultFilter = '' | 'verde' | 'amarillo' | 'rojo' | 'gris';

const SELECT_CLS =
  'rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-navy-500 focus:ring-2 focus:ring-navy-500/25';

const DATE_OPTIONS: { value: DatePreset; label: string }[] = [
  { value: 'any', label: 'Fecha: cualquiera' },
  { value: 'today', label: 'Hoy' },
  { value: '7d', label: 'Últimos 7 días' },
  { value: 'month', label: 'Este mes' },
  { value: 'custom', label: 'Rango personalizado' },
];
const DATE_LABEL: Record<Exclude<DatePreset, 'any' | 'custom'>, string> = {
  today: 'Hoy',
  '7d': 'Últimos 7 días',
  month: 'Este mes',
};

const RESULT_OPTIONS: { value: ResultFilter; label: string }[] = [
  { value: '', label: 'Resultado: todos' },
  { value: 'verde', label: 'Aprobado' },
  { value: 'amarillo', label: 'No identificado' },
  { value: 'rojo', label: 'Validar en previo' },
  { value: 'gris', label: 'Sin evaluar' },
];
const RESULT_LABEL: Record<Exclude<ResultFilter, ''>, string> = {
  verde: 'Aprobado',
  amarillo: 'No identificado',
  rojo: 'Validar en previo',
  gris: 'Sin evaluar',
};

function fmtDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Resolve a date preset to a concrete {from, to} range (YYYY-MM-DD, local time).
function resolveDates(preset: DatePreset, customFrom: string, customTo: string): { from?: string; to?: string } {
  if (preset === 'any') return {};
  if (preset === 'custom') return { from: customFrom || undefined, to: customTo || undefined };
  const now = new Date();
  const to = fmtDate(now);
  if (preset === 'today') return { from: to, to };
  if (preset === '7d') {
    const f = new Date(now);
    f.setDate(f.getDate() - 6);
    return { from: fmtDate(f), to };
  }
  // month
  return { from: fmtDate(new Date(now.getFullYear(), now.getMonth(), 1)), to };
}

// Human-readable timestamp for the record list (e.g. "23 jun 2026, 21:11").
function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('es-MX', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export default function ConsultaView() {
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [clientName, setClientName] = useState('');
  const [platformId, setPlatformId] = useState('');
  const [datePreset, setDatePreset] = useState<DatePreset>('any');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [result, setResult] = useState<ResultFilter>('');

  const [clients, setClients] = useState<Client[]>([]);
  const [records, setRecords] = useState<RecordSummary[]>([]);
  const [detail, setDetail] = useState<RecordDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Filter-option data. Platforms come nested in the clients payload.
  useEffect(() => {
    let active = true;
    apiGet<Client[]>('/api/catalogs/clients')
      .then((c) => { if (active) setClients(c); })
      .catch(() => { /* filters degrade gracefully to empty option lists */ });
    return () => { active = false; };
  }, []);

  // Debounce the free-text search so typing doesn't refetch on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(t);
  }, [query]);

  const clientOptions: SearchSelectOption[] = useMemo(
    () => clients.map((c) => ({ value: c.name, label: c.name })),
    [clients],
  );

  // Platforms scoped to the selected client; otherwise all, labeled with client.
  const platformOptions: SearchSelectOption[] = useMemo(() => {
    const src = clientName ? clients.filter((c) => c.name === clientName) : clients;
    return src.flatMap((c) =>
      c.platforms.map((p) => ({
        value: p.id,
        label: (p.commercialName || p.legalName || 'Plataforma') + (clientName ? '' : ` — ${c.name}`),
      })),
    );
  }, [clients, clientName]);

  const platformLabel = useMemo(
    () => platformOptions.find((o) => o.value === platformId)?.label ?? '',
    [platformOptions, platformId],
  );

  // Single source of truth for fetching: any filter change re-queries the list.
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (debouncedQuery.trim()) params.set('q', debouncedQuery.trim());
    if (clientName) params.set('clientName', clientName);
    if (platformId) params.set('platformId', platformId);
    const { from, to } = resolveDates(datePreset, customFrom, customTo);
    if (from) params.set('dateFrom', from);
    if (to) params.set('dateTo', to);
    if (result) params.set('result', result);

    apiGet<RecordSummary[]>(`/api/records?${params.toString()}`)
      .then((r) => { if (active) setRecords(r); })
      .catch((err) => { if (active) setError(err instanceof Error ? err.message : 'Error al buscar registros.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [debouncedQuery, clientName, platformId, datePreset, customFrom, customTo, result]);

  async function handleSelect(id: string) {
    setError(null);
    try {
      const rec = await apiGet<RecordDetail>(`/api/records/${id}`);
      setDetail(rec);
      // Collapse the list to just this selection; the MAWB in the search bar is the active state.
      setQuery(rec.mawbReference);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al cargar el registro.');
    }
  }

  function handleClientChange(name: string) {
    setClientName(name);
    setPlatformId(''); // platform list depends on the client
  }

  // Active-filter chips (text query lives in the search box, not a chip).
  const chips: { key: string; label: string; onClear: () => void }[] = [];
  if (clientName) chips.push({ key: 'client', label: `Cliente: ${clientName}`, onClear: () => handleClientChange('') });
  if (platformId) chips.push({ key: 'platform', label: `Plataforma: ${platformLabel}`, onClear: () => setPlatformId('') });
  if (datePreset !== 'any') {
    const label =
      datePreset === 'custom'
        ? `Fecha: ${customFrom || '…'} – ${customTo || '…'}`
        : DATE_LABEL[datePreset];
    chips.push({ key: 'date', label, onClear: () => setDatePreset('any') });
  }
  if (result) chips.push({ key: 'result', label: RESULT_LABEL[result], onClear: () => setResult('') });

  function clearAll() {
    handleClientChange('');
    setDatePreset('any');
    setCustomFrom('');
    setCustomTo('');
    setResult('');
  }

  return (
    <div className="space-y-6">
      {/* Search + filters — aligned grid that fills the row (search spans 2 of 6) */}
      <Card className="p-4 shadow-sm">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-6">
          <div className="relative sm:col-span-2">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              type="text"
              value={query}
              onChange={(e) => { setQuery(e.target.value); if (detail) setDetail(null); }}
              placeholder="Buscar por MAWB o cliente"
              className={query ? 'px-10' : 'pl-10'}
            />
            {query && (
              <button
                type="button"
                onClick={() => { setQuery(''); setDetail(null); }}
                aria-label="Limpiar búsqueda"
                className="absolute right-3 top-1/2 -translate-y-1/2 rounded p-0.5 text-slate-400 transition hover:text-slate-700"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          <SearchSelect
            value={clientName}
            onChange={handleClientChange}
            options={clientOptions}
            placeholder="Cliente"
          />
          <SearchSelect
            value={platformId}
            onChange={setPlatformId}
            options={platformOptions}
            placeholder="Plataforma"
            disabled={platformOptions.length === 0}
          />
          <select
            className={`${SELECT_CLS} w-full`}
            value={datePreset}
            onChange={(e) => setDatePreset(e.target.value as DatePreset)}
            aria-label="Filtrar por fecha"
          >
            {DATE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <select
            className={`${SELECT_CLS} w-full`}
            value={result}
            onChange={(e) => setResult(e.target.value as ResultFilter)}
            aria-label="Filtrar por resultado de riesgo"
          >
            {RESULT_OPTIONS.map((o) => <option key={o.value || 'all'} value={o.value}>{o.label}</option>)}
          </select>
        </div>

        {datePreset === 'custom' && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              type="date"
              className={SELECT_CLS}
              value={customFrom}
              max={customTo || undefined}
              onChange={(e) => setCustomFrom(e.target.value)}
              aria-label="Desde"
            />
            <span className="text-sm text-slate-400">–</span>
            <input
              type="date"
              className={SELECT_CLS}
              value={customTo}
              min={customFrom || undefined}
              onChange={(e) => setCustomTo(e.target.value)}
              aria-label="Hasta"
            />
          </div>
        )}
      </Card>

      {/* Active filters + result count */}
      {(chips.length > 0 || records.length > 0 || loading) && (
        <div className="flex flex-wrap items-center gap-2">
          {chips.map((chip) => (
            <span
              key={chip.key}
              className="inline-flex items-center gap-1 rounded-full bg-navy-50 px-2.5 py-1 text-xs font-medium text-navy-700"
            >
              {chip.label}
              <button type="button" onClick={chip.onClear} aria-label={`Quitar ${chip.label}`} className="rounded p-0.5 hover:text-navy-900">
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          {chips.length > 0 && (
            <button type="button" onClick={clearAll} className="text-xs font-semibold text-slate-500 transition hover:text-slate-700">
              Limpiar
            </button>
          )}
          <span className="ml-auto text-xs text-slate-400">
            {loading ? 'Buscando…' : detail ? '' : `${records.length} registro(s)`}
          </span>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">{error}</div>
      )}

      {!loading && !error && records.length === 0 && !detail && (
        <p className="rounded-xl border border-slate-200 bg-white px-4 py-6 text-center text-sm text-slate-500">
          Sin resultados para estos filtros.
        </p>
      )}

      {records.length > 0 && !detail && (
        <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          {records.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => handleSelect(r.id)}
                className={`flex w-full items-center justify-between border-l-2 px-4 py-3 text-left text-sm transition-colors hover:bg-slate-50 ${
                  detail?.id === r.id ? 'border-navy-600 bg-navy-50/40' : 'border-transparent'
                }`}
              >
                <span>
                  <span className="font-semibold text-slate-800">{r.mawbReference}</span>
                  <span className="text-slate-500"> — {r.clientName}</span>
                </span>
                <span className="ml-2 shrink-0 text-xs text-slate-400">{formatDateTime(r.createdAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {detail && (
        <div className="space-y-6">
          {/* Consulta surfaces the GENERATED FILES per registro (Análisis de Riesgo / Pedimento /
              Reporte General / Layout), not the risk-analysis summary (client observation). The
              risk artifact is manifest-level and rides as the first tab of each pedimento panel. */}
          {(detail.pedimentos ?? []).length === 0 ? (
            <>
              {/* No pedimento yet — the risk artifact is still reachable on its own. */}
              <RiskPanel recordId={detail.id} />
              <Card className="p-5 shadow-sm">
                <p className="text-sm text-slate-500">Aún no hay pedimentos (subdivisiones) para este registro.</p>
              </Card>
            </>
          ) : (
            (detail.pedimentos ?? []).map((p: PedimentoItem) => (
              // Fragment carries the list key (the codebase types components with inline prop
              // objects, which don't surface React's `key` attribute on the component itself).
              <Fragment key={p.id}>
                <PedimentoReportTabs
                  pedimentoId={p.id}
                  title={pedimentoTitle(p)}
                  pedimentoPdf={p.pedimentoPdf}
                  riskRecordId={detail.id}
                />
              </Fragment>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// Heading for a per-pedimento report panel, e.g. "Pedimento 258… — subdivisión 2 (última)".
function pedimentoTitle(p: PedimentoItem): string {
  const numero = p.numeroPedimento ?? 'Sin número';
  if (p.subdivisionOrdinal == null) return `Pedimento ${numero}`;
  return `Pedimento ${numero} — subdivisión ${p.subdivisionOrdinal}${p.isLast ? ' (última)' : ''}`;
}
