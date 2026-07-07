import { useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { Download, ShieldCheck, ShieldAlert, ShieldX, ShieldQuestion } from 'lucide-react';
import { apiPost, apiDownload, ApiError } from '../../api';
import { Button, Field, Input, StatusPill } from '../ui';
import type { Resultado } from '../ui';
import { ReconciliationPanel } from '../ReconciliationPanel';
import type { ReconciliationReport } from '../../../shared/types/reports';
import type { SeguimientoScanVerdict } from '../../../shared/pedimento/seguimientoStatus';

const BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';

function authHeaders(): Record<string, string> {
  const t = localStorage.getItem('token');
  return t ? { Authorization: `Bearer ${t}` } : {};
}

// Captured import-data, stored per pedimento (subdivisión).
export interface ImportData {
  cveT1?: string | null;
  patente?: string | null;
  agenteAduanal?: string | null;
  tasaImportacion?: string | null;
  fechaEntrada?: string | null;
  claveAduanaEntrada?: string | null;
  claveAduanaDespacho?: string | null;
  tasaWarning?: string | null;
}

export interface LockState {
  editable: boolean;
  reason: string | null;
}

export type SubStatus = 'pendiente' | 'capturado' | 'prevalidado' | 'cargado' | 'rechazado';

export interface Prevalidation {
  status: string;
  errors: string[];
  warnings: string[];
}

// RF-08/RF-10 — pedimento scan verdict returned by the upload endpoint.
export type ScanVerdict = SeguimientoScanVerdict;
export interface ScanFinding { motor: string; code: string; severity: string; message: string }
export interface ScanResult { verdict: ScanVerdict; findings: ScanFinding[]; motors: { rf08: ScanVerdict; rf10: ScanVerdict } }

export const SCAN_META: Record<ScanVerdict, { resultado: Resultado; label: string; icon: typeof ShieldCheck; note: string }> = {
  clean:       { resultado: 'verde',    label: 'Sin contenido activo', icon: ShieldCheck,    note: 'El PDF no contiene comandos ejecutables ni códigos QR sospechosos.' },
  suspicious:  { resultado: 'amarillo', label: 'Revisar hallazgos',     icon: ShieldAlert,    note: 'Se detectó contenido potencialmente activo. Revisar antes de continuar.' },
  blocked:     { resultado: 'rojo',     label: 'Bloqueado',             icon: ShieldX,        note: 'El PDF fue rechazado por contener contenido activo no permitido.' },
  unscannable: { resultado: 'gris',     label: 'No analizable',         icon: ShieldQuestion, note: 'No fue posible analizar parte del documento (p. ej. códigos QR).' },
};

export interface PedimentoItem {
  id: string;
  numeroPedimento: string | null;
  subdivisionOrdinal: number | null;
  isLast: boolean;
  fileId: string | null;
  scanVerdict: string | null;
  pedimentoPdf: string | null;
  coveredGuias: string[];
  importData: ImportData | null;
  importDataVersion: number;
  subStatus: SubStatus;
  prevalidation: Prevalidation | null;
  reconciliation: ReconciliationReport | null;
  lock: LockState;
  // Extraction diagnostics captured when the PDF was attached (optional: absent on older rows).
  extractionConfidence?: number | null;
  extractionWarnings?: string[];
}

interface PedimentoForm {
  tasaImportacion: string;
  fechaEntrada: string;
  claveT1: string;
  agenteAduanal: string;
  patente: string;
  claveAduanaEntrada: string;
  claveAduanaDespacho: string;
}

const EMPTY_FORM: PedimentoForm = {
  tasaImportacion: '',
  fechaEntrada: '',
  claveT1: '',
  agenteAduanal: '',
  patente: '',
  claveAduanaEntrada: '',
  claveAduanaDespacho: '',
};

function formFromImportData(d: ImportData | null): PedimentoForm {
  if (!d) return EMPTY_FORM;
  return {
    tasaImportacion: d.tasaImportacion ?? '',
    fechaEntrada: d.fechaEntrada ?? '',
    claveT1: d.cveT1 ?? '',
    agenteAduanal: d.agenteAduanal ?? '',
    patente: d.patente ?? '',
    claveAduanaEntrada: d.claveAduanaEntrada ?? '',
    claveAduanaDespacho: d.claveAduanaDespacho ?? '',
  };
}

// Single-file pedimento PDF upload. Uses raw fetch (not apiUpload) so the RF-08/RF-10 `scan`
// body is readable even on a 422 (blocked) — apiUpload throws and discards the body. The caller
// maps the structured outcome onto its per-file queue row.
export interface UploadOutcome {
  ok: boolean;
  status: number;
  pedimentoId?: string;
  numeroPedimento?: string;
  scan?: ScanResult;
  warning?: string;
  error?: string;
  overlap?: string[];
}

export async function uploadPedimentoPdf(manifestId: string, file: File): Promise<UploadOutcome> {
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch(`${BASE}/api/manifests/${manifestId}/pedimento-pdf`, {
    method: 'POST',
    headers: authHeaders(),
    body: fd,
  });
  const data = await res.json().catch(() => ({})) as Record<string, unknown>;
  return {
    ok: res.ok,
    status: res.status,
    pedimentoId: data.pedimentoId as string | undefined,
    numeroPedimento: data.numeroPedimento as string | undefined,
    scan: data.scan as ScanResult | undefined,
    warning: data.warning as string | undefined,
    error: data.error as string | undefined,
    overlap: data.overlap as string[] | undefined,
  };
}

// RF-08/RF-10 — security scan verdict card, shown per uploaded file.
export function ScanResultCard({ scan }: { scan: ScanResult }) {
  const meta = SCAN_META[scan.verdict] ?? SCAN_META.unscannable;
  const Icon = meta.icon;
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
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

export function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium text-slate-800">{value}</dd>
    </div>
  );
}

