import { useState } from 'react';
import type { FormEvent } from 'react';
import { Upload, Loader2 } from 'lucide-react';
import * as XLSX from 'xlsx';
import { apiPost } from '../api';
import { RiskSummary, RiskResultTable, type RiskRow, type RiskSummaryData } from './RiskResultTable';

interface ManifestResponse {
  manifestId: string;
  shipmentCount: number;
  unmappedHeaders: string[];
}

interface RiskResponse {
  rows: RiskRow[];
  summary: RiskSummaryData;
}

export default function RegistroView() {
  const [mawbReference, setMawbReference] = useState('');
  const [clientName, setClientName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unmappedHeaders, setUnmappedHeaders] = useState<string[]>([]);
  const [result, setResult] = useState<RiskResponse | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setResult(null);
    setUnmappedHeaders([]);

    if (!file) {
      setError('Selecciona un archivo de manifiesto.');
      return;
    }

    setLoading(true);
    try {
      const data = await file.arrayBuffer();
      const workbook = XLSX.read(data, { type: 'array' });
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json<Record<string, string>>(firstSheet, { defval: '' });

      const manifest = await apiPost<ManifestResponse>('/api/manifests', {
        mawbReference,
        clientName,
        rows,
      });
      setUnmappedHeaders(manifest.unmappedHeaders ?? []);

      const risk = await apiPost<RiskResponse>(`/api/manifests/${manifest.manifestId}/risk`, {});
      setResult(risk);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ocurrió un error al procesar el manifiesto.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <form onSubmit={handleSubmit} className="space-y-5 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="grid gap-5 sm:grid-cols-2">
          <div>
            <label htmlFor="mawb" className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-slate-600">
              MAWB
            </label>
            <input
              id="mawb"
              type="text"
              value={mawbReference}
              onChange={(e) => setMawbReference(e.target.value)}
              placeholder="Ej. 045-12345678"
              className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/30"
            />
          </div>
          <div>
            <label htmlFor="cliente" className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-slate-600">
              Cliente
            </label>
            <input
              id="cliente"
              type="text"
              value={clientName}
              onChange={(e) => setClientName(e.target.value)}
              placeholder="Nombre del cliente"
              className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/30"
            />
          </div>
        </div>

        <div>
          <label htmlFor="manifest-file" className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-slate-600">
            Manifiesto
          </label>
          <label
            htmlFor="manifest-file"
            className="flex cursor-pointer items-center gap-3 rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-3.5 text-sm transition hover:border-emerald-400 hover:bg-emerald-50/40"
          >
            <Upload className="h-4 w-4 shrink-0 text-emerald-600" />
            <span className={file ? 'font-medium text-slate-800' : 'text-slate-500'}>
              {file ? file.name : 'Selecciona un archivo .xlsx, .xls o .csv'}
            </span>
          </label>
          <input
            id="manifest-file"
            type="file"
            accept=".xlsx,.xls,.csv"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="sr-only"
          />
        </div>

        <button
          type="submit"
          disabled={loading}
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading && <Loader2 className="h-4 w-4 animate-spin" />}
          {loading ? 'Procesando…' : 'Realizar análisis de Riesgo'}
        </button>
      </form>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">{error}</div>
      )}

      {unmappedHeaders.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs font-medium text-amber-800">
          Columnas no mapeadas: {unmappedHeaders.join(', ')}
        </div>
      )}

      {result && (
        <div className="space-y-4">
          <RiskSummary summary={result.summary} />
          <RiskResultTable rows={result.rows} />
        </div>
      )}
    </div>
  );
}
