import { useState } from 'react';
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

  async function handleSubmit(e: React.FormEvent) {
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
      <form onSubmit={handleSubmit} className="space-y-4 rounded-lg border border-gray-200 p-4">
        <div>
          <label htmlFor="mawb" className="block text-sm font-semibold">MAWB</label>
          <input
            id="mawb"
            type="text"
            value={mawbReference}
            onChange={(e) => setMawbReference(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label htmlFor="cliente" className="block text-sm font-semibold">Cliente</label>
          <input
            id="cliente"
            type="text"
            value={clientName}
            onChange={(e) => setClientName(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label htmlFor="manifest-file" className="block text-sm font-semibold">Manifiesto</label>
          <input
            id="manifest-file"
            type="file"
            accept=".xlsx,.xls,.csv"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="mt-1 w-full text-sm"
          />
        </div>
        <button
          type="submit"
          disabled={loading}
          className="rounded bg-emerald-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {loading ? 'Procesando…' : 'Realizar análisis de Riesgo'}
        </button>
      </form>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</div>
      )}

      {unmappedHeaders.length > 0 && (
        <div className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
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
