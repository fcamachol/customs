import type { ReconciliationReport, LineResult } from '../../shared/types/reports';
import { Card } from './ui/Card';
import { StatusPill } from './ui/StatusPill';

// Los `field` que emite reconcile.ts son identificadores internos. Mostrarlos crudos obligaba al
// operador a traducir mentalmente; estas son las mismas comparaciones, nombradas como en el
// pedimento y el manifiesto.
const FIELD_LABEL: Record<string, string> = {
  valorUsd: 'Importe',
  nombre: 'Nombre del consignatario',
  rfcCurp: 'RFC / CURP',
  totalValorUsd: 'Importe total',
};

const money = (v: unknown): string =>
  typeof v === 'number' ? v.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';

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

      {/* Estimado informativo de impuesto.
          Pedido por Luis y Roberto el 15-sep. Dos decisiones viven en este bloque y ambas se dicen
          en voz alta en pantalla: (1) se estima SÓLO sobre las partidas que van al pedimento, que
          es lo que resuelve la objeción de fondo —no se puede cobrar impuesto de mercancía que no
          va a pasar—; y (2) NO es el cálculo legal, que lo determina el agente aduanal. Cuando el
          pedimento declara su propia tasa se muestran las dos, porque la diferencia entre lo que
          corresponde y lo que se aplicó es un control, no un adorno. */}
      {report.estimadoImpuesto && (() => {
        const e = report.estimadoImpuesto;
        const tasaNuestra = e.tasasUsadas[0]?.tasaPct ?? null;
        const difiere = e.tasaPedimentoPct != null && tasaNuestra != null
          && Math.abs(e.tasaPedimentoPct - tasaNuestra) > 0.01;
        return (
          <Card className="p-4">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Estimado de impuesto
              </h4>
              <span className="text-[11px] text-slate-400">
                Informativo · el cálculo legal lo determina el agente aduanal
              </span>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Base gravable</div>
                <div className="font-mono text-sm tabular-nums text-slate-800">{money(e.totalValorUsd)} USD</div>
                <div className="text-[11px] text-slate-400">sólo lo que va al pedimento</div>
              </div>
              <div>
                <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Impuesto estimado</div>
                <div className="font-mono text-sm font-semibold tabular-nums text-slate-900">{money(e.totalImpuestoUsd)} USD</div>
              </div>
              <div>
                <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Tasa aplicada</div>
                <div className="font-mono text-sm tabular-nums text-slate-800">
                  {e.tasasUsadas.map((x) => `${x.tasaPct}% ${x.origen}`).join(' · ') || '—'}
                </div>
                {e.tasasUsadas[0] && (
                  <div className="text-[11px] text-slate-400">vigente desde {e.tasasUsadas[0].desde}</div>
                )}
              </div>
            </div>
            {difiere && (
              <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                El pedimento declara una tasa de <b>{e.tasaPedimentoPct}%</b> y la vigente para este
                origen es <b>{tasaNuestra}%</b>. Verificar cuál corresponde antes de informarle al cliente.
              </p>
            )}
            {e.sinEstimar > 0 && (
              <p className="mt-3 text-[11px] text-amber-700">
                {e.sinEstimar} partida(s) sin estimar por falta de tasa vigente — el total no las incluye.
              </p>
            )}

            {/* Desglose guía por guía. El total de arriba dice CUÁNTO; esto dice DE DÓNDE SALE, que
                es lo que permite verificar el estimado contra el pedimento partida por partida. Las
                guías sin tasa vigente muestran su motivo en lugar de un cero, por la misma razón que
                el total las excluye: un cero se confunde con "no paga". */}
            {e.partidas && e.partidas.length > 0 && (
              <details className="mt-3 group">
                <summary className="cursor-pointer list-none text-[11px] font-semibold uppercase tracking-wide text-slate-500 hover:text-slate-700">
                  <span className="group-open:hidden">Ver desglose por guía ({e.partidas.length})</span>
                  <span className="hidden group-open:inline">Ocultar desglose por guía</span>
                </summary>
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-slate-200 text-[10px] font-bold uppercase tracking-wide text-slate-400">
                        <th className="py-1.5 pr-3 text-left font-bold">Guía</th>
                        <th className="py-1.5 pr-3 text-left font-bold">Origen</th>
                        <th className="py-1.5 pr-3 text-right font-bold">Valor USD</th>
                        <th className="py-1.5 pr-3 text-right font-bold">Tasa</th>
                        <th className="py-1.5 text-right font-bold">Impuesto USD</th>
                      </tr>
                    </thead>
                    <tbody>
                      {e.partidas.map((p) => (
                        <tr key={p.guia} className="border-b border-slate-100 last:border-0">
                          <td className="py-1.5 pr-3 font-mono text-slate-700">{p.guia}</td>
                          <td className="py-1.5 pr-3 text-slate-500">{p.origen}</td>
                          <td className="py-1.5 pr-3 text-right font-mono tabular-nums text-slate-700">{money(p.valorUsd)}</td>
                          <td className="py-1.5 pr-3 text-right font-mono tabular-nums text-slate-500">
                            {p.tasaPct == null ? '—' : `${p.tasaPct}%`}
                          </td>
                          <td className="py-1.5 text-right font-mono tabular-nums">
                            {p.impuestoUsd == null
                              ? <span className="text-amber-700" title={p.motivo}>sin estimar</span>
                              : <span className="font-semibold text-slate-900">{money(p.impuestoUsd)}</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            )}
          </Card>
        );
      })()}

      {/* Validación de montos manifiesto vs pedimento.
          Petición explícita del cliente (correo 10-ago, punto 1): la comparación de importes ya se
          calculaba —reconcile.ts compara `valorUsd` por guía y el total— pero la pantalla sólo
          enseñaba guías y nombres, así que para el operador simplemente no existía. Va arriba y
          con el desfase en pesos, porque es la cifra que se le declara a la autoridad. */}
      {(() => {
        const totalDiff = report.totals.find((d) => d.field === 'totalValorUsd');
        const conDesfase = lines.filter((l) => l.diffs.some((d) => d.field === 'valorUsd' && !d.ok));
        if (!totalDiff && conDesfase.length === 0) return null;
        const esperado = typeof totalDiff?.expected === 'number' ? totalDiff.expected : null;
        const declarado = typeof totalDiff?.actual === 'number' ? totalDiff.actual : null;
        const delta = esperado !== null && declarado !== null ? declarado - esperado : null;
        return (
          <Card className="p-4">
            <h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Validación de montos (manifiesto vs pedimento)
            </h4>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Manifiesto</div>
                <div className="font-mono text-sm tabular-nums text-slate-800">{money(esperado)} USD</div>
              </div>
              <div>
                <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Pedimento</div>
                <div className="font-mono text-sm tabular-nums text-slate-800">{money(declarado)} USD</div>
              </div>
              <div>
                <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Diferencia</div>
                <div className={`font-mono text-sm font-semibold tabular-nums ${
                  delta === null ? 'text-slate-400' : Math.abs(delta) < 0.01 ? 'text-emerald-600' : 'text-red-600'}`}>
                  {delta === null ? '—' : `${delta > 0 ? '+' : ''}${money(delta)} USD`}
                </div>
              </div>
            </div>
            {conDesfase.length > 0 && (
              <div className="mt-3 border-t border-slate-100 pt-3">
                <div className="mb-1.5 text-[11px] font-semibold text-slate-600">
                  {conDesfase.length} guía(s) con importe distinto
                </div>
                <ul className="space-y-1">
                  {conDesfase.slice(0, 8).map((l) => {
                    const d = l.diffs.find((x) => x.field === 'valorUsd')!;
                    const dif = typeof d.actual === 'number' && typeof d.expected === 'number' ? d.actual - d.expected : null;
                    return (
                      <li key={l.guia} className="flex flex-wrap items-baseline gap-x-3 text-xs">
                        <span className="font-mono text-slate-700">{l.guia}</span>
                        <span className="text-slate-500">manifiesto <span className="font-mono tabular-nums text-slate-700">{money(d.expected)}</span></span>
                        <span className="text-slate-500">pedimento <span className="font-mono tabular-nums text-slate-700">{money(d.actual)}</span></span>
                        {dif !== null && (
                          <span className="font-mono font-semibold tabular-nums text-red-600">
                            {dif > 0 ? '+' : ''}{money(dif)}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
                {conDesfase.length > 8 && (
                  <p className="mt-1 text-[11px] text-slate-400">y {conDesfase.length - 8} más — ver el detalle abajo</p>
                )}
              </div>
            )}
          </Card>
        );
      })()}

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
                          <span className="w-40 shrink-0 text-slate-500">{FIELD_LABEL[d.field] ?? d.field}</span>
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
