import { useEffect, useState } from 'react';
import { AlertTriangle, Download, Eye, FileText, ShieldAlert } from 'lucide-react';
import { apiGet, apiDownload } from '../api';
import { Card } from './ui';
import { RiskResultTable, RiskSummary } from './RiskResultTable';
import type { RiskRow, RiskSummaryData } from './RiskResultTable';
import { TramiteDetailDrawer } from './TramiteDetailDrawer';

interface ReportLockState { editable: boolean; reason: string | null }
interface ReportsBundle {
  risk: RiskRow[];
  report: Record<string, string>[];
  layout: Record<string, string>[];
  lock: ReportLockState;
  riskStale: boolean;
  masked: boolean;
  generatedAt: string;
  contentHash: string;
}

type TabKey = 'riesgo' | 'reporte' | 'layout' | 'pedimento';
const TABS: { key: TabKey; label: string }[] = [
  { key: 'riesgo', label: 'Análisis de Riesgo' },
  { key: 'reporte', label: 'Reporte General' },
  { key: 'layout', label: 'Layout' },
];

// Download target (xlsx report or the pedimento PDF) for the currently selected tab.
function downloadTargetFor(tab: TabKey, recordId: string, pedimentoPdf: string | null): { path: string; name: string } | null {
  switch (tab) {
    case 'riesgo': return { path: `/api/records/${recordId}/risk.xlsx`, name: 'Analisis_de_Riesgo.xlsx' };
    case 'reporte': return { path: `/api/records/${recordId}/report.xlsx`, name: 'Reporte_General.xlsx' };
    case 'layout': return { path: `/api/records/${recordId}/layout.xlsx`, name: 'LayOut_sistema.xlsx' };
    case 'pedimento': return pedimentoPdf ? { path: pedimentoPdf, name: 'Pedimento.pdf' } : null;
  }
}

// Columns surfaced in the wide-report grids; the row click opens the drawer with ALL columns.
const REPORT_COLUMNS = ['No. de guía aérea', 'Consignatario Nombre/razón social', 'Descripción de la mercancía', 'Valor en Aduana declarado', 'Resultado'];
const LAYOUT_COLUMNS = ['No. de guía aérea', 'Consignatario Nombre/razón social', 'Descripción de la mercancía', 'Fracción arancelaria', 'Valor en Aduana declarado'];

function summarize(rows: RiskRow[]): RiskSummaryData {
  return {
    analizados: rows.length,
    aprobados: rows.filter((r) => r.resultado === 'verde').length,
    noIdentificados: rows.filter((r) => r.resultado === 'amarillo').length,
    validarEnPrevio: rows.filter((r) => r.resultado === 'rojo').length,
  };
}

