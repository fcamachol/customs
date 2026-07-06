import { Fragment, useEffect, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent, MouseEvent, ReactNode } from 'react';
import { Upload, ChevronDown, ChevronRight, CheckCircle2, FileText, Loader2, Plus, Trash2 } from 'lucide-react';
import { apiGet, apiPost, apiDelete } from '../api';
import { Modal, Stepper, Button } from './ui';
import { CoverageBadge, Pill, SUB_STATUS_BADGE, SCAN_BADGE } from './capture/status';
import {
  CapturarStep, PrevalidarStep, FinalizarStep, ScanResultCard,
  uploadPedimentoPdf,
} from './capture/steps';
import type { PedimentoItem, SubStatus, ScanResult, ScanVerdict } from './capture/steps';
import type { CoverageResult } from '../../shared/pedimento/coverage';

type Phase = 'subir' | 'capturar' | 'prevalidar' | 'finalizar';

const PHASES: { key: Phase; label: string }[] = [
  { key: 'subir', label: 'Subir pedimentos' },
  { key: 'capturar', label: 'Capturar' },
  { key: 'prevalidar', label: 'Prevalidar' },
  { key: 'finalizar', label: 'Finalizar' },
];

// Per-phase "done" predicate — drives the collapse state, the "X de N listos" counter, and the
// auto-advance to the next not-done card after a save. Phases never hard-gate (soft / tolerant).
const PHASE_DONE: Record<Exclude<Phase, 'subir'>, (s: SubStatus) => boolean> = {
  capturar:   (s) => s === 'capturado' || s === 'prevalidado' || s === 'cargado',
  prevalidar: (s) => s === 'prevalidado' || s === 'cargado',
  finalizar:  (s) => s === 'cargado',
};

interface ManifestHead {
  mawbReference: string;
  clientName: string;
  coverage: CoverageResult;
}

interface RecordDetail {
  mawbReference: string;
  clientName: string;
  coverage: CoverageResult;
  pedimentos: PedimentoItem[];
}