// Pedimento identity header (número / subdivisión / guías cubiertas + PDF download).
export function PedimentoSummary({ pedimento }: { pedimento: PedimentoItem }) {
  const [error, setError] = useState<string | null>(null);

  async function handleDownload() {
    if (!pedimento.pedimentoPdf) return;
    try {
      await apiDownload(pedimento.pedimentoPdf, `Pedimento_${pedimento.numeroPedimento ?? pedimento.id}.pdf`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al descargar el PDF.');
    }
  }

  return (
    <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
      <dl className="grid gap-4 sm:grid-cols-2">
        <Detail label="Número de pedimento" value={pedimento.numeroPedimento ?? 'Sin número'} />
        <Detail
          label="Subdivisión"
          value={
            pedimento.subdivisionOrdinal != null
              ? `${pedimento.subdivisionOrdinal}${pedimento.isLast ? ' (última)' : ''}`
              : '—'
          }
        />
        <Detail label="Guías cubiertas" value={String(pedimento.coveredGuias.length)} />
      </dl>

      {pedimento.pedimentoPdf && (
        <button
          type="button"
          onClick={handleDownload}
          className="inline-flex items-center gap-1.5 rounded-md bg-navy-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-navy-700"
        >
          <Download className="h-3.5 w-3.5" /> Descargar PDF
        </button>
      )}

      {error && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm font-medium text-red-700">{error}</p>
      )}
    </div>
  );
}

// ── Capturar ─────────────────────────────────────────────────────────────────
export function CapturarStep({ pedimento, readOnly, onSaved }: {
  pedimento: PedimentoItem;
  readOnly: boolean;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<PedimentoForm>(() => formFromImportData(pedimento.importData));
  const [version, setVersion] = useState<number>(pedimento.importDataVersion ?? 0);
  const [tasaWarning, setTasaWarning] = useState<string | null>(pedimento.importData?.tasaWarning ?? null);
  const [error, setError] = useState<string | null>(null);
  const disabled = readOnly || !pedimento.lock.editable;

  function handleChange(e: ChangeEvent<HTMLInputElement>) {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  }

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const resp = await apiPost<{ version: number; importData: ImportData }>(
        `/api/pedimentos/${pedimento.id}/import-data`,
        {
          cveT1: form.claveT1,
          patente: form.patente,
          agenteAduanal: form.agenteAduanal,
          tasaImportacion: form.tasaImportacion,
          fechaEntrada: form.fechaEntrada,
          claveAduanaEntrada: form.claveAduanaEntrada,
          claveAduanaDespacho: form.claveAduanaDespacho,
          version,
        },
      );
      setVersion(resp.version);
      setTasaWarning(resp.importData?.tasaWarning ?? null);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al guardar.');
    }
  }

  return (
    <form onSubmit={handleSave} className="space-y-4">
      <PedimentoSummary pedimento={pedimento} />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Tasa de importación" htmlFor={`cw-tasaImportacion-${pedimento.id}`}>
          <Input id={`cw-tasaImportacion-${pedimento.id}`} name="tasaImportacion" type="text" value={form.tasaImportacion} onChange={handleChange} placeholder="Ej. 17.50" disabled={disabled} />
        </Field>
        <Field label="Fecha de entrada" htmlFor={`cw-fechaEntrada-${pedimento.id}`}>
          <Input id={`cw-fechaEntrada-${pedimento.id}`} name="fechaEntrada" type="date" value={form.fechaEntrada} onChange={handleChange} disabled={disabled} />
        </Field>
        <Field label="Clave T1" htmlFor={`cw-claveT1-${pedimento.id}`}>
          <Input id={`cw-claveT1-${pedimento.id}`} name="claveT1" type="text" value={form.claveT1} onChange={handleChange} placeholder="Ej. A1" disabled={disabled} />
        </Field>
        <Field label="Agente Aduanal" htmlFor={`cw-agenteAduanal-${pedimento.id}`}>
          <Input id={`cw-agenteAduanal-${pedimento.id}`} name="agenteAduanal" type="text" value={form.agenteAduanal} onChange={handleChange} placeholder="Nombre del agente" disabled={disabled} />
        </Field>
        <Field label="Patente" htmlFor={`cw-patente-${pedimento.id}`}>
          <Input id={`cw-patente-${pedimento.id}`} name="patente" type="text" value={form.patente} onChange={handleChange} placeholder="Ej. 3250" disabled={disabled} />
        </Field>
        <Field label="Clave de aduana de entrada" htmlFor={`cw-claveAduanaEntrada-${pedimento.id}`}>
          <Input id={`cw-claveAduanaEntrada-${pedimento.id}`} name="claveAduanaEntrada" type="text" value={form.claveAduanaEntrada} onChange={handleChange} placeholder="Ej. 460" disabled={disabled} />
        </Field>
        <Field label="Clave de aduana de despacho" htmlFor={`cw-claveAduanaDespacho-${pedimento.id}`}>
          <Input id={`cw-claveAduanaDespacho-${pedimento.id}`} name="claveAduanaDespacho" type="text" value={form.claveAduanaDespacho} onChange={handleChange} placeholder="Ej. 460" disabled={disabled} />
        </Field>
      </div>

      {tasaWarning && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-800">{tasaWarning}</p>
      )}
      {error && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm font-medium text-red-700">{error}</p>
      )}

      {!disabled && <Button type="submit">Guardar datos</Button>}
    </form>
  );
}

