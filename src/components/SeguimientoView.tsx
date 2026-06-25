import { Fragment, useEffect, useState } from 'react';
import { Search, Download, Plus } from 'lucide-react';
import { apiGet, apiDownload } from '../api';
import { Card, Button } from './ui';
import { CaptureWizard } from './CaptureWizard';
import type { PedimentoItem } from './CaptureWizard';
import type { ManifestCoverageStatus } from '../../shared/pedimento/coverage';
import type { SeguimientoScanVerdict } from '../../shared/pedimento/seguimientoStatus';

interface RecordRow {
  id: string;
  mawbReference: string;
  clientName: string;
  createdAt: string;
  coverageStatus: ManifestCoverageStatus;
  expectedCount: number | null;
  uploadedCount: number;
}

interface LockState {
  editable: boolean;
  reason: string | null;
}

// A subdivisión (pedimento) attached to the selected manifest. The wizard owns the shape now (it
// carries subStatus / prevalidation / reconciliation alongside import-data); we re-export it so the
// records-detail rows and the wizard prop line up exactly.
type SubStatus = PedimentoItem['subStatus'];

// RF-08/RF-10 — pedimento scan verdict shown on each subdivisión row.
type ScanVerdict = SeguimientoScanVerdict;

// Coverage chip styling for the Seguimiento work-queue rows.
const COVERAGE_META: Record<ManifestCoverageStatus, { label: string; cls: string }> = {
  sin_pedimento: { label: 'Sin pedimento', cls: 'bg-slate-100 text-slate-600 ring-slate-500/20' },
  parcial:       { label: 'Parcial',       cls: 'bg-amber-50 text-amber-700 ring-amber-600/20' },
  completo:      { label: 'Completo',      cls: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20' },
};
const SCAN_BADGE: Record<ScanVerdict, { label: string; cls: string }> = {
  clean:       { label: 'Limpio',    cls: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20' },
  suspicious:  { label: 'Revisar',   cls: 'bg-amber-50 text-amber-700 ring-amber-600/20' },
  unscannable: { label: 'Revisar',   cls: 'bg-amber-50 text-amber-700 ring-amber-600/20' },
  blocked:     { label: 'Bloqueado', cls: 'bg-red-50 text-red-700 ring-red-600/20' },
};

function Pill({ label, cls }: { label: string; cls: string }) {
  return <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${cls}`}>{label}</span>;
}

function CoverageBadge({ status, uploadedCount, expectedCount }: { status: ManifestCoverageStatus; uploadedCount: number; expectedCount: number | null }) {
  const meta = COVERAGE_META[status];
  const count = expectedCount ? `${uploadedCount}/${expectedCount}` : `${uploadedCount}`;
  return (
    <span className="inline-flex items-center gap-1.5">
      <Pill label={meta.label} cls={meta.cls} />
      {uploadedCount > 0 && <span className="text-xs font-medium text-slate-400">{count} pedimento(s)</span>}
    </span>
  );
}

// Per-subdivisión lifecycle chip + the entry-button label, both keyed by subStatus. Clean colors.
const SUB_STATUS_BADGE: Record<SubStatus, { label: string; cls: string; action: string }> = {
  pendiente:   { label: 'Pendiente',  cls: 'bg-slate-100 text-slate-600 ring-slate-500/20',     action: 'Capturar' },
  capturado:   { label: 'Capturado',  cls: 'bg-navy-50 text-navy-700 ring-navy-600/20',         action: 'Capturar' },
  prevalidado: { label: 'Prevalidado', cls: 'bg-amber-50 text-amber-700 ring-amber-600/20',     action: 'Continuar' },
  cargado:     { label: 'Cargado',    cls: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20', action: 'Ver' },
  rechazado:   { label: 'Rechazado',  cls: 'bg-red-50 text-red-700 ring-red-600/20',            action: 'Revisar' },
};

type TabKey = 'pending' | 'done';

export default function SeguimientoView() {
  // Work queue
  const [records, setRecords] = useState<RecordRow[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>('pending');
  const [search, setSearch] = useState('');

  // Selected record
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedLabel, setSelectedLabel] = useState('');
  const [pedimentos, setPedimentos] = useState<PedimentoItem[]>([]);
  // Manifest-level lock: once the manifest is structurally finalized or any PDF is attached, no more
  // pedimentos may be added. (Per-pedimento capture has its own lock, surfaced on each row.)
  const [lock, setLock] = useState<LockState>({ editable: true, reason: null });

  // Capture wizard — opened for a single subdivisión row at a time (replaces the inline capture form).
  const [wizardPedimento, setWizardPedimento] = useState<PedimentoItem | null>(null);
  // New-pedimento mode: opens the wizard on its "Subir pedimento" step to upload + capture a new
  // subdivisión for the selected manifest (replaces the old inline bottom dropzone).
  const [wizardNew, setWizardNew] = useState(false);
  // A row-level download error (PDF download failures surface here, mirroring the old upload area).
  const [rowError, setRowError] = useState<string | null>(null);

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

  async function loadDetail(id: string): Promise<PedimentoItem[]> {
    const detail = await apiGet<{
      lock: LockState;
      pedimentos: PedimentoItem[];
    }>(`/api/records/${id}`);
    setLock(detail.lock ?? { editable: true, reason: null });
    const list = detail.pedimentos ?? [];
    setPedimentos(list);
    return list;
  }

  async function handleSelect(r: RecordRow) {
    setSelectedId(r.id);
    setSelectedLabel(`${r.mawbReference} — ${r.clientName ?? ''}`);
    setRowError(null);
    setPedimentos([]);
    setLock({ editable: true, reason: null });
    // Pre-load the manifest lock + the pedimentos sub-list (each row carries its own capture data).
    try {
      await loadDetail(r.id);
    } catch {
      // Non-fatal: leave the sub-list empty if the detail can't be loaded.
    }
  }

  async function handleDownloadPdf(p: PedimentoItem) {
    if (!p.pedimentoPdf) return;
    try {
      // Match ConsultaView: name the file by pedimento number (falling back to its row id).
      await apiDownload(p.pedimentoPdf, `Pedimento_${p.numeroPedimento ?? p.id}.pdf`);
    } catch (err) {
      setRowError(err instanceof Error ? err.message : 'Error al descargar el PDF.');
    }
  }

  // Refresh just the sub-list after a per-pedimento capture save (updates lock + version + queue).
  async function refreshAfterCapture() {
    if (!selectedId) return;
    try { await loadDetail(selectedId); } catch { /* non-fatal */ }
    void loadList();
  }

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
                  onClick={() => handleSelect(r)}
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

      {/* Pedimentos (subdivisiones) — summary rows; capture happens in the wizard (one entry point). */}
      {selectedId && (
        <Card className="p-6 shadow-sm">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 flex-col">
              <h2 className="text-sm font-bold text-slate-700 uppercase tracking-wide">Pedimentos (subdivisiones)</h2>
              <span className="text-xs font-medium text-navy-700">{selectedLabel}</span>
            </div>
            {/* Single entry point to add a pedimento: opens the wizard on its "Subir pedimento" step.
                Hidden once the manifest is locked (prevalidado / PDF adjunto seals attachment). */}
            {lock.editable && (
              <Button type="button" onClick={() => setWizardNew(true)}>
                <Plus className="h-4 w-4" /> Agregar pedimento
              </Button>
            )}
          </div>

          {pedimentos.length === 0 ? (
            <p className="mb-4 rounded-xl border border-slate-200 bg-white px-4 py-6 text-center text-sm text-slate-500">
              Aún no se ha adjuntado ningún pedimento para este manifiesto.
            </p>
          ) : (
            <div className="mb-4 space-y-3">
              {pedimentos.map((p) => (
                // Fragment carries the list key (the codebase types components with inline prop
                // objects, which don't surface React's `key` attribute on the component itself).
                <Fragment key={p.id}>
                  <PedimentoRow
                    pedimento={p}
                    onDownload={handleDownloadPdf}
                    onOpen={() => setWizardPedimento(p)}
                  />
                </Fragment>
              ))}
            </div>
          )}

          {rowError && (
            <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm font-medium text-red-700">{rowError}</p>
          )}

          {/* Once the manifest is locked (prevalidado / PDF adjunto), no more pedimentos may be added:
              the "Agregar pedimento" button is hidden above and a bloqueado note explains why. */}
          {!lock.editable && (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm font-medium text-amber-800">
              Registro bloqueado: no se pueden agregar más pedimentos.
            </p>
          )}
        </Card>
      )}

      {wizardPedimento && (
        <CaptureWizard
          pedimento={wizardPedimento}
          onClose={() => setWizardPedimento(null)}
          onChanged={refreshAfterCapture}
        />
      )}

      {wizardNew && selectedId && (
        <CaptureWizard
          manifestId={selectedId}
          onClose={() => setWizardNew(false)}
          onChanged={refreshAfterCapture}
        />
      )}
    </div>
  );
}

// Per-subdivisión summary row (Task 4). Capture no longer happens inline — the row shows número /
// subdivisión, the lifecycle status chip, the PDF download, and a single entry button that opens the
// CaptureWizard for that pedimento. The wizard handles read-only (cargado) by subStatus.
interface PedimentoRowProps {
  pedimento: PedimentoItem;
  onDownload: (p: PedimentoItem) => void;
  onOpen: () => void;
}

function PedimentoRow({ pedimento, onDownload, onOpen }: PedimentoRowProps) {
  const badge = SUB_STATUS_BADGE[pedimento.subStatus];
  const scan = pedimento.scanVerdict && Object.prototype.hasOwnProperty.call(SCAN_BADGE, pedimento.scanVerdict)
    ? SCAN_BADGE[pedimento.scanVerdict as ScanVerdict]
    : null;

  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4">
      <span className="min-w-0 text-sm">
        <span className="font-semibold text-slate-800">{pedimento.numeroPedimento ?? 'Sin número'}</span>
        {pedimento.subdivisionOrdinal != null && (
          <span className="text-slate-500"> — subdivisión {pedimento.subdivisionOrdinal}{pedimento.isLast ? ' (última)' : ''}</span>
        )}
      </span>
      <span className="flex shrink-0 items-center gap-3">
        <Pill label={badge.label} cls={badge.cls} />
        {scan && <Pill label={scan.label} cls={scan.cls} />}
        {pedimento.pedimentoPdf && (
          <button
            type="button"
            onClick={() => onDownload(pedimento)}
            className="inline-flex items-center gap-1.5 rounded-md bg-navy-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-navy-700"
          >
            <Download className="h-3.5 w-3.5" /> PDF
          </button>
        )}
        <Button type="button" onClick={onOpen}>{badge.action}</Button>
      </span>
    </div>
  );
}
