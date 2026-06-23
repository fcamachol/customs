import { useState, useRef } from 'react';
import type { FormEvent, ChangeEvent, DragEvent } from 'react';
import { Search, Upload, ShieldCheck, ShieldAlert, ShieldX, ShieldQuestion } from 'lucide-react';
import { apiGet, apiPost } from '../api';
import { Card, Field, Input, Button, StatusPill } from './ui';
import type { Resultado } from './ui';
import { ReportTabs } from './ReportTabs';

const BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';

function authHeaders(): Record<string, string> {
  const t = localStorage.getItem('token');
  return t ? { Authorization: `Bearer ${t}` } : {};
}

interface RecordSummary {
  id: string;
  mawbReference: string;
  clientName: string;
  createdAt: string;
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
type ScanVerdict = 'clean' | 'suspicious' | 'blocked' | 'unscannable';
interface ScanFinding { motor: string; code: string; severity: string; message: string }
interface ScanResult { verdict: ScanVerdict; findings: ScanFinding[]; motors: { rf08: ScanVerdict; rf10: ScanVerdict } }

const SCAN_META: Record<ScanVerdict, { resultado: Resultado; label: string; icon: typeof ShieldCheck; note: string }> = {
  clean:       { resultado: 'verde',    label: 'Sin contenido activo', icon: ShieldCheck,    note: 'El PDF no contiene comandos ejecutables ni códigos QR sospechosos.' },
  suspicious:  { resultado: 'amarillo', label: 'Revisar hallazgos',     icon: ShieldAlert,    note: 'Se detectó contenido potencialmente activo. Revisar antes de continuar.' },
  blocked:     { resultado: 'rojo',     label: 'Bloqueado',             icon: ShieldX,        note: 'El PDF fue rechazado por contener contenido activo no permitido.' },
  unscannable: { resultado: 'gris',     label: 'No analizable',         icon: ShieldQuestion, note: 'No fue posible analizar parte del documento (p. ej. códigos QR).' },
};

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

export default function SeguimientoView() {
  // Block 1 — search
  const [query, setQuery] = useState('');
  const [records, setRecords] = useState<RecordSummary[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedLabel, setSelectedLabel] = useState('');

  // Block 2 — pedimento capture
  const [form, setForm] = useState<PedimentoForm>(EMPTY_FORM);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [lock, setLock] = useState<{ editable: boolean; reason: string | null }>({ editable: true, reason: null });
  const [version, setVersion] = useState<number>(0);
  const [refreshKey, setRefreshKey] = useState(0);

  // Block 3 — PDF upload
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [uploadLoading, setUploadLoading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSuccess, setUploadSuccess] = useState(false);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleSearch(e: FormEvent) {
    e.preventDefault();
    setSearchError(null);
    setSelectedId(null);
    setSelectedLabel('');
    setRecords([]);
    setSaveSuccess(false);
    setUploadSuccess(false);
    setScan(null);
    setPdfFile(null);
    setSearchLoading(true);
    try {
      const results = await apiGet<RecordSummary[]>(`/api/records?q=${encodeURIComponent(query)}`);
      setRecords(results);
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : 'Error al buscar registros.');
    } finally {
      setSearchLoading(false);
    }
  }

  async function handleSelect(r: RecordSummary) {
    setSelectedId(r.id);
    setSelectedLabel(`${r.mawbReference} — ${r.clientName}`);
    setForm(EMPTY_FORM);
    setSaveError(null);
    setSaveSuccess(false);
    setUploadError(null);
    setUploadSuccess(false);
    setScan(null);
    setPdfFile(null);
    setLock({ editable: true, reason: null });
    setVersion(0);
    setRefreshKey((k) => k + 1);
    // Pre-load any previously-captured import data + lock state (edit-before-lock).
    try {
      const detail = await apiGet<{
        importData: Record<string, string> | null;
        importDataVersion: number;
        lock: { editable: boolean; reason: string | null };
      }>(`/api/records/${r.id}`);
      setVersion(detail.importDataVersion ?? 0);
      setLock(detail.lock ?? { editable: true, reason: null });
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
      setRefreshKey((k) => k + 1); // refresh the on-screen Reporte General + risk-stale banner
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
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Error al subir el archivo.');
    } finally {
      setUploadLoading(false);
    }
  }

  const disabled = !selectedId || !lock.editable;

