/**
 * AutoridadView — read-only authority portal (RF-22 / RF-23).
 *
 * Three cards:
 *   1. Audit-log hash-chain integrity check (/api/audit/verify).
 *   2. Audit log with action filter (/api/audit).
 *   3. Consolidated XLS report by date range + optional client (/api/consolidated.xlsx).
 */

import { useEffect, useState } from 'react';
import {
  ShieldCheck,
  CheckCircle2,
  XCircle,
  ScrollText,
  FileSpreadsheet,
} from 'lucide-react';
import { apiGet, apiDownload } from '../api';
import { Card, Button, Field, Input, EmptyState } from './ui';

interface VerifyResult {
  ok: boolean;
  brokenAtId?: string;
  chainStartsAtId?: string;
}

interface AuditEntry {
  id: string;
  userId: string;
  action: string;
  entity: string;
  entityId: string;
  createdAt: string;
}

interface ClientOption {
  id: string;
  name: string;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : 'Error inesperado';
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('es-MX');
}

export default function AutoridadView() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="flex items-center gap-2 text-lg font-bold text-slate-800">
          <ShieldCheck className="h-5 w-5 text-navy-700" />
          Portal de Autoridad
        </h2>
        <p className="mt-1 text-sm text-slate-500">
          Integridad de la bitácora, registro de auditoría y reporte consolidado.
        </p>
      </div>

      <IntegrityCard />
      <AuditLogCard />
      <ConsolidatedCard />
    </div>
  );
}

/* ---------- Integridad de la bitácora ---------- */

function IntegrityCard() {
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function verify() {
    setLoading(true);
    setError(null);
    try {
      const r = await apiGet<VerifyResult>('/api/audit/verify');
      setResult(r);
    } catch (e) {
      setError(errMsg(e));
      setResult(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { verify(); }, []);

  return (
    <Card className="p-6 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-slate-700">
          <ShieldCheck className="h-4 w-4 text-navy-700" />
          Integridad de la bitácora
        </h3>
        <Button variant="secondary" onClick={verify} disabled={loading}>
          {loading ? 'Verificando...' : 'Verificar cadena'}
        </Button>
      </div>

      {error && <p className="text-sm font-medium text-red-700">{error}</p>}

      {!error && result && (
        result.ok ? (
          <div className="flex items-center gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-4">
            <CheckCircle2 className="h-7 w-7 shrink-0 text-emerald-600" />
            <div>
              <p className="text-base font-bold text-emerald-800">Cadena íntegra</p>
              {result.chainStartsAtId && (
                <p className="text-xs text-emerald-700">
                  Inicio de cadena: <span className="font-mono">{result.chainStartsAtId}</span>
                </p>
              )}
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-4">
            <XCircle className="h-7 w-7 shrink-0 text-red-600" />
            <div>
              <p className="text-base font-bold text-red-800">
                Ruptura detectada en el registro <span className="font-mono">{result.brokenAtId ?? '—'}</span>
              </p>
              <p className="text-xs text-red-700">La cadena de hash de la bitácora fue alterada.</p>
            </div>
          </div>
        )
      )}
    </Card>
  );
}

/* ---------- Bitácora de auditoría ---------- */

function AuditLogCard() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [actionFilter, setActionFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(action?: string) {
    setLoading(true);
    setError(null);
    try {
      const q = action && action.trim()
        ? `?action=${encodeURIComponent(action.trim())}&limit=100`
        : '?limit=100';
      const rows = await apiGet<AuditEntry[]>('/api/audit' + q);
      setEntries(rows);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  return (
    <Card className="p-6 shadow-sm">
      <h3 className="mb-4 flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-slate-700">
        <ScrollText className="h-4 w-4 text-navy-700" />
        Bitácora de auditoría
      </h3>

      <div className="mb-4 flex gap-2">
        <div className="flex-1">
          <Input
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
            placeholder="Filtrar por acción (p. ej. UPDATE)"
            onKeyDown={(e) => { if (e.key === 'Enter') load(actionFilter); }}
          />
        </div>
        <Button variant="secondary" onClick={() => load(actionFilter)} disabled={loading}>
          Filtrar
        </Button>
      </div>

      {error && <p className="mb-3 text-sm font-medium text-red-700">{error}</p>}

      {entries.length === 0 ? (
        <EmptyState
          icon={ScrollText}
          title="Sin registros"
          message="No hay entradas de bitácora para los filtros actuales."
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2 font-semibold">Fecha</th>
                <th className="px-3 py-2 font-semibold">Acción</th>
                <th className="px-3 py-2 font-semibold">Entidad</th>
                <th className="px-3 py-2 font-semibold">Entidad ID</th>
                <th className="px-3 py-2 font-semibold">Usuario</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {entries.map((e) => (
                <tr key={e.id}>
                  <td className="whitespace-nowrap px-3 py-2 text-slate-600">{formatDate(e.createdAt)}</td>
                  <td className="px-3 py-2">
                    <span className="inline-flex rounded bg-navy-50 px-2 py-0.5 font-mono text-xs font-semibold text-navy-700">
                      {e.action}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-slate-700">{e.entity}</td>
                  <td className="max-w-[12rem] truncate px-3 py-2 font-mono text-xs text-slate-500" title={e.entityId}>
                    {e.entityId}
                  </td>
                  <td className="max-w-[12rem] truncate px-3 py-2 font-mono text-xs text-slate-500" title={e.userId}>
                    {e.userId}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/* ---------- Reporte consolidado ---------- */

function ConsolidatedCard() {
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [clientId, setClientId] = useState('');
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<ClientOption[]>('/api/catalogs/clients')
      .then(setClients)
      .catch(() => {});
  }, []);

  function fillCurrentMonth() {
    const now = new Date();
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    setStart(iso(first));
    setEnd(iso(now));
  }

  async function download() {
    setError(null);
    if (!start || !end) {
      setError('Indique las fechas Desde y Hasta.');
      return;
    }
    setDownloading(true);
    try {
      let query = `?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;
      if (clientId) query += `&clientId=${encodeURIComponent(clientId)}`;
      await apiDownload('/api/consolidated.xlsx' + query, 'Consolidado.xlsx');
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setDownloading(false);
    }
  }

  return (
    <Card className="p-6 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-slate-700">
          <FileSpreadsheet className="h-4 w-4 text-navy-700" />
          Reporte consolidado
        </h3>
        <Button variant="ghost" onClick={fillCurrentMonth}>Mes actual</Button>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field label="Desde" htmlFor="cons-start">
          <Input id="cons-start" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
        </Field>
        <Field label="Hasta" htmlFor="cons-end">
          <Input id="cons-end" type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
        </Field>
        <Field label="Cliente" htmlFor="cons-client">
          <select
            id="cons-client"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 outline-none transition focus:border-navy-500 focus:ring-2 focus:ring-navy-500/25"
          >
            <option value="">Todos</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </Field>
      </div>

      {error && <p className="mt-3 text-sm font-medium text-red-700">{error}</p>}

      <Button className="mt-4" onClick={download} disabled={downloading}>
        <FileSpreadsheet className="h-4 w-4" />
        {downloading ? 'Generando...' : 'Descargar consolidado (XLS)'}
      </Button>
    </Card>
  );
}
