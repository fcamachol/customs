import { useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { Download } from 'lucide-react';
import { apiPost, apiDownload, ApiError } from '../api';
import { Modal, Stepper, Button, Field, Input } from './ui';
import { ReconciliationPanel } from './ReconciliationPanel';
import type { ReconciliationReport } from '../../shared/types/reports';

// Captured import-data, stored per pedimento (subdivisión).
interface ImportData {
  cveT1?: string | null;
  patente?: string | null;
  agenteAduanal?: string | null;
  tasaImportacion?: string | null;
  fechaEntrada?: string | null;
  claveAduanaEntrada?: string | null;
  claveAduanaDespacho?: string | null;
  tasaWarning?: string | null;
}

interface LockState {
  editable: boolean;
  reason: string | null;
}

type SubStatus = 'pendiente' | 'capturado' | 'prevalidado' | 'cargado' | 'rechazado';

interface Prevalidation {
  status: string;
  errors: string[];
  warnings: string[];
}

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

const STEPS = ['Revisar', 'Capturar', 'Prevalidar', 'Finalizar'];

// The starting step derives from the pedimento's lifecycle subStatus.
function initialStep(subStatus: SubStatus): number {
  switch (subStatus) {
    case 'pendiente': return 0; // Revisar (then Capturar)
    case 'rechazado': return 2; // Prevalidar (rejected → show errors + Reabrir → Capturar)
    case 'capturado': return 2; // Prevalidar
    case 'prevalidado': return 3; // Finalizar
    case 'cargado': return 3; // read-only summary
    default: return 0;
  }
}

export function CaptureWizard({ pedimento, onClose, onChanged }: {
  pedimento: PedimentoItem;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [current, setCurrent] = useState(() => initialStep(pedimento.subStatus));
  const readOnly = pedimento.subStatus === 'cargado';

  return (
    <Modal open onClose={onClose} title="Captura de pedimento" size="xl">
      <div className="space-y-6">
        <Stepper steps={STEPS} current={current} />

        {current === 0 && (
          <RevisarStep pedimento={pedimento} onContinue={readOnly ? undefined : () => setCurrent(1)} />
        )}
        {current === 1 && (
          <CapturarStep
            pedimento={pedimento}
            readOnly={readOnly}
            onSaved={() => { onChanged(); setCurrent(2); }}
          />
        )}
        {current === 2 && (
          <PrevalidarStep
            pedimento={pedimento}
            readOnly={readOnly}
            onApproved={() => { onChanged(); setCurrent(3); }}
            onReopened={() => { onChanged(); setCurrent(1); }}
          />
        )}
        {current === 3 && (
          <FinalizarStep
            pedimento={pedimento}
            readOnly={readOnly}
            onFinalized={() => { onChanged(); onClose(); }}
          />
        )}
      </div>
    </Modal>
  );
}

// ── Revisar ──────────────────────────────────────────────────────────────────
function RevisarStep({ pedimento, onContinue }: { pedimento: PedimentoItem; onContinue?: () => void }) {
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
    <div className="space-y-4">
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

      {onContinue && (
        <div>
          <Button type="button" onClick={onContinue}>Continuar</Button>
        </div>
      )}
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium text-slate-800">{value}</dd>
    </div>
  );
}

// ── Capturar ─────────────────────────────────────────────────────────────────
function CapturarStep({ pedimento, readOnly, onSaved }: {
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
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Tasa de importación" htmlFor="cw-tasaImportacion">
          <Input id="cw-tasaImportacion" name="tasaImportacion" type="text" value={form.tasaImportacion} onChange={handleChange} placeholder="Ej. 17.50" disabled={disabled} />
        </Field>
        <Field label="Fecha de entrada" htmlFor="cw-fechaEntrada">
          <Input id="cw-fechaEntrada" name="fechaEntrada" type="date" value={form.fechaEntrada} onChange={handleChange} disabled={disabled} />
        </Field>
        <Field label="Clave T1" htmlFor="cw-claveT1">
          <Input id="cw-claveT1" name="claveT1" type="text" value={form.claveT1} onChange={handleChange} placeholder="Ej. A1" disabled={disabled} />
        </Field>
        <Field label="Agente Aduanal" htmlFor="cw-agenteAduanal">
          <Input id="cw-agenteAduanal" name="agenteAduanal" type="text" value={form.agenteAduanal} onChange={handleChange} placeholder="Nombre del agente" disabled={disabled} />
        </Field>
        <Field label="Patente" htmlFor="cw-patente">
          <Input id="cw-patente" name="patente" type="text" value={form.patente} onChange={handleChange} placeholder="Ej. 3250" disabled={disabled} />
        </Field>
        <Field label="Clave de aduana de entrada" htmlFor="cw-claveAduanaEntrada">
          <Input id="cw-claveAduanaEntrada" name="claveAduanaEntrada" type="text" value={form.claveAduanaEntrada} onChange={handleChange} placeholder="Ej. 460" disabled={disabled} />
        </Field>
        <Field label="Clave de aduana de despacho" htmlFor="cw-claveAduanaDespacho">
          <Input id="cw-claveAduanaDespacho" name="claveAduanaDespacho" type="text" value={form.claveAduanaDespacho} onChange={handleChange} placeholder="Ej. 460" disabled={disabled} />
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
function PrevalidarStep({ pedimento, readOnly, onApproved, onReopened }: {
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
function FinalizarStep({ pedimento, readOnly, onFinalized }: {
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
