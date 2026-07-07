import { StatusPill } from './ui';

export type RiskResultado = 'verde' | 'amarillo' | 'rojo';

export interface RiskRow {
  mwb: string;
  guide: string;
  consignee: string;
  senderCity: string;
  senderCountry: string;
  /** Descripción de la mercancía (traducida al español cuando aplica). */
  description?: string;
  resultado: RiskResultado;
  motivo: string;
}

export interface RiskSummaryData {
  analizados: number;
  aprobados: number;
  noIdentificados: number;
  validarEnPrevio: number;
}

export function RiskSummary({ summary }: { summary: RiskSummaryData }) {
  const buckets: { label: string; value: number; accent: string; dot: string }[] = [
    { label: 'Analizados',         value: summary.analizados,       accent: 'text-slate-900',    dot: 'bg-slate-400'   },
    { label: 'Aprobados',          value: summary.aprobados,        accent: 'text-emerald-600',  dot: 'bg-emerald-500' },
    { label: 'No identificados',   value: summary.noIdentificados,  accent: 'text-amber-600',    dot: 'bg-amber-500'   },
    { label: 'Validar en previo',  value: summary.validarEnPrevio,  accent: 'text-red-600',      dot: 'bg-red-500'     },
  ];
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
      {buckets.map((b) => (
        <div key={b.label} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex items-center gap-1.5">
            <span className={`h-1.5 w-1.5 rounded-full ${b.dot}`} />
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{b.label}</div>
          </div>
          <div className={`mt-1.5 text-3xl font-bold tracking-tight tabular-nums ${b.accent}`}>{b.value}</div>
        </div>
      ))}
    </div>
  );
}

export function RiskResultTable({ rows }: { rows: RiskRow[] }) {
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="overflow-x-auto">
        <table className="min-w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
              <th className="px-4 py-3">MWB</th>
              <th className="px-4 py-3">Guía</th>
              <th className="px-4 py-3">Destinatario</th>
              <th className="px-4 py-3">Descripción de la mercancía</th>
              <th className="px-4 py-3">Resultado</th>
              <th className="px-4 py-3">Motivo</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r, i) => (
              <tr key={`${r.mwb}-${i}`} className="align-top text-slate-700 transition-colors hover:bg-slate-50/70">
                <td className="px-4 py-3 font-mono text-xs text-slate-600">{r.mwb}</td>
                <td className="px-4 py-3 font-mono text-xs text-slate-600">{r.guide}</td>
                <td className="px-4 py-3 font-medium text-slate-800">{r.consignee}</td>
                <td className="px-4 py-3">{r.description || '—'}</td>
                <td className="px-4 py-3">
                  <StatusPill resultado={r.resultado} />
                </td>
                <td className="px-4 py-3 text-slate-600">{r.motivo}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
