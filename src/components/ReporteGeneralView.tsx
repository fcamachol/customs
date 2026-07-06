import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Search, Download } from 'lucide-react';
import { apiGet, apiPost, apiDownload } from '../api';
import { Card, Field, Input, Button, SearchSelect } from './ui';
import type { SearchSelectOption } from './ui';
import type { Client } from './AddClientModal';

interface RecordSummary {
  id: string;
  mawbReference: string;
  clientName: string;
  createdAt: string;
}

// A subdivisión (pedimento) of the selected record; each has its own Reporte General.
interface PedimentoItem {
  id: string;
  numeroPedimento: string | null;
}
interface RecordDetail {
  id: string;
  clientId: string | null;
  platformId: string | null;
  pedimentos: PedimentoItem[];
}

export default function ReporteGeneralView() {
  // Record search state
  const [query, setQuery] = useState('');
  const [records, setRecords] = useState<RecordSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedLabel, setSelectedLabel] = useState<string>('');
  const [detail, setDetail] = useState<RecordDetail | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  // Cliente/plataforma association. The remitente + plataforma report blocks come from the
  // clients catalog server-side; this page only needs to know WHICH client/platform.
  const [clients, setClients] = useState<Client[]>([]);
  const [selectedClientId, setSelectedClientId] = useState('');
  const [selectedPlatformId, setSelectedPlatformId] = useState('');
  // False when the manifest arrived fully associated → read-only summary until "Cambiar".
  const [editingAssoc, setEditingAssoc] = useState(true);
  // Tracks the most recently requested record so a slow /api/records/:id response can't
  // clobber state after the user has since selected a different record.
  const selectReqId = useRef<string | null>(null);

  useEffect(() => {
    apiGet<Client[]>('/api/catalogs/clients').then(setClients).catch(() => setClients([]));
  }, []);

  const clientOptions: SearchSelectOption[] = useMemo(
    () => clients.map((c) => ({ value: c.id, label: c.name })),
    [clients],
  );

  const platformOptions: SearchSelectOption[] = useMemo(() => {
    const c = clients.find((c) => c.id === selectedClientId);
    return (c?.platforms ?? []).map((p) => ({
      value: p.id!,
      label: p.commercialName || p.legalName || 'Plataforma',
    }));
  }, [clients, selectedClientId]);

  const clientLabel = clients.find((c) => c.id === selectedClientId)?.name ?? '';
  const platformLabel = platformOptions.find((o) => o.value === selectedPlatformId)?.label ?? '';

  function handleClientChange(id: string) {
    setSelectedClientId(id);
    setSelectedPlatformId(''); // platform list depends on the client
  }

  async function handleSearch(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSelectedId(null);
    setSelectedLabel('');
    setDetail(null);
    setSearchLoading(true);
    try {
      const results = await apiGet<RecordSummary[]>(`/api/records?q=${encodeURIComponent(query)}`);
      setRecords(results);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al buscar registros.');
    } finally {
      setSearchLoading(false);
    }
  }

  async function handleSelect(r: RecordSummary) {
    selectReqId.current = r.id;
    setSelectedId(r.id);
    setSelectedLabel(`${r.mawbReference} — ${r.clientName}`);
    setError(null);
    setDetail(null);
    try {
      const d = await apiGet<RecordDetail>(`/api/records/${r.id}`);
      if (selectReqId.current !== r.id) return; // a different record was selected meanwhile
      setDetail(d);
      // Prefill from the manifest's existing association; fall back to a best-effort
      // catalog match on the manifest's client name.
      const matchedClient = d.clientId
        ?? clients.find((c) => c.name.trim().toLowerCase() === (r.clientName ?? '').trim().toLowerCase())?.id
        ?? '';
      setSelectedClientId(matchedClient);
      setSelectedPlatformId(d.platformId ?? '');
      setEditingAssoc(!(d.clientId && d.platformId));
    } catch (err) {
      if (selectReqId.current !== r.id) return; // a different record was selected meanwhile
      setError(err instanceof Error ? err.message : 'Error al cargar el registro.');
    }
  }

  async function handleGenerateReport() {
    if (!selectedId || !detail) return;
    if (!selectedClientId) { setError('Selecciona un cliente.'); return; }
    if (!selectedPlatformId) { setError('Selecciona una plataforma.'); return; }
    setError(null);
    setDownloading(true);
    try {
      // Only re-bind when the user actually changed the association.
      if (selectedClientId !== detail.clientId || selectedPlatformId !== detail.platformId) {
        await apiPost(`/api/manifests/${selectedId}/client`, {
          clientId: selectedClientId,
          platformId: selectedPlatformId,
        });
      }
      // Reporte General is per-pedimento (each subdivisión is its own customs submission), so
      // download the report.xlsx for each of the record's pedimentos.
      const peds = detail.pedimentos ?? [];
      if (peds.length === 0) {
        setError('Este registro aún no tiene pedimentos (subdivisiones). Genere el pedimento antes de descargar el reporte.');
        return;
      }
      for (const p of peds) {
        const suffix = p.numeroPedimento ? `_${p.numeroPedimento}` : '';
        await apiDownload(`/api/pedimentos/${p.id}/report.xlsx`, `Reporte_General${suffix}.xlsx`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al generar el reporte.');
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Record search */}
      <form onSubmit={handleSearch} className="flex gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar registro por MAWB o cliente"
            className="pl-10"
          />
        </div>
        <Button type="submit" disabled={searchLoading}>
          Buscar
        </Button>
      </form>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
          {error}
        </div>
      )}

      {records.length > 0 && (
        <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          {records.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => handleSelect(r)}
                className={`flex w-full items-center justify-between px-4 py-3 text-left text-sm transition-colors hover:bg-slate-50 ${
                  selectedId === r.id ? 'bg-navy-50 font-semibold text-navy-800' : ''
                }`}
              >
                <span>
                  <span className="font-semibold text-slate-800">{r.mawbReference}</span>
                  <span className="text-slate-500"> — {r.clientName}</span>
                </span>
                <span className="ml-2 shrink-0 text-xs text-slate-400">{r.createdAt}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {selectedId && (
        <div className="rounded-lg border border-navy-200 bg-navy-50/40 px-4 py-2.5 text-sm font-medium text-navy-800">
          Registro seleccionado: <span className="font-semibold">{selectedLabel}</span>
        </div>
      )}

      {/* Cliente y plataforma — read-only summary when the manifest is already associated */}
      {selectedId && detail && (
        <Card className="p-6 shadow-sm space-y-5">
          <h2 className="text-sm font-bold text-slate-800">Cliente y plataforma</h2>
          {!editingAssoc ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm font-semibold text-slate-700">
                Cliente: {clientLabel || '—'} · Plataforma: {platformLabel || '—'}
              </p>
              <Button type="button" variant="secondary" onClick={() => setEditingAssoc(true)}>
                Cambiar
              </Button>
            </div>
          ) : (
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="Cliente" htmlFor="rg-cliente">
                <SearchSelect
                  id="rg-cliente"
                  value={selectedClientId}
                  onChange={handleClientChange}
                  options={clientOptions}
                  placeholder="Selecciona un cliente…"
                />
              </Field>
              <Field label="Plataforma" htmlFor="rg-plataforma">
                <SearchSelect
                  id="rg-plataforma"
                  value={selectedPlatformId}
                  onChange={setSelectedPlatformId}
                  options={platformOptions}
                  placeholder={selectedClientId ? 'Selecciona una plataforma…' : 'Elige un cliente primero'}
                  disabled={!selectedClientId}
                />
              </Field>
            </div>
          )}
        </Card>
      )}

      {/* Generate report action */}
      <div className="flex items-center gap-3">
        <Button
          type="button"
          disabled={!selectedId || !detail || downloading}
          onClick={handleGenerateReport}
        >
          <Download className="h-4 w-4" />
          {downloading ? 'Generando…' : 'Generar Reporte'}
        </Button>
        {!selectedId && (
          <p className="text-xs text-slate-500">Selecciona un registro para habilitar la descarga.</p>
        )}
      </div>
    </div>
  );
}
