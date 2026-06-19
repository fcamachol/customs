import { FileSpreadsheet, FileText, Download } from 'lucide-react';

export function FileCard({ kind, name, status, onDownload }:
  { kind: 'xls' | 'pdf'; name: string; status?: string; onDownload?: () => void }) {
  const Icon = kind === 'pdf' ? FileText : FileSpreadsheet;
  const tint = kind === 'pdf' ? 'text-navy-700 bg-navy-50' : 'text-slate-600 bg-slate-100';
  return (
    <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-3">
      <div className={`grid h-10 w-10 shrink-0 place-items-center rounded-lg ${tint}`}><Icon className="h-5 w-5" /></div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold text-slate-800">{name}</div>
        {status && <div className="text-xs text-slate-500">{status}</div>}
      </div>
      {onDownload && (
        <button onClick={onDownload} aria-label={`Descargar ${name}`}
          className="grid h-9 w-9 place-items-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-navy-700">
          <Download className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
