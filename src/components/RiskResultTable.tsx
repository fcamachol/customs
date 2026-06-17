export type RiskResultado = 'verde' | 'amarillo' | 'rojo';

export interface RiskRow {
  mwb: string;
  guide: string;
  consignee: string;
  senderCity: string;
  senderCountry: string;
  resultado: RiskResultado;
  motivo: string;
}

export interface RiskSummaryData {
  analizados: number;
  aprobados: number;
  validarEnPrevio: number;
  rojos: number;
}

export function RiskSummary({ summary }: { summary: RiskSummaryData }) {
  const buckets: { label: string; value: number; className: string }[] = [
    { label: 'Analizados', value: summary.analizados, className: 'bg-gray-100 text-gray-800' },
    { label: 'Aprobados', value: summary.aprobados, className: 'bg-green-100 text-green-800' },
    { label: 'Validar en previo', value: summary.validarEnPrevio, className: 'bg-amber-100 text-amber-800' },
    { label: 'Rojos', value: summary.rojos, className: 'bg-red-100 text-red-800' },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {buckets.map((b) => (
        <div key={b.label} className={`rounded-lg p-4 ${b.className}`}>
          <div className="text-2xl font-bold">{b.value}</div>
          <div className="text-xs font-semibold uppercase tracking-wide">{b.label}</div>
        </div>
      ))}
    </div>
  );
}

const RESULTADO_STYLES: Record<RiskResultado, string> = {
  verde: 'bg-green-100 text-green-800',
  amarillo: 'bg-amber-100 text-amber-800',
  rojo: 'bg-red-100 text-red-800',
};

export function RiskResultTable({ rows }: { rows: RiskRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full border-collapse text-sm">
        <thead>
          <tr className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-600">
            <th className="border-b px-3 py-2">MWB</th>
            <th className="border-b px-3 py-2">Guía</th>
            <th className="border-b px-3 py-2">Destinatario</th>
            <th className="border-b px-3 py-2">País remitente</th>
            <th className="border-b px-3 py-2">Resultado</th>
            <th className="border-b px-3 py-2">Motivo</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.mwb}-${i}`} className="align-top">
              <td className="border-b px-3 py-2">{r.mwb}</td>
              <td className="border-b px-3 py-2">{r.guide}</td>
              <td className="border-b px-3 py-2">{r.consignee}</td>
              <td className="border-b px-3 py-2">{r.senderCountry}</td>
              <td className="border-b px-3 py-2">
                <span className={`inline-block rounded px-2 py-1 text-xs font-semibold ${RESULTADO_STYLES[r.resultado]}`}>
                  {r.resultado}
                </span>
              </td>
              <td className="border-b px-3 py-2">{r.motivo}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
