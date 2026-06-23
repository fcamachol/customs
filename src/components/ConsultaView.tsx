import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Search, FileText } from 'lucide-react';
import { apiGet, apiDownload } from '../api';
import { Card, Input, Button, FileCard } from './ui';
import { ReportTabs } from './ReportTabs';

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

  // Load all records on mount so newly-created analyses appear without clicking "Buscar".
  useEffect(() => {
    let active = true;
    setLoading(true);
    apiGet<RecordSummary[]>('/api/records?q=')
      .then((r) => { if (active) setRecords(r); })
      .catch((err) => { if (active) setError(err instanceof Error ? err.message : 'Error al buscar registros.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

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
      {/* Search card */}
      <Card className="p-4 shadow-sm">
        <form onSubmit={handleSearch} className="flex gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar por MAWB o cliente"
              className="pl-10"
            />
          </div>
          <Button type="submit" disabled={loading}>
            Buscar
          </Button>
        </form>
      </Card>

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

      {detail && <ReportTabs recordId={detail.id} />}

      {detail && (
        <Card className="p-5 shadow-sm">
          <h3 className="mb-4 flex items-center gap-2 text-sm font-bold text-slate-800">
            <FileText className="h-4 w-4 text-navy-700" />
            {detail.mawbReference} — {detail.clientName}
          </h3>
          <div className="space-y-2">
            <div>
              <FileCard
                kind="xls"
                name="Análisis de Riesgo"
                onDownload={() => handleDownload(`/api/records/${detail.id}/risk.xlsx`, 'Analisis_de_Riesgo.xlsx')}
              />
            </div>
            <div>
              <FileCard
                kind="xls"
                name="Reporte General"
                onDownload={() => handleDownload(`/api/records/${detail.id}/report.xlsx`, 'Reporte_General.xlsx')}
              />
            </div>
            <div>
              <FileCard
                kind="xls"
                name="LayOut"
                onDownload={() => handleDownload(`/api/records/${detail.id}/layout.xlsx`, 'LayOut_sistema.xlsx')}
              />
            </div>
            {hasPedimento && (
              <div>
                <FileCard
                  kind="pdf"
                  name="Pedimento"
                  onDownload={() => handleDownload(detail.artifacts.pedimentoPdf as string, 'Pedimento.pdf')}
                />
              </div>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
