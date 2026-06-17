import { useState } from 'react';
import type { FormEvent } from 'react';
import { apiGet, apiDownload } from '../api';

interface RecordSummary {
  id: string;
  mawbReference: string;
  clientName: string;
  createdAt: string;
}

interface RecordDetail {
  id: string;
  mawbReference: string;
  clientName: string;
  pedimentoFileId: string | null;
  shipmentCount: number;
  artifacts: {
    riskAnalysis: string;
    pedimentoPdf: string | null;
    report: string;
  };
}

export default function ConsultaView() {
  const [query, setQuery] = useState('');
  const [records, setRecords] = useState<RecordSummary[]>([]);
  const [detail, setDetail] = useState<RecordDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSearch(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setDetail(null);
    setLoading(true);
    try {
      const results = await apiGet<RecordSummary[]>(`/api/records?q=${encodeURIComponent(query)}`);
      setRecords(results);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al buscar registros.');
    } finally {
      setLoading(false);
    }
  }

  async function handleSelect(id: string) {
    setError(null);
    try {
      const rec = await apiGet<RecordDetail>(`/api/records/${id}`);
      setDetail(rec);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al cargar el registro.');
    }
  }

  async function handleDownload(path: string, filename: string) {
    setError(null);
    try {
      await apiDownload(path, filename);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al descargar el archivo.');
    }
  }

  const hasPedimento = detail && detail.pedimentoFileId && detail.artifacts.pedimentoPdf;

  return (
    <div className="space-y-6">
      <form onSubmit={handleSearch} className="flex gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar por MAWB o cliente"
          className="flex-1 rounded border border-gray-300 px-3 py-2 text-sm"
        />
        <button
          type="submit"
          disabled={loading}
          className="rounded bg-emerald-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          Buscar
        </button>
      </form>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</div>
      )}

      <ul className="divide-y divide-gray-200 rounded border border-gray-200">
        {records.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              onClick={() => handleSelect(r.id)}
              className="w-full px-3 py-2 text-left text-sm hover:bg-gray-50"
            >
              <span className="font-semibold">{r.mawbReference}</span> — {r.clientName}
              <span className="ml-2 text-xs text-gray-500">{r.createdAt}</span>
            </button>
          </li>
        ))}
      </ul>

      {detail && (
        <div className="space-y-3 rounded border border-gray-200 p-4">
          <h3 className="text-sm font-semibold">
            {detail.mawbReference} — {detail.clientName}
          </h3>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => handleDownload(`/api/records/${detail.id}/risk.xlsx`, 'Analisis_de_Riesgo.xlsx')}
              className="rounded border border-gray-300 px-3 py-2 text-sm font-medium hover:bg-gray-50"
            >
              Análisis de Riesgo (XLS)
            </button>
            <button
              type="button"
              onClick={() => handleDownload(`/api/records/${detail.id}/report.xlsx`, 'Reporte_General.xlsx')}
              className="rounded border border-gray-300 px-3 py-2 text-sm font-medium hover:bg-gray-50"
            >
              Reporte General (XLS)
            </button>
            <button
              type="button"
              onClick={() => handleDownload(`/api/records/${detail.id}/layout.xlsx`, 'LayOut_sistema.xlsx')}
              className="rounded border border-gray-300 px-3 py-2 text-sm font-medium hover:bg-gray-50"
            >
              LayOut (XLS)
            </button>
            {hasPedimento && (
              <button
                type="button"
                onClick={() => handleDownload(detail.artifacts.pedimentoPdf as string, 'Pedimento.pdf')}
                className="rounded border border-gray-300 px-3 py-2 text-sm font-medium hover:bg-gray-50"
              >
                Pedimento (PDF)
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