// ── Prevalidar ───────────────────────────────────────────────────────────────
export function PrevalidarStep({ pedimento, readOnly, onApproved, onReopened }: {
  pedimento: PedimentoItem;
  readOnly: boolean;
  onApproved: () => void;
  onReopened: () => void;
}) {
  const [prevalidation, setPrevalidation] = useState<Prevalidation | null>(pedimento.prevalidation);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const rejected = prevalidation?.status === 'REJECTED';

  async function handlePrevalidar() {
    setError(null);
    setBusy(true);
    try {
      // Empty body — the server self-assembles the pedimento payload (Task 1).
      const resp = await apiPost<{ prevalidation: Prevalidation }>(`/api/pedimentos/${pedimento.id}/pedimento`, {});
      setPrevalidation(resp.prevalidation);
      if (resp.prevalidation?.status === 'APPROVED') {
        onApproved();
      }
    } catch (err) {
      // A 422 (entities unconfigured / missing data) surfaces its error message inline.
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Error al prevalidar.');
    } finally {
      setBusy(false);
    }
  }

  async function handleReopen() {
    setError(null);
    setBusy(true);
    try {
      await apiPost(`/api/pedimentos/${pedimento.id}/reopen`, {});
      onReopened();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al reabrir.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {prevalidation && <PrevalidationResult prevalidation={prevalidation} />}

      <ReconciliationPanel report={pedimento.reconciliation} />

      {error && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm font-medium text-red-700">{error}</p>
      )}

      {!readOnly && (
        <div className="flex gap-2">
          {rejected ? (
            <Button type="button" disabled={busy} onClick={handleReopen}>
              {busy ? 'Reabriendo…' : 'Reabrir'}
            </Button>
          ) : (
            <Button type="button" disabled={busy} onClick={handlePrevalidar}>
              {busy ? 'Prevalidando…' : 'Prevalidar'}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function PrevalidationResult({ prevalidation }: { prevalidation: Prevalidation }) {
  const approved = prevalidation.status === 'APPROVED';
  return (
    <div className="space-y-3">
      <div
        className={`rounded-lg border px-4 py-2 text-sm font-semibold ${
          approved
            ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
            : 'border-red-200 bg-red-50 text-red-700'
        }`}
      >
        Prevalidación: {prevalidation.status}
      </div>
      {prevalidation.errors.length > 0 && (
        <ul className="space-y-1">
          {prevalidation.errors.map((e, i) => (
            <li key={i} className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm font-medium text-red-700">{e}</li>
          ))}
        </ul>
      )}
      {prevalidation.warnings.length > 0 && (
        <ul className="space-y-1">
          {prevalidation.warnings.map((w, i) => (
            <li key={i} className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-800">{w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Finalizar ────────────────────────────────────────────────────────────────
export function FinalizarStep({ pedimento, readOnly, onFinalized }: {
  pedimento: PedimentoItem;
  readOnly: boolean;
  onFinalized: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleFinalize() {
    setError(null);
    setBusy(true);
    try {
      await apiPost(`/api/pedimentos/${pedimento.id}/finalize`, {});
      onFinalized();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al finalizar.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <dl className="grid gap-4 sm:grid-cols-2">
        <Detail label="Número de pedimento" value={pedimento.numeroPedimento ?? 'Sin número'} />
        <Detail label="Guías cubiertas" value={String(pedimento.coveredGuias.length)} />
      </dl>

      {pedimento.reconciliation && <ReconciliationPanel report={pedimento.reconciliation} />}

      {readOnly ? (
        <p className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm font-medium text-slate-600">
          {pedimento.lock.reason ?? 'Pedimento cargado. Resumen de solo lectura.'}
        </p>
      ) : (
        <>
          <p className="text-sm text-slate-600">
            Confirma para finalizar la captura de este pedimento.
          </p>
          {error && (
            <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm font-medium text-red-700">{error}</p>
          )}
          <Button type="button" disabled={busy} onClick={handleFinalize}>
            {busy ? 'Finalizando…' : 'Finalizar'}
          </Button>
        </>
      )}
    </div>
  );
}
