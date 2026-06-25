import { Fragment, useEffect, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent } from 'react';
import { Search, Upload, Download, ShieldCheck, ShieldAlert, ShieldX, ShieldQuestion } from 'lucide-react';
import { apiGet, apiDownload } from '../api';
import { Card, Button, StatusPill } from './ui';
import type { Resultado } from './ui';
import { CaptureWizard } from './CaptureWizard';
import type { PedimentoItem } from './CaptureWizard';
import type { ManifestCoverageStatus } from '../../shared/pedimento/coverage';
import type { SeguimientoScanVerdict } from '../../shared/pedimento/seguimientoStatus';

const BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';

function authHeaders(): Record<string, string> {
  const t = localStorage.getItem('token');
  return t ? { Authorization: `Bearer ${t}` } : {};
}

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

// RF-08/RF-10 — pedimento scan verdict returned by the upload endpoint.
type ScanVerdict = SeguimientoScanVerdict;
interface ScanFinding { motor: string; code: string; severity: string; message: string }
interface ScanResult { verdict: ScanVerdict; findings: ScanFinding[]; motors: { rf08: ScanVerdict; rf10: ScanVerdict } }

const SCAN_META: Record<ScanVerdict, { resultado: Resultado; label: string; icon: typeof ShieldCheck; note: string }> = {
  clean:       { resultado: 'verde',    label: 'Sin contenido activo', icon: ShieldCheck,    note: 'El PDF no contiene comandos ejecutables ni códigos QR sospechosos.' },
  suspicious:  { resultado: 'amarillo', label: 'Revisar hallazgos',     icon: ShieldAlert,    note: 'Se detectó contenido potencialmente activo. Revisar antes de continuar.' },
  blocked:     { resultado: 'rojo',     label: 'Bloqueado',             icon: ShieldX,        note: 'El PDF fue rechazado por contener contenido activo no permitido.' },
  unscannable: { resultado: 'gris',     label: 'No analizable',         icon: ShieldQuestion, note: 'No fue posible analizar parte del documento (p. ej. códigos QR).' },
};

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

  // PDF upload
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [uploadLoading, setUploadLoading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSuccess, setUploadSuccess] = useState(false);
  const [uploadWarning, setUploadWarning] = useState<string | null>(null);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
    setUploadError(null);
    setUploadSuccess(false);
    setUploadWarning(null);
    setScan(null);
    setPdfFile(null);
    setPedimentos([]);
    setLock({ editable: true, reason: null });
    // Pre-load the manifest lock + the pedimentos sub-list (each row carries its own capture data).
    try {
      await loadDetail(r.id);
    } catch {
      // Non-fatal: leave the sub-list empty if the detail can't be loaded.
    }
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    setIsDragging(true);
  }

  function handleDragLeave() {
    setIsDragging(false);
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    setIsDragging(false);
    const dropped = e.dataTransfer.files[0];
    if (dropped && dropped.type === 'application/pdf') {
      setPdfFile(dropped);
    }
  }

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    if (f) setPdfFile(f);
  }

  async function handleUpload() {
    if (!selectedId || !pdfFile) return;
    setUploadLoading(true);
    setUploadError(null);
    setUploadSuccess(false);
    setUploadWarning(null);
    setScan(null);
    try {
      const fd = new FormData();
      fd.append('file', pdfFile);
      const res = await fetch(`${BASE}/api/manifests/${selectedId}/pedimento-pdf`, {
        method: 'POST',
        headers: authHeaders(),
        body: fd,
      });
      const data = await res.json().catch(() => ({}));
      if (data?.scan) setScan(data.scan as ScanResult); // present on both success and 422 (blocked)
      if (!res.ok) {
        throw new Error(data.error ?? res.statusText);
      }
      setUploadSuccess(true);
      if (data?.warning) setUploadWarning(data.warning as string);
      setPdfFile(null);
      // Refresh the pedimentos sub-list + the work-queue coverage chip.
      const list = await loadDetail(selectedId);
      void loadList();
      // Auto-open the wizard for the freshly created subdivisión so capture flows straight from upload.
      const newId = (data as { pedimentoId?: string })?.pedimentoId;
      const created = newId ? list.find((p) => p.id === newId) : undefined;
      if (created) setWizardPedimento(created);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Error al subir el archivo.');
    } finally {
      setUploadLoading(false);
    }
  }

  async function handleDownloadPdf(p: PedimentoItem) {
    if (!p.pedimentoPdf) return;
    try {
      // Match ConsultaView: name the file by pedimento number (falling back to its row id).
      await apiDownload(p.pedimentoPdf, `Pedimento_${p.numeroPedimento ?? p.id}.pdf`);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Error al descargar el PDF.');
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
          <div className="mb-4 flex items-center justify-between gap-2">
            <h2 className="text-sm font-bold text-slate-700 uppercase tracking-wide">Pedimentos (subdivisiones)</h2>
            <span className="text-xs font-medium text-navy-700">{selectedLabel}</span>
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

          {/* Per-manifest upload control — adds a new subdivisión row each time. Hidden once the
              record is locked (prevalidado / PDF adjunto): the import-data lock also seals attachment. */}
          {lock.editable ? (
            <>
              <h3 className="mb-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Agregar pedimento PDF</h3>
              <div
                role="button"
                tabIndex={0}
                aria-label="Zona de carga de pedimento PDF"
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click(); }}
                className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-10 text-center transition ${
                  isDragging ? 'border-navy-600 bg-navy-50' : 'border-slate-300 bg-slate-50 hover:border-navy-400 hover:bg-navy-50/30'
                }`}
              >
                <Upload className="h-8 w-8 text-slate-400" />
                {pdfFile ? (
                  <p className="text-sm font-medium text-slate-800">{pdfFile.name}</p>
                ) : (
                  <p className="text-sm text-slate-500">Arrastra o haz clic para seleccionar el pedimento PDF</p>
                )}
                <p className="text-xs text-slate-400">Los pedimentos pesan entre 40 y 80 MB</p>
              </div>
              <input ref={fileInputRef} type="file" accept=".pdf" onChange={handleFileChange} className="sr-only" aria-hidden="true" />

              {uploadError && (
                <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm font-medium text-red-700">{uploadError}</p>
              )}
              {uploadSuccess && (
                <p className="mt-3 rounded-lg border border-navy-200 bg-navy-50 px-4 py-2 text-sm font-medium text-navy-800">Pedimento PDF subido correctamente.</p>
              )}
              {uploadWarning && (
                <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-800">{uploadWarning}</p>
              )}

              {scan && <ScanResultCard scan={scan} />}

              {pdfFile && (
                <div className="mt-4">
                  <Button type="button" disabled={uploadLoading} onClick={handleUpload}>
                    {uploadLoading ? 'Subiendo…' : 'Subir PDF'}
                  </Button>
                </div>
              )}
            </>
          ) : (
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

// RF-08/RF-10 — security scan verdict shown right after upload.
function ScanResultCard({ scan }: { scan: ScanResult }) {
  const meta = SCAN_META[scan.verdict] ?? SCAN_META.unscannable;
  const Icon = meta.icon;
  return (
    <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-center gap-3">
        <Icon className="h-5 w-5 text-slate-500" />
        <span className="text-sm font-semibold text-slate-700">Análisis de seguridad del PDF</span>
        <StatusPill resultado={meta.resultado} label={meta.label} />
      </div>
      <p className="mt-2 text-xs text-slate-500">{meta.note}</p>
      {scan.findings.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {scan.findings.map((f, i) => (
            <li key={i} className="flex items-start gap-2 text-xs">
              <span className={`mt-0.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
                f.severity === 'critical' ? 'bg-red-500' : f.severity === 'warning' ? 'bg-amber-500' : 'bg-slate-400'
              }`} />
              <span className="text-slate-600">
                <span className="font-mono text-[11px] text-slate-400">{f.motor === 'RF10_QR_TROJAN' ? 'QR' : 'PDF'}</span>{' '}
                {f.message}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
