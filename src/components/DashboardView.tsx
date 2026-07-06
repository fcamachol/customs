import { Fragment, useEffect, useState } from 'react';
import { LayoutDashboard, FileSpreadsheet } from 'lucide-react';
import { apiGet } from '../api';
import { Card, EmptyState } from './ui';
import type { Section } from '../nav';

type Distribution = { verde: number; amarillo: number; rojo: number; gris: number };
interface DashboardData { manifests: number; distribution: Distribution; byUser?: { userId: string; username: string; manifests: number; distribution: Distribution }[]; }
interface RecordSummary { id: string; mawbReference: string; clientName: string; createdAt: string; }

const sum = (d: Distribution) => d.verde + d.amarillo + d.rojo + d.gris;
const pct = (n: number, total: number) => (total ? Math.round((n / total) * 1000) / 10 : 0);

export default function DashboardView({ onNavigate }: { onNavigate?: (s: Section) => void } = {}) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [recientes, setRecientes] = useState<RecordSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<DashboardData>('/api/dashboard').then(setData).catch((e) => setError(e.message));
    apiGet<RecordSummary[]>('/api/records?q=').then((r) => setRecientes(r.slice(0, 8))).catch(() => {});
  }, []);

  if (error) return <Card className="p-4 text-sm text-red-700">{error}</Card>;
  if (!data) return <Card className="p-10 text-center text-sm text-slate-400">Cargando…</Card>;
  if (data.manifests === 0) {
    return <EmptyState icon={LayoutDashboard} title="Aún no hay análisis registrados"
      message="Carga tu primer manifiesto para ver métricas de riesgo aquí."
      cta={onNavigate ? { label: 'Realizar Registro', onClick: () => onNavigate('registro') } : undefined} />;
  }

  const guias = sum(data.distribution);
  const kpis = [
    { label: 'Registros', value: data.manifests, tone: 'text-slate-900' },
    { label: 'Guías analizadas', value: guias.toLocaleString('es-MX'), tone: 'text-slate-900' },
    { label: '% Aprobados', value: `${pct(data.distribution.verde, guias)}%`, tone: 'text-emerald-600' },
    { label: 'En revisión', value: data.distribution.rojo, tone: 'text-red-600' },
  ];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {kpis.map((k) => (
          <Fragment key={k.label}>
            <Card className="p-4">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{k.label}</div>
              <div className={`mt-1.5 text-3xl font-bold tabular-nums tracking-tight ${k.tone}`}>{k.value}</div>
            </Card>
          </Fragment>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="p-5 lg:col-span-2">
          <h3 className="mb-4 text-sm font-bold text-slate-800">Distribución semáforo</h3>
          <div className="flex h-3 overflow-hidden rounded-full bg-slate-100">
            <div className="bg-emerald-500" style={{ width: `${pct(data.distribution.verde, guias)}%` }} />
            <div className="bg-amber-500" style={{ width: `${pct(data.distribution.amarillo, guias)}%` }} />
            <div className="bg-red-500" style={{ width: `${pct(data.distribution.rojo, guias)}%` }} />
            <div className="bg-slate-300" style={{ width: `${pct(data.distribution.gris, guias)}%` }} />
          </div>
          <div className="mt-3 flex gap-4 text-xs text-slate-600">
            <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-emerald-500" />Verde {data.distribution.verde}</span>
            <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-amber-500" />Amarillo {data.distribution.amarillo}</span>
            <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-red-500" />Rojo {data.distribution.rojo}</span>
            <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-slate-300" />Sin datos {data.distribution.gris}</span>
          </div>
        </Card>

        {data.byUser && (
          <Card className="p-5">
            <h3 className="mb-4 text-sm font-bold text-slate-800">Desempeño por usuario</h3>
            <ul className="space-y-2.5">
              {data.byUser.map((u) => {
                const g = sum(u.distribution);
                return (
                  <li key={u.userId} className="flex items-center justify-between text-sm">
                    <span className="font-medium text-slate-700">{u.username}</span>
                    <span className="tabular-nums text-slate-500">{u.manifests} reg · {pct(u.distribution.verde, g)}% verde · {u.distribution.rojo} rojo</span>
                  </li>
                );
              })}
            </ul>
          </Card>
        )}
      </div>

      <Card className="p-5">
        <h3 className="mb-4 text-sm font-bold text-slate-800">Análisis de riesgo recientes</h3>
        {recientes.length === 0 ? (
          <p className="text-sm text-slate-400">Sin registros recientes.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {recientes.map((r) => (
              <li key={r.id}>
                <button onClick={() => onNavigate?.('consulta')}
                  className="flex w-full items-center justify-between py-2.5 text-left text-sm transition hover:bg-slate-50">
                  <span className="flex items-center gap-2">
                    <FileSpreadsheet className="h-4 w-4 text-slate-400" />
                    <span className="font-mono text-xs text-slate-600">{r.mawbReference}</span>
                    <span className="text-slate-500">— {r.clientName}</span>
                  </span>
                  <span className="text-xs text-slate-400">{r.createdAt}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