  return (
    <div className="space-y-6">
      {/* Block 1 — Search */}
      <Card className="p-6 shadow-sm">
        <h2 className="mb-4 text-sm font-bold text-slate-700 uppercase tracking-wide">Buscar registro</h2>
        <form onSubmit={handleSearch} className="flex gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar por MAWB o cliente"
              className="w-full rounded-lg border border-slate-300 bg-white py-2.5 pl-10 pr-3.5 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-navy-600 focus:ring-2 focus:ring-navy-600/25"
            />
          </div>
          <Button type="submit" disabled={searchLoading}>
            Buscar
          </Button>
        </form>

        {searchError && (
          <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm font-medium text-red-700">
            {searchError}
          </p>
        )}

        {records.length > 0 && (
          <ul className="mt-4 divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
            {records.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => handleSelect(r)}
                  className={`flex w-full items-center justify-between px-4 py-3 text-left text-sm transition-colors hover:bg-slate-50 ${selectedId === r.id ? 'bg-navy-50' : ''}`}
                >
                  <span>
                    <span className="font-semibold text-slate-800">{r.mawbReference}</span>
                    <span className="text-slate-500"> — {r.clientName}</span>
                  </span>
                  <span className="ml-2 shrink-0 text-xs text-slate-400">{r.createdAt}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {selectedId && (
          <p className="mt-3 text-xs text-navy-700 font-medium">Registro seleccionado: {selectedLabel}</p>
        )}
      </Card>

      {/* On-screen reports — review the data while capturing/correcting the pedimento */}
      {selectedId && <ReportTabs recordId={selectedId} refreshKey={refreshKey} />}

      {/* Block 2 — Pedimento capture */}
      <Card className={`p-6 shadow-sm transition-opacity ${!selectedId ? 'opacity-50 pointer-events-none' : ''}`}>
        <h2 className="mb-4 text-sm font-bold text-slate-700 uppercase tracking-wide">Captura de pedimento</h2>
        {selectedId && !lock.editable && (
          <p className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm font-medium text-amber-800">
            {lock.reason ?? 'Este registro está bloqueado para edición.'}
          </p>
        )}
        <form onSubmit={handleSave} className="mt-4 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Pedimento" htmlFor="pedimento">
              <Input
                id="pedimento"
                name="pedimento"
                type="text"
                value={form.pedimento}
                onChange={handleFormChange}
                placeholder="Ej. 24 46 3250 0012345"
                disabled={disabled}
              />
            </Field>

            <Field label="Tasa de importación" htmlFor="tasaImportacion">
              <Input
                id="tasaImportacion"
                name="tasaImportacion"
                type="text"
                value={form.tasaImportacion}
                onChange={handleFormChange}
                placeholder="Ej. 17.50"
                disabled={disabled}
              />
            </Field>

            <Field label="Fecha de entrada" htmlFor="fechaEntrada">
              <Input
                id="fechaEntrada"
                name="fechaEntrada"
                type="date"
                value={form.fechaEntrada}
                onChange={handleFormChange}
                disabled={disabled}
              />
            </Field>

            <Field label="T1" htmlFor="t1">
              <Input
                id="t1"
                name="t1"
                type="text"
                value={form.t1}
                onChange={handleFormChange}
                placeholder="Ej. 2024-01-15"
                disabled={disabled}
              />
            </Field>

            <Field label="Clave T1" htmlFor="claveT1">
              <Input
                id="claveT1"
                name="claveT1"
                type="text"
                value={form.claveT1}
                onChange={handleFormChange}
                placeholder="Ej. A1"
                disabled={disabled}
              />
            </Field>

            <Field label="Agente Aduanal" htmlFor="agenteAduanal">
              <Input
                id="agenteAduanal"
                name="agenteAduanal"
                type="text"
                value={form.agenteAduanal}
                onChange={handleFormChange}
                placeholder="Nombre del agente"
                disabled={disabled}
              />
            </Field>

            <Field label="Patente" htmlFor="patente">
              <Input
                id="patente"
                name="patente"
                type="text"
                value={form.patente}
                onChange={handleFormChange}
                placeholder="Ej. 3250"
                disabled={disabled}
              />
            </Field>

            <Field label="Clave de aduana de entrada" htmlFor="claveAduanaEntrada">
              <Input
                id="claveAduanaEntrada"
                name="claveAduanaEntrada"
                type="text"
                value={form.claveAduanaEntrada}
                onChange={handleFormChange}
                placeholder="Ej. 460"
                disabled={disabled}
              />
            </Field>

            <Field label="Clave de aduana de despacho" htmlFor="claveAduanaDespacho">
              <Input
                id="claveAduanaDespacho"
                name="claveAduanaDespacho"
                type="text"
                value={form.claveAduanaDespacho}
                onChange={handleFormChange}
                placeholder="Ej. 460"
                disabled={disabled}
              />
            </Field>
          </div>

          {saveError && (
            <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm font-medium text-red-700">
              {saveError}
            </p>
          )}
          {saveSuccess && (
            <p className="rounded-lg border border-navy-200 bg-navy-50 px-4 py-2 text-sm font-medium text-navy-700">
              Datos de importación guardados correctamente.
            </p>
          )}

          <Button type="submit" disabled={disabled}>
            Guardar datos
          </Button>
        </form>
      </Card>

      {/* Block 3 — PDF import */}
      <Card className={`p-6 shadow-sm transition-opacity ${disabled ? 'opacity-50 pointer-events-none' : ''}`}>
        <h2 className="mb-4 text-sm font-bold text-slate-700 uppercase tracking-wide">Importar pedimento PDF</h2>

        {/* dropzone */}
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
            isDragging
              ? 'border-navy-600 bg-navy-50'
              : 'border-slate-300 bg-slate-50 hover:border-navy-400 hover:bg-navy-50/30'
          }`}
        >
          <Upload className="h-8 w-8 text-slate-400" />
          {pdfFile ? (
            <p className="text-sm font-medium text-slate-800">{pdfFile.name}</p>
          ) : (
            <p className="text-sm text-slate-500">
              Arrastra o haz clic para seleccionar el pedimento PDF
            </p>
          )}
          <p className="text-xs text-slate-400">Los pedimentos pesan entre 40 y 80 MB</p>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf"
          onChange={handleFileChange}
          className="sr-only"
          aria-hidden="true"
        />

        {uploadError && (
          <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm font-medium text-red-700">
            {uploadError}
          </p>
        )}
        {uploadSuccess && (
          <p className="mt-3 rounded-lg border border-navy-200 bg-navy-50 px-4 py-2 text-sm font-medium text-navy-800">
            Pedimento PDF subido correctamente.
          </p>
        )}

        {/* RF-08/RF-10 — security scan verdict */}
        {scan && (() => {
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
        })()}

        {pdfFile && (
          <div className="mt-4">
            <Button
              type="button"
              disabled={disabled || uploadLoading}
              onClick={handleUpload}
            >
              {uploadLoading ? 'Subiendo…' : 'Subir PDF'}
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