function GridTable({
  columns,
  rows,
  onRowClick,
}: {
  columns: string[];
  rows: Record<string, string>[];
  onRowClick: (row: Record<string, string>) => void;
}) {
  if (rows.length === 0) {
    return <p className="rounded-xl border border-slate-200 bg-white px-4 py-6 text-center text-sm text-slate-500">Sin trámites para mostrar.</p>;
  }
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="max-h-[28rem] overflow-auto">
        <table className="min-w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-slate-50">
            <tr className="border-b border-slate-200 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
              {columns.map((c) => <th key={c} className="px-4 py-3 whitespace-nowrap">{c}</th>)}
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((row, i) => (
              <tr
                key={i}
                onClick={() => onRowClick(row)}
                className="cursor-pointer align-top text-slate-700 transition-colors hover:bg-navy-50/50"
              >
                {columns.map((c) => (
                  <td key={c} className="px-4 py-3 text-slate-700">{row[c] || '—'}</td>
                ))}
                <td className="px-4 py-3 text-right text-xs font-medium text-navy-600">Ver detalle</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-400">{rows.length} trámite(s) · clic en una fila para ver todos los campos</p>
    </div>
  );
}

export function ReportTabs({ recordId, pedimentoPdf = null, refreshKey = 0 }: { recordId: string; pedimentoPdf?: string | null; refreshKey?: number }) {
  const [bundle, setBundle] = useState<ReportsBundle | null>(null);
  const [tab, setTab] = useState<TabKey>('riesgo');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [drawerRow, setDrawerRow] = useState<{ row: Record<string, string>; title: string } | null>(null);

  const tabs = pedimentoPdf ? [...TABS, { key: 'pedimento' as TabKey, label: 'Pedimento' }] : TABS;

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    const qs = revealed ? '?reveal=all' : '';
    apiGet<ReportsBundle>(`/api/records/${recordId}/reports.json${qs}`)
      .then((b) => { if (active) setBundle(b); })
      .catch((err) => { if (active) setError(err instanceof Error ? err.message : 'Error al cargar los reportes.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [recordId, refreshKey, revealed]);

  // Reset reveal + tab when switching records (pedimento may not exist on the next record).
  useEffect(() => { setRevealed(false); setDrawerRow(null); setTab('riesgo'); }, [recordId]);

  async function handleDownloadCurrent() {
    const target = downloadTargetFor(tab, recordId, pedimentoPdf);
    if (!target) return;
    setError(null);
    try {
      await apiDownload(target.path, target.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al descargar el archivo.');
    }
  }

  return (
    <Card className="p-5 shadow-sm">
      {/* Tabs + download for the active tab */}
      <div className="mb-4 flex items-center justify-between gap-2 border-b border-slate-200">
        <div className="flex flex-wrap gap-1">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`-mb-px border-b-2 px-4 py-2 text-sm font-semibold transition-colors ${
                tab === t.key ? 'border-navy-600 text-navy-700' : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={handleDownloadCurrent}
          className="mb-2 inline-flex shrink-0 items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-100"
        >
          <Download className="h-3.5 w-3.5" /> Descargar
        </button>
      </div>

      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">{error}</div>}
      {loading && !bundle && <p className="px-1 py-6 text-sm text-slate-500">Cargando…</p>}

      {bundle && (
        <div className="space-y-4">
          {bundle.riskStale && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>Riesgo desactualizado: los datos de importación cambiaron después del análisis. Vuelva a correr el análisis de riesgo antes de continuar al previo.</span>
            </div>
          )}
          {bundle.masked && (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm text-slate-600">
              <span className="flex items-center gap-2"><ShieldAlert className="h-4 w-4 text-slate-400" /> Datos de identidad (RFC/CURP/pasaporte) ocultos.</span>
              <button
                type="button"
                onClick={() => setRevealed(true)}
                className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-100"
              >
                <Eye className="h-3.5 w-3.5" /> Revelar datos sensibles
              </button>
            </div>
          )}

          {tab === 'riesgo' && (
            <div className="space-y-4">
              <RiskSummary summary={summarize(bundle.risk ?? [])} />
              <RiskResultTable rows={bundle.risk ?? []} />
            </div>
          )}
          {tab === 'reporte' && (
            <GridTable
              columns={REPORT_COLUMNS}
              rows={bundle.report ?? []}
              onRowClick={(row) => setDrawerRow({ row, title: `Trámite — ${row['No. de guía aérea'] || ''}` })}
            />
          )}
          {tab === 'layout' && (
            <GridTable
              columns={LAYOUT_COLUMNS}
              rows={bundle.layout ?? []}
              onRowClick={(row) => setDrawerRow({ row, title: `Trámite — ${row['No. de guía aérea'] || ''}` })}
            />
          )}
          {tab === 'pedimento' && (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-10 text-center shadow-sm">
              <div className="grid h-12 w-12 place-items-center rounded-xl bg-navy-50 text-navy-700">
                <FileText className="h-6 w-6" />
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-800">Pedimento (PDF)</p>
                <p className="mt-0.5 text-xs text-slate-500">Descargue el documento para abrirlo.</p>
              </div>
              <button
                type="button"
                onClick={handleDownloadCurrent}
                className="inline-flex items-center gap-1.5 rounded-md bg-navy-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-navy-700"
              >
                <Download className="h-4 w-4" /> Descargar PDF
              </button>
            </div>
          )}
        </div>
      )}

      {drawerRow && (
        <TramiteDetailDrawer row={drawerRow.row} title={drawerRow.title} onClose={() => setDrawerRow(null)} />
      )}
    </Card>
  );
}
