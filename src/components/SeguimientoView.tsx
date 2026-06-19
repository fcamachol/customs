import { useState, useRef } from 'react';
import type { FormEvent, ChangeEvent, DragEvent } from 'react';
import { Search, Upload } from 'lucide-react';
import { apiGet } from '../api';
import { Card, Field, Input, Button } from './ui';

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

  // Block 3 — PDF upload
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [uploadLoading, setUploadLoading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSuccess, setUploadSuccess] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleSearch(e: FormEvent) {
    e.preventDefault();
    setSearchError(null);
    setSelectedId(null);
    setSelectedLabel('');
    setRecords([]);
    setSaveSuccess(false);
    setUploadSuccess(false);
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

  function handleSelect(r: RecordSummary) {
    setSelectedId(r.id);
    setSelectedLabel(`${r.mawbReference} — ${r.clientName}`);
    setForm(EMPTY_FORM);
    setSaveError(null);
    setSaveSuccess(false);
    setUploadError(null);
    setUploadSuccess(false);
    setPdfFile(null);
  }

  function handleFormChange(e: ChangeEvent<HTMLInputElement>) {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  }

  function handleSave(e: FormEvent) {
    e.preventDefault();
    if (!selectedId) return;
    setSaveError(null);
    setSaveSuccess(true);
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
    try {
      const fd = new FormData();
      fd.append('file', pdfFile);
      const res = await fetch(`${BASE}/api/manifests/${selectedId}/pedimento-pdf`, {
        method: 'POST',
        headers: authHeaders(),
        body: fd,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? res.statusText);
      }
      setUploadSuccess(true);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Error al subir el archivo.');
    } finally {
      setUploadLoading(false);
    }
  }

  const disabled = !selectedId;

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

      {/* Block 2 — Pedimento capture */}
      <Card className={`p-6 shadow-sm transition-opacity ${disabled ? 'opacity-50 pointer-events-none' : ''}`}>
        <h2 className="mb-4 text-sm font-bold text-slate-700 uppercase tracking-wide">Captura de pedimento</h2>
        <p className="text-[11px] font-medium text-amber-700">
          Vista previa — la persistencia se conectará al backend.
        </p>
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
              Datos capturados (vista previa).
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
              ? 'border-emerald-500 bg-emerald-50'
              : 'border-slate-300 bg-slate-50 hover:border-emerald-400 hover:bg-emerald-50/30'
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
          <p className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm font-medium text-emerald-700">
            Pedimento PDF subido correctamente.
          </p>
        )}

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
