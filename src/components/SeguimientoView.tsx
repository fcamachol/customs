import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ChangeEvent, DragEvent } from 'react';
import { Search, Upload, Download, ShieldCheck, ShieldAlert, ShieldX, ShieldQuestion } from 'lucide-react';
import { apiGet, apiPost, apiDownload } from '../api';
import { Card, Field, Input, Button, StatusPill } from './ui';
import type { Resultado } from './ui';
import type { SeguimientoStatus, SeguimientoScanVerdict } from '../../shared/pedimento/seguimientoStatus';

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
  status: SeguimientoStatus;
  locked: boolean;
  scanVerdict: SeguimientoScanVerdict | null;
}

interface PedimentoForm {
  pedimento: string;
  tasaImportacion: string;
  fechaEntrada: string;
  t1: string;
  claveT1: string;
  agenteAduanal: string;
  patente: string;
  claveAduanaEntrada: string;
  claveAduanaDespacho: string;
}

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

// Status badge styling for the Seguimiento work-queue rows.
const STATUS_META: Record<SeguimientoStatus, { label: string; cls: string }> = {
  pendiente:   { label: 'Pendiente',        cls: 'bg-slate-100 text-slate-600 ring-slate-500/20' },
  capturado:   { label: 'Datos capturados', cls: 'bg-sky-50 text-sky-700 ring-sky-600/20' },
  rechazado:   { label: 'Rechazado',        cls: 'bg-red-50 text-red-700 ring-red-600/20' },
  prevalidado: { label: 'Prevalidado',      cls: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20' },
  cargado:     { label: 'Cargado',          cls: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20' },
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

function StatusBadge({ status, scanVerdict }: { status: SeguimientoStatus; scanVerdict: ScanVerdict | null }) {
  const meta = STATUS_META[status];
  return (
    <span className="inline-flex items-center gap-1.5">
      <Pill label={meta.label} cls={meta.cls} />
      {status === 'cargado' && scanVerdict && <Pill label={SCAN_BADGE[scanVerdict].label} cls={SCAN_BADGE[scanVerdict].cls} />}
    </span>
  );
}

const EMPTY_FORM: PedimentoForm = {
  pedimento: '',
  tasaImportacion: '',
  fechaEntrada: '',
  t1: '',
  claveT1: '',
  agenteAduanal: '',
  patente: '',
  claveAduanaEntrada: '',
  claveAduanaDespacho: '',
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
  const [pedimentoPdf, setPedimentoPdf] = useState<string | null>(null);

  // Pedimento capture
  const [form, setForm] = useState<PedimentoForm>(EMPTY_FORM);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [lock, setLock] = useState<{ editable: boolean; reason: string | null }>({ editable: true, reason: null });
  const [version, setVersion] = useState<number>(0);

  // PDF upload
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [uploadLoading, setUploadLoading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSuccess, setUploadSuccess] = useState(false);
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

  const pending = records.filter((r) => !r.locked);
  const done = records.filter((r) => r.locked);
  const term = search.trim().toLowerCase();
  const matches = (r: RecordRow) =>
    !term || r.mawbReference.toLowerCase().includes(term) || (r.clientName ?? '').toLowerCase().includes(term);
  const visible = (tab === 'pending' ? pending : done).filter(matches);

  async function handleSelect(r: RecordRow) {
    setSelectedId(r.id);
    setSelectedLabel(`${r.mawbReference} — ${r.clientName ?? ''}`);
    setForm(EMPTY_FORM);
    setSaveError(null);
    setSaveSuccess(false);
    setUploadError(null);
    setUploadSuccess(false);
    setScan(null);
    setPdfFile(null);
    setPedimentoPdf(null);
    setLock({ editable: !r.locked, reason: null });
    setVersion(0);
    // Pre-load previously-captured import data + lock state + the PDF artifact (review).
    try {
      const detail = await apiGet<{
        importData: Record<string, string> | null;
        importDataVersion: number;
        lock: { editable: boolean; reason: string | null };
        artifacts: { pedimentoPdf: string | null };
      }>(`/api/records/${r.id}`);
      setVersion(detail.importDataVersion ?? 0);
      setLock(detail.lock ?? { editable: true, reason: null });
      setPedimentoPdf(detail.artifacts?.pedimentoPdf ?? null);
      const d = detail.importData;
      if (d) {
        setForm({
          ...EMPTY_FORM,
          tasaImportacion: d.tasaImportacion ?? '',
          fechaEntrada: d.fechaEntrada ?? '',
          claveT1: d.cveT1 ?? '',
          agenteAduanal: d.agenteAduanal ?? '',
          patente: d.patente ?? '',
          claveAduanaEntrada: d.claveAduanaEntrada ?? '',
          claveAduanaDespacho: d.claveAduanaDespacho ?? '',
        });
      }
    } catch {
      // Non-fatal: leave the form empty if the detail can't be loaded.
    }
  }

  function handleFormChange(e: ChangeEvent<HTMLInputElement>) {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  }

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    if (!selectedId) return;
    setSaveError(null);
    setSaveSuccess(false);
    try {
      const resp = await apiPost<{ version: number }>(`/api/manifests/${selectedId}/import-data`, {
        cveT1: form.claveT1,
        patente: form.patente,
        agenteAduanal: form.agenteAduanal,
        tasaImportacion: form.tasaImportacion,
        fechaEntrada: form.fechaEntrada,
        claveAduanaEntrada: form.claveAduanaEntrada,
        claveAduanaDespacho: form.claveAduanaDespacho,
        version,
      });
      setVersion(resp.version);
      setSaveSuccess(true);
      void loadList(); // refresh badge (pendiente → datos capturados)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Error al guardar.');
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
      setLock({ editable: false, reason: 'Ya se adjuntó el pedimento PDF; los datos están bloqueados.' });
      void loadList(); // record moves to the "Con pedimento" tab
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Error al subir el archivo.');
    } finally {
      setUploadLoading(false);
    }
  }

  async function handleDownloadPdf() {
    if (!pedimentoPdf) return;
    try {
      await apiDownload(pedimentoPdf, 'Pedimento.pdf');
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Error al descargar el PDF.');
    }
  }

  const disabled = !selectedId || !lock.editable;

  return (
    <div className="space-y-6">
      {/* Work queue — two tabs */}
      <Card className="p-6 shadow-sm">
        <div className="mb-4 flex items-center justify-between gap-2 border-b border-slate-200">
          <div className="flex flex-wrap gap-1">
            {([
              { key: 'pending' as TabKey, label: 'Sin pedimento', count: pending.length },
              { key: 'done' as TabKey, label: 'Con pedimento', count: done.length },
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
            {tab === 'pending' ? 'No hay registros pendientes de pedimento.' : 'No hay registros con pedimento.'}
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
                    <StatusBadge status={r.status} scanVerdict={r.scanVerdict} />
                    <span className="text-xs text-slate-400">{r.createdAt}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Pedimento capture / review */}
      <Card className={`p-6 shadow-sm transition-opacity ${!selectedId ? 'opacity-50 pointer-events-none' : ''}`}>
        <div className="mb-4 flex items-center justify-between gap-2">
          <h2 className="text-sm font-bold text-slate-700 uppercase tracking-wide">
            {lock.editable ? 'Captura de pedimento' : 'Detalle del pedimento'}
          </h2>
          {selectedId && <span className="text-xs font-medium text-navy-700">{selectedLabel}</span>}
        </div>
        {selectedId && !lock.editable && (
          <p className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm font-medium text-amber-800">
            {lock.reason ?? 'Este registro está bloqueado para edición.'}
          </p>
        )}
        <form onSubmit={handleSave} className="mt-4 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Pedimento" htmlFor="pedimento">
              <Input id="pedimento" name="pedimento" type="text" value={form.pedimento} onChange={handleFormChange} placeholder="Ej. 24 46 3250 0012345" disabled={disabled} />
            </Field>
            <Field label="Tasa de importación" htmlFor="tasaImportacion">
              <Input id="tasaImportacion" name="tasaImportacion" type="text" value={form.tasaImportacion} onChange={handleFormChange} placeholder="Ej. 17.50" disabled={disabled} />
            </Field>
            <Field label="Fecha de entrada" htmlFor="fechaEntrada">
              <Input id="fechaEntrada" name="fechaEntrada" type="date" value={form.fechaEntrada} onChange={handleFormChange} disabled={disabled} />
            </Field>
            <Field label="T1" htmlFor="t1">
              <Input id="t1" name="t1" type="text" value={form.t1} onChange={handleFormChange} placeholder="Ej. 2024-01-15" disabled={disabled} />
            </Field>
            <Field label="Clave T1" htmlFor="claveT1">
              <Input id="claveT1" name="claveT1" type="text" value={form.claveT1} onChange={handleFormChange} placeholder="Ej. A1" disabled={disabled} />
            </Field>
            <Field label="Agente Aduanal" htmlFor="agenteAduanal">
              <Input id="agenteAduanal" name="agenteAduanal" type="text" value={form.agenteAduanal} onChange={handleFormChange} placeholder="Nombre del agente" disabled={disabled} />
            </Field>
            <Field label="Patente" htmlFor="patente">
              <Input id="patente" name="patente" type="text" value={form.patente} onChange={handleFormChange} placeholder="Ej. 3250" disabled={disabled} />
            </Field>
            <Field label="Clave de aduana de entrada" htmlFor="claveAduanaEntrada">
              <Input id="claveAduanaEntrada" name="claveAduanaEntrada" type="text" value={form.claveAduanaEntrada} onChange={handleFormChange} placeholder="Ej. 460" disabled={disabled} />
            </Field>
            <Field label="Clave de aduana de despacho" htmlFor="claveAduanaDespacho">
              <Input id="claveAduanaDespacho" name="claveAduanaDespacho" type="text" value={form.claveAduanaDespacho} onChange={handleFormChange} placeholder="Ej. 460" disabled={disabled} />
            </Field>
          </div>

          {saveError && (
            <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm font-medium text-red-700">{saveError}</p>
          )}
          {saveSuccess && (
            <p className="rounded-lg border border-navy-200 bg-navy-50 px-4 py-2 text-sm font-medium text-navy-700">Datos de importación guardados correctamente.</p>
          )}

          {lock.editable && (
            <Button type="submit" disabled={disabled}>Guardar datos</Button>
          )}
        </form>
      </Card>

      {/* PDF — upload (editable) or download (locked review) */}
      {selectedId && lock.editable && (
        <Card className="p-6 shadow-sm">
          <h2 className="mb-4 text-sm font-bold text-slate-700 uppercase tracking-wide">Importar pedimento PDF</h2>

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

          {scan && <ScanResultCard scan={scan} />}

          {pdfFile && (
            <div className="mt-4">
              <Button type="button" disabled={uploadLoading} onClick={handleUpload}>
                {uploadLoading ? 'Subiendo…' : 'Subir PDF'}
              </Button>
            </div>
          )}
        </Card>
      )}

      {selectedId && !lock.editable && (
        <Card className="p-6 shadow-sm">
          <h2 className="mb-4 text-sm font-bold text-slate-700 uppercase tracking-wide">Pedimento PDF</h2>
          {pedimentoPdf ? (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-10 text-center">
              <div className="grid h-12 w-12 place-items-center rounded-xl bg-navy-50 text-navy-700">
                <Download className="h-6 w-6" />
              </div>
              <p className="text-sm font-semibold text-slate-800">Documento adjunto</p>
              <button
                type="button"
                onClick={handleDownloadPdf}
                className="inline-flex items-center gap-1.5 rounded-md bg-navy-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-navy-700"
              >
                <Download className="h-4 w-4" /> Descargar PDF
              </button>
            </div>
          ) : (
            <p className="rounded-xl border border-slate-200 bg-white px-4 py-6 text-center text-sm text-slate-500">
              Este registro fue prevalidado estructuralmente; aún no se ha adjuntado un PDF.
            </p>
          )}
          {uploadError && (
            <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm font-medium text-red-700">{uploadError}</p>
          )}
        </Card>
      )}
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
