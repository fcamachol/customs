import { useState } from 'react';
import type { FormEvent } from 'react';
import { Search, Download, FileText } from 'lucide-react';
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
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar por MAWB o cliente"
            className="w-full rounded-lg border border-slate-300 bg-white py-2.5 pl-10 pr-3.5 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/30"
          />
        </div>
        <button
          type="submit"
          disabled={loading}
          className="rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Buscar
        </button>
      </form>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">{error}</div>
      )}

      {records.length > 0 && (
        <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          {records.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => handleSelect(r.id)}
                className="flex w-full items-center justify-between px-4 py-3 text-left text-sm transition-colors hover:bg-slate-50"
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

      {detail && (
        <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h3 className="flex items-center gap-2 text-sm font-bold text-slate-800">
            <FileText className="h-4 w-4 text-emerald-600" />
            {detail.mawbReference} — {detail.clientName}
          </h3>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => handleDownload(`/api/records/${detail.id}/risk.xlsx`, 'Analisis_de_Riesgo.xlsx')}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 transition hover:border-emerald-400 hover:bg-emerald-50 hover:text-emerald-700"
            >
              <Download className="h-3.5 w-3.5" />
              Análisis de Riesgo (XLS)
            </button>
            <button
              type="button"
              onClick={() => handleDownload(`/api/records/${detail.id}/report.xlsx`, 'Reporte_General.xlsx')}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 transition hover:border-emerald-400 hover:bg-emerald-50 hover:text-emerald-700"
            >
              <Download className="h-3.5 w-3.5" />
              Reporte General (XLS)
            </button>
            <button
              type="button"
              onClick={() => handleDownload(`/api/records/${detail.id}/layout.xlsx`, 'LayOut_sistema.xlsx')}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 transition hover:border-emerald-400 hover:bg-emerald-50 hover:text-emerald-700"
            >
              <Download className="h-3.5 w-3.5" />
              LayOut (XLS)
            </button>
            {hasPedimento && (
              <button
                type="button"
                onClick={() => handleDownload(detail.artifacts.pedimentoPdf as string, 'Pedimento.pdf')}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 transition hover:border-emerald-400 hover:bg-emerald-50 hover:text-emerald-700"
              >
                <Download className="h-3.5 w-3.5" />
                Pedimento (PDF)
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