export function CaptureWorkspace({ manifestId, onClose, onChanged }: {
  manifestId: string;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const [manifest, setManifest] = useState<ManifestHead | null>(null);
  const [pedimentos, setPedimentos] = useState<PedimentoItem[]>([]);
  const [phase, setPhase] = useState<Phase>('subir');
  const [activeCardId, setActiveCardId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  // First load picks a sensible starting phase; later refreshes leave the user's phase alone.
  const initialized = useRef(false);

  async function loadDetail() {
    const d = await apiGet<RecordDetail>(`/api/records/${manifestId}`);
    setManifest({ mawbReference: d.mawbReference, clientName: d.clientName, coverage: d.coverage });
    setPedimentos(d.pedimentos ?? []);
    if (!initialized.current) {
      initialized.current = true;
      setPhase((d.pedimentos ?? []).length === 0 ? 'subir' : 'capturar');
    }
  }

  // Re-fetch the manifest detail after any mutation (keeps every card's subStatus / version / lock
  // fresh) and refresh the parent queue so its coverage badges update.
  async function refresh() {
    try { await loadDetail(); } catch { /* non-fatal */ }
    onChanged?.();
  }

  useEffect(() => {
    let active = true;
    setLoading(true);
    apiGet<RecordDetail>(`/api/records/${manifestId}`)
      .then((d) => {
        if (!active) return;
        setManifest({ mawbReference: d.mawbReference, clientName: d.clientName, coverage: d.coverage });
        setPedimentos(d.pedimentos ?? []);
        initialized.current = true;
        setPhase((d.pedimentos ?? []).length === 0 ? 'subir' : 'capturar');
      })
      .catch((err) => { if (active) setDetailError(err instanceof Error ? err.message : 'Error al cargar el manifiesto.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [manifestId]);

  // On phase change or after a refresh, expand the first card not yet done for this phase. Manual
  // card clicks don't change `pedimentos`, so they aren't overridden here.
  useEffect(() => {
    if (phase === 'subir') return;
    const firstNotDone = pedimentos.find((p) => !PHASE_DONE[phase](p.subStatus));
    setActiveCardId(firstNotDone ? firstNotDone.id : null);
  }, [phase, pedimentos]);

  async function handleBulkFinalize() {
    const eligible = pedimentos.filter((p) => p.subStatus === 'prevalidado');
    if (eligible.length === 0) return;
    setBulkBusy(true);
    setBulkError(null);
    const failures: string[] = [];
    for (const p of eligible) {
      try {
        await apiPost(`/api/pedimentos/${p.id}/finalize`, {});
      } catch (err) {
        failures.push(`${p.numeroPedimento ?? p.id}: ${err instanceof Error ? err.message : 'error'}`);
      }
    }
    setBulkError(failures.length ? `No se pudieron finalizar: ${failures.join(' · ')}` : null);
    setBulkBusy(false);
    await refresh();
  }

  const title = manifest ? `${manifest.mawbReference} — ${manifest.clientName ?? ''}` : 'Captura de pedimentos';
  const phaseIndex = PHASES.findIndex((p) => p.key === phase);
  const eligibleToFinalize = pedimentos.filter((p) => p.subStatus === 'prevalidado').length;

  return (
    <Modal open onClose={onClose} title={title} size="2xl">
      {loading ? (
        <p className="px-1 py-6 text-sm text-slate-500">Cargando…</p>
      ) : detailError ? (
        <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">{detailError}</p>
      ) : (
        <div className="space-y-6">
          {/* Sticky manifest context + phase nav — keeps MAWB / cliente / coverage visible while the
              body scrolls (fixes the lost-context problem of the old nested modals). */}
          <div className="sticky top-0 z-10 -mx-6 -mt-6 border-b border-slate-200 bg-white px-6 pb-4 pt-6">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm text-slate-500">Manifiesto</span>
              {manifest && (
                <CoverageBadge
                  status={manifest.coverage.status}
                  uploadedCount={pedimentos.length}
                  expectedCount={manifest.coverage.expectedCount}
                />
              )}
            </div>
            <Stepper steps={PHASES.map((p) => p.label)} current={phaseIndex} onSelect={(i) => setPhase(PHASES[i].key)} />
          </div>

          {phase === 'subir' && (
            <SubirPhase manifestId={manifestId} pedimentoCount={pedimentos.length} onUploaded={refresh} onGoCapturar={() => setPhase('capturar')} />
          )}

          {phase !== 'subir' && (
            <StackedPhase
              phase={phase}
              pedimentos={pedimentos}
              activeCardId={activeCardId}
              onToggle={(id) => setActiveCardId((cur) => (cur === id ? null : id))}
              onGoSubir={() => setPhase('subir')}
              refresh={refresh}
            />
          )}

          {phase === 'finalizar' && pedimentos.length > 0 && (
            <div className="flex flex-col items-start gap-2 border-t border-slate-200 pt-4">
              {bulkError && (
                <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm font-medium text-red-700">{bulkError}</p>
              )}
              <Button type="button" disabled={bulkBusy || eligibleToFinalize === 0} onClick={handleBulkFinalize}>
                {bulkBusy ? 'Finalizando…' : `Finalizar pedimentos listos (${eligibleToFinalize})`}
              </Button>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

// ── Stacked, all-visible per-pedimento cards for Capturar / Prevalidar / Finalizar ──────────────
function StackedPhase({ phase, pedimentos, activeCardId, onToggle, onGoSubir, refresh }: {
  phase: Exclude<Phase, 'subir'>;
  pedimentos: PedimentoItem[];
  activeCardId: string | null;
  onToggle: (id: string) => void;
  onGoSubir: () => void;
  refresh: () => void;
}) {
  if (pedimentos.length === 0) {
    return (
      <div className="space-y-4">
        <p className="rounded-xl border border-slate-200 bg-white px-4 py-6 text-center text-sm text-slate-500">
          Aún no se ha adjuntado ningún pedimento para este manifiesto.
        </p>
        <Button type="button" variant="secondary" onClick={onGoSubir}>
          <Plus className="h-4 w-4" /> Subir pedimentos
        </Button>
      </div>
    );
  }

  const doneCount = pedimentos.filter((p) => PHASE_DONE[phase](p.subStatus)).length;
  const phaseLabel = PHASES.find((p) => p.key === phase)!.label;

  async function handleDelete(id: string) {
    await apiDelete(`/api/pedimentos/${id}`);
    await refresh();
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold uppercase tracking-wide text-slate-700">{phaseLabel}</h3>
        <span className="text-xs font-medium text-slate-400">{doneCount} de {pedimentos.length} listos</span>
      </div>

      {pedimentos.map((p) => (
        // Fragment carries the list key (this codebase types components with inline prop objects,
        // which don't surface React's `key` attribute on the component itself).
        <Fragment key={p.id}>
          <PedimentoCard
            pedimento={p}
            done={PHASE_DONE[phase](p.subStatus)}
            open={activeCardId === p.id}
            onToggle={() => onToggle(p.id)}
            onDelete={p.subStatus !== 'cargado' ? () => handleDelete(p.id) : undefined}
          >
            {phase === 'capturar' && (
              <CapturarStep pedimento={p} readOnly={p.subStatus === 'cargado'} onSaved={refresh} />
            )}
            {phase === 'prevalidar' && (
              <PrevalidarStep pedimento={p} readOnly={p.subStatus === 'cargado'} onApproved={refresh} onReopened={refresh} />
            )}
            {phase === 'finalizar' && (
              <FinalizarStep pedimento={p} readOnly={p.subStatus === 'cargado'} onFinalized={refresh} />
            )}
          </PedimentoCard>
        </Fragment>
      ))}
    </div>
  );
}

// Collapse wrapper for one pedimento (accordion pattern from ReportTabs). Header is always visible
// (número / subdivisión + status pill + check when done); the phase step renders when expanded.
function PedimentoCard({ pedimento, done, open, onToggle, onDelete, children }: {
  pedimento: PedimentoItem;
  done: boolean;
  open: boolean;
  onToggle: () => void;
  onDelete?: () => Promise<void>;
  children: ReactNode;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const badge = SUB_STATUS_BADGE[pedimento.subStatus];
  const scan = pedimento.scanVerdict && Object.prototype.hasOwnProperty.call(SCAN_BADGE, pedimento.scanVerdict)
    ? SCAN_BADGE[pedimento.scanVerdict as ScanVerdict]
    : null;

  async function handleConfirmDelete(e: MouseEvent) {
    e.stopPropagation();
    if (!onDelete) return;
    setBusy(true);
    setError(null);
    try {
      await onDelete();
      setConfirming(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al eliminar el pedimento.');
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-slate-50"
      >
        <span className="flex min-w-0 items-center gap-2 text-sm">
          {open ? <ChevronDown className="h-4 w-4 shrink-0 text-slate-500" /> : <ChevronRight className="h-4 w-4 shrink-0 text-slate-500" />}
          {done && <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />}
          <span className="font-semibold text-slate-800">{pedimento.numeroPedimento ?? 'Sin número'}</span>
          {pedimento.subdivisionOrdinal != null && (
            <span className="truncate text-slate-500"> — subdivisión {pedimento.subdivisionOrdinal}{pedimento.isLast ? ' (última)' : ''}</span>
          )}
        </span>
        {confirming ? (
          <span className="flex shrink-0 items-center gap-2">
            <span className="text-xs font-medium text-red-700">¿Eliminar pedimento?</span>
            <button
              type="button"
              disabled={busy}
              onClick={handleConfirmDelete}
              className="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-2.5 py-1 text-xs font-semibold text-white transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Eliminar
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={(e) => { e.stopPropagation(); setConfirming(false); }}
              className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-semibold text-slate-600 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Cancelar
            </button>
          </span>
        ) : (
          <span className="flex shrink-0 items-center gap-2">
            {onDelete && (
              <button
                type="button"
                aria-label="Eliminar pedimento"
                onClick={(e) => { e.stopPropagation(); setConfirming(true); }}
                className="rounded-md p-1 text-slate-400 transition-colors hover:bg-red-50 hover:text-red-600"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )}
            {scan && <Pill label={scan.label} cls={scan.cls} />}
            <Pill label={badge.label} cls={badge.cls} />
          </span>
        )}
      </button>
      {error && (
        <p className="mx-4 mt-3 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm font-medium text-red-700">{error}</p>
      )}
      {open && <div className="border-t border-slate-100 p-4">{children}</div>}
    </div>
  );
}

// ── Subir pedimentos: multi-file dropzone + sequential upload queue ──────────────────────────────
type QueueStatus = 'queued' | 'uploading' | 'done' | 'error' | 'blocked';
interface QueueItem {
  id: string;
  file: File;
  status: QueueStatus;
  scan?: ScanResult;
  warning?: string;
  error?: string;
  numero?: string;
}

function SubirPhase({ manifestId, pedimentoCount, onUploaded, onGoCapturar }: {
  manifestId: string;
  pedimentoCount: number;
  onUploaded: () => void;
  onGoCapturar: () => void;
}) {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [running, setRunning] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const idCounter = useRef(0);

  function addFiles(files: File[]) {
    const pdfs = files.filter((f) => f.type === 'application/pdf');
    if (pdfs.length === 0) return;
    const items: QueueItem[] = pdfs.map((file) => ({ id: `f${idCounter.current++}`, file, status: 'queued' }));
    // Drop previously-succeeded rows (their cards now live in Capturar); keep errors/blocked visible.
    setQueue((prev) => [...prev.filter((q) => q.status !== 'done'), ...items]);
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    setIsDragging(false);
    addFiles(Array.from(e.dataTransfer.files));
  }

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    addFiles(Array.from(e.target.files ?? []));
    e.target.value = '';
  }

  function update(id: string, patch: Partial<QueueItem>) {
    setQueue((prev) => prev.map((q) => (q.id === id ? { ...q, ...patch } : q)));
  }

  async function handleUpload() {
    setRunning(true);
    // Sequential: the server's per-manifest guía-overlap and duplicate-número gates compare against
    // already-inserted rows, so parallel uploads would race.
    const pending = queue.filter((q) => q.status === 'queued' || q.status === 'error' || q.status === 'blocked');
    for (const item of pending) {
      update(item.id, { status: 'uploading', error: undefined });
      try {
        const out = await uploadPedimentoPdf(manifestId, item.file);
        if (out.ok) {
          update(item.id, { status: 'done', scan: out.scan, warning: out.warning, numero: out.numeroPedimento });
        } else if (out.status === 422) {
          update(item.id, { status: 'blocked', scan: out.scan, error: out.error ?? 'PDF bloqueado por el análisis de seguridad.' });
        } else {
          const overlapMsg = out.overlap?.length ? `Guías ya cubiertas por otro pedimento: ${out.overlap.join(', ')}` : undefined;
          update(item.id, { status: 'error', error: overlapMsg ?? out.error ?? 'Error al subir el archivo.' });
        }
      } catch (err) {
        update(item.id, { status: 'error', error: err instanceof Error ? err.message : 'Error al subir el archivo.' });
      }
    }
    setRunning(false);
    onUploaded();
  }

  const pendingCount = queue.filter((q) => q.status === 'queued' || q.status === 'error' || q.status === 'blocked').length;

  return (
    <div className="space-y-4">
      <div
        role="button"
        tabIndex={0}
        aria-label="Zona de carga de pedimentos PDF"
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click(); }}
        className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-10 text-center transition ${
          isDragging ? 'border-navy-600 bg-navy-50' : 'border-slate-300 bg-slate-50 hover:border-navy-400 hover:bg-navy-50/30'
        }`}
      >
        <Upload className="h-8 w-8 text-slate-400" />
        <p className="text-sm text-slate-500">Arrastra o haz clic para seleccionar uno o varios pedimentos PDF</p>
        <p className="text-xs text-slate-400">Los pedimentos pesan entre 40 y 80 MB · puedes subir varios a la vez</p>
      </div>
      <input ref={fileInputRef} type="file" accept=".pdf" multiple onChange={handleFileChange} className="sr-only" aria-hidden="true" />

      {queue.length > 0 && (
        <ul className="space-y-2">
          {queue.map((q) => (
            <li key={q.id} className="space-y-2">
              <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm">
                <span className="flex min-w-0 items-center gap-2">
                  <FileText className="h-4 w-4 shrink-0 text-slate-400" />
                  <span className="truncate text-slate-700">{q.numero ?? q.file.name}</span>
                </span>
                <QueueStatusBadge status={q.status} />
              </div>
              {q.scan && q.scan.verdict !== 'clean' && <ScanResultCard scan={q.scan} />}
              {q.warning && (
                <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-800">{q.warning}</p>
              )}
              {q.error && (
                <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm font-medium text-red-700">{q.error}</p>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {pendingCount > 0 && (
          <Button type="button" disabled={running} onClick={handleUpload}>
            {running ? 'Subiendo…' : `Subir ${pendingCount} pedimento(s)`}
          </Button>
        )}
        {pedimentoCount > 0 && (
          <Button type="button" variant="secondary" onClick={onGoCapturar}>
            Continuar a Capturar
          </Button>
        )}
      </div>
    </div>
  );
}

function QueueStatusBadge({ status }: { status: QueueStatus }) {
  switch (status) {
    case 'uploading':
      return <span className="inline-flex items-center gap-1.5 text-xs font-medium text-navy-700"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Subiendo…</span>;
    case 'done':
      return <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700"><CheckCircle2 className="h-3.5 w-3.5" /> Subido</span>;
    case 'blocked':
      return <Pill label="Bloqueado" cls="bg-red-50 text-red-700 ring-red-600/20" />;
    case 'error':
      return <Pill label="Error" cls="bg-red-50 text-red-700 ring-red-600/20" />;
    default:
      return <Pill label="En cola" cls="bg-slate-100 text-slate-600 ring-slate-500/20" />;
  }
}
