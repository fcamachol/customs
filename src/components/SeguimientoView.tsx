import { useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import { apiGet } from '../api';
import { Card } from './ui';
import { CaptureWorkspace } from './CaptureWorkspace';
import { CoverageBadge } from './capture/status';
import type { ManifestCoverageStatus } from '../../shared/pedimento/coverage';

interface RecordRow {
  id: string;
  mawbReference: string;
  clientName: string;
  createdAt: string;
  coverageStatus: ManifestCoverageStatus;
  expectedCount: number | null;
  uploadedCount: number;
}

type TabKey = 'pending' | 'done';

export default function SeguimientoView() {
  // Work queue
  const [records, setRecords] = useState<RecordRow[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>('pending');
  const [search, setSearch] = useState('');

  // Selected manifest — opens the capture workspace (a manifest holds MANY pedimentos).
  const [selectedId, setSelectedId] = useState<string | null>(null);

  async function loadList() {
    setListLoading(true);
    setListError(null);
    try {
      setRecords(await apiGet<RecordRow[]>('/api/records'));
    } catch (err) {
      setListError(err instanceof Error ? err.message : 'Error al cargar registros.');
    } finally {
      setListLoading(false);
    }
  }

  useEffect(() => { void loadList(); }, []);

  // Pendientes = not yet fully covered; Completados = coverage complete.
  const pending = records.filter((r) => r.coverageStatus !== 'completo');
  const done = records.filter((r) => r.coverageStatus === 'completo');
  const term = search.trim().toLowerCase();
  const matches = (r: RecordRow) =>
    !term || r.mawbReference.toLowerCase().includes(term) || (r.clientName ?? '').toLowerCase().includes(term);
  const visible = (tab === 'pending' ? pending : done).filter(matches);

  return (
    <div className="space-y-6">
      {/* Work queue — Pendientes / Completados */}
      <Card className="p-6 shadow-sm">
        <div className="mb-4 flex items-center justify-between gap-2 border-b border-slate-200">
          <div className="flex flex-wrap gap-1">
            {([
              { key: 'pending' as TabKey, label: 'Pendientes', count: pending.length },
              { key: 'done' as TabKey, label: 'Completados', count: done.length },
            ]).map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={`-mb-px border-b-2 px-4 py-2 text-sm font-semibold transition-colors ${
                  tab === t.key ? 'border-navy-600 text-navy-700' : 'border-transparent text-slate-500 hover:text-slate-700'
                }`}
              >
                {t.label} <span className="text-xs font-normal text-slate-400">({t.count})</span>
              </button>
            ))}
          </div>
        </div>

        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filtrar por MAWB o cliente"
            className="w-full rounded-lg border border-slate-300 bg-white py-2.5 pl-10 pr-3.5 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-navy-600 focus:ring-2 focus:ring-navy-600/25"
          />
        </div>

        {listError && (
          <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm font-medium text-red-700">{listError}</p>
        )}
        {listLoading && <p className="mt-4 px-1 text-sm text-slate-500">Cargando…</p>}

        {!listLoading && visible.length === 0 && (
          <p className="mt-4 rounded-xl border border-slate-200 bg-white px-4 py-6 text-center text-sm text-slate-500">
            {tab === 'pending' ? 'No hay registros pendientes.' : 'No hay registros completados.'}
          </p>
        )}

        {visible.length > 0 && (
          <ul className="mt-4 divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
            {visible.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(r.id)}
                  className={`flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm transition-colors hover:bg-slate-50 ${selectedId === r.id ? 'bg-navy-50' : ''}`}
                >
                  <span className="min-w-0">
                    <span className="font-semibold text-slate-800">{r.mawbReference}</span>
                    <span className="text-slate-500"> — {r.clientName}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-3">
                    <CoverageBadge status={r.coverageStatus} uploadedCount={r.uploadedCount} expectedCount={r.expectedCount} />
                    <span className="text-xs text-slate-400">{r.createdAt}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Manifest capture workspace — opened when a manifest is selected from the queue. It owns the
          full lifecycle (Subir → Capturar → Prevalidar → Finalizar) across ALL its pedimentos. */}
      {selectedId && (
        <CaptureWorkspace
          manifestId={selectedId}
          onClose={() => setSelectedId(null)}
          onChanged={loadList}
        />
      )}
    </div>
  );
}
