import type { ReconciliationReport, LineResult } from '../../shared/types/reports';
import { Card } from './ui/Card';
import { StatusPill } from './ui/StatusPill';

const STATUS_LABEL: Record<LineResult['status'], string> = {
  matched: 'Coincide',
  mismatch: 'Discrepancia',
  missing_in_pedimento: 'Faltante en pedimento',
  extra_in_pedimento: 'Extra en pedimento',
};

export function ReconciliationPanel({ report }: { report: ReconciliationReport | null }) {
  if (!report) {
    return (
      <p className="text-sm text-slate-400 italic">Sin cotejo disponible.</p>
    );
  }

  const { summary, lines, notes } = report;
  const exceptionLines = lines.filter((l) => l.status !== 'matched');

  const counts: { label: string; value: number; accent: string }[] = [
    { label: 'Coinciden',              value: summary.matched,            accent: 'text-emerald-600' },
    { label: 'Discrepancias',          value: summary.mismatched,         accent: 'text-amber-600'   },
    { label: 'Faltantes en pedimento', value: summary.missingInPedimento, accent: 'text-red-600'     },
    { label: 'Extra en pedimento',     value: summary.extraInPedimento,   accent: 'text-slate-700'   },
  ];

  return (
    <div className="space-y-4">
      {/* Summary header */}
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-3">
          <StatusPill resultado={summary.color} />
          <div className="flex flex-wrap gap-4">
            {counts.map((c) => (
              <div key={c.label} className="flex items-center gap-1.5">
                <span className={`text-sm font-bold tabular-nums ${c.accent}`}>{c.value}</span>
                <span className="text-xs text-slate-500">{c.label}</span>
              </div>
            ))}
          </div>
        </div>
      </Card>

      {/* Exception lines only (mismatches, missing, extra) */}
      {exceptionLines.length > 0 ? (
        <Card>
          <div className="border-b border-slate-100 px-4 py-2.5">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Excepciones ({exceptionLines.length})
            </span>
          </div>
          <ul className="divide-y divide-slate-100">
            {exceptionLines.map((line) => {
              const failingDiffs = line.diffs.filter((d) => !d.ok);
              return (
                <li key={line.guia} className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-slate-700">{line.guia}</span>
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${
                        line.status === 'mismatch'
                          ? 'bg-amber-50 text-amber-700 ring-amber-600/20'
                          : 'bg-red-50 text-red-700 ring-red-600/20'
                      }`}
                    >
                      {STATUS_LABEL[line.status]}
                    </span>
                  </div>
                  {failingDiffs.length > 0 && (
                    <div className="mt-1.5 space-y-0.5 pl-1">
                      {failingDiffs.map((d, i) => (
                        <div key={`${d.field}-${i}`} className="flex items-start gap-2 py-0.5 text-xs">
                          <span className="w-28 shrink-0 font-mono text-slate-500">{d.field}</span>
                          <span className="text-slate-400">esperado</span>
                          <span className="font-medium text-slate-800">{d.expected ?? '—'}</span>
                          <span className="text-slate-400">actual</span>
                          <span className="font-medium text-red-600">{d.actual ?? '—'}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      ) : (
        <p className="text-sm text-slate-500">No hay excepciones — todas las guías coinciden.</p>
      )}

      {/* Notes (cross-check + intra-guía warnings) */}
      {notes.length > 0 && (
        <Card className="p-4">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Notas
          </div>
          <ul className="space-y-1">
            {notes.map((note, i) => (
              <li key={i} className="text-xs text-slate-600">
                {note}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
