import { useState, useEffect } from 'react';
import type { FormEvent } from 'react';
import { Upload, Check } from 'lucide-react';
import * as XLSX from 'xlsx';
import { apiPost } from '../api';
import { Stepper, Button, Field, Input } from './ui';
import { RiskSummary, RiskResultTable, type RiskRow, type RiskSummaryData } from './RiskResultTable';

interface ManifestResponse {
  manifestId: string;
  shipmentCount: number;
  unmappedHeaders: string[];
}

interface RiskResponse {
  rows: RiskRow[];
  summary: RiskSummaryData;
}

const VALIDATION_LABELS = [
  'Validación ID',
  'Validación Cantidad',
  'Validación Monto',
  'Validación Consignatarios',
  'Validación Direcciones',
  'Artículos Prohibidos',
  'Validación Piratería',
  'Importaciones por consignatario',
];

const STEPS = ['Cargar manifiesto', 'Análisis de riesgo', 'Resultado'];

export default function RegistroView() {
  const [current, setCurrent] = useState(0);
  const [mawbReference, setMawbReference] = useState('');
  const [clientName, setClientName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unmappedHeaders, setUnmappedHeaders] = useState<string[]>([]);
  const [result, setResult] = useState<RiskResponse | null>(null);

  // Checklist animation state: how many validations are "checked"
  const [checkedCount, setCheckedCount] = useState(0);

  // When on step 1 (análisis), animate validations ticking in
  useEffect(() => {
    if (current !== 1) {
      setCheckedCount(0);
      return;
    }
    if (checkedCount >= VALIDATION_LABELS.length) return;
    const timer = setTimeout(() => {
      setCheckedCount((n) => n + 1);
    }, 220);
    return () => clearTimeout(timer);
  }, [current, checkedCount]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setResult(null);
    setUnmappedHeaders([]);

    if (!file) {
      setError('Selecciona un archivo de manifiesto.');
      return;
    }

    // Move to step 1 (análisis) and start the checklist animation
    setCurrent(1);
    setCheckedCount(0);

    try {
      const data = await file.arrayBuffer();
      const workbook = XLSX.read(data, { type: 'array' });
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json<Record<string, string>>(firstSheet, { defval: '' });

      const manifest = await apiPost<ManifestResponse>('/api/manifests', {
        mawbReference,
        clientName,
        rows,
      });
      setUnmappedHeaders(manifest.unmappedHeaders ?? []);

      const risk = await apiPost<RiskResponse>(`/api/manifests/${manifest.manifestId}/risk`, {});
      setResult(risk);

      // Ensure all validations appear checked before moving to result
      setCheckedCount(VALIDATION_LABELS.length);
      setCurrent(2);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ocurrió un error al procesar el manifiesto.');
      // Return to step 0 on error so the user can retry
      setCurrent(0);
    }
  }

  return (
    <div className="space-y-6">
      <Stepper steps={STEPS} current={current} />

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
          {error}
        </div>
      )}

      {unmappedHeaders.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs font-medium text-amber-800">
          Columnas no mapeadas: {unmappedHeaders.join(', ')}
        </div>
      )}

      {/* Step 0: Cargar manifiesto */}
      {current === 0 && (
        <form
          onSubmit={handleSubmit}
          className="space-y-5 rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
        >
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="MAWB" htmlFor="mawb">
              <Input
                id="mawb"
                type="text"
                value={mawbReference}
                onChange={(e) => setMawbReference(e.target.value)}
                placeholder="Ej. 045-12345678"
              />
            </Field>
            <Field label="Cliente" htmlFor="cliente">
              <Input
                id="cliente"
                type="text"
                value={clientName}
                onChange={(e) => setClientName(e.target.value)}
                placeholder="Nombre del cliente"
              />
            </Field>
          </div>

          <Field label="Manifiesto" htmlFor="manifest-file">
            <label
              htmlFor="manifest-file"
              className="flex cursor-pointer items-center gap-3 rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-3.5 text-sm transition hover:border-navy-400 hover:bg-navy-50/30"
            >
              <Upload className="h-4 w-4 shrink-0 text-navy-600" />
              <span className={file ? 'font-medium text-slate-800' : 'text-slate-500'}>
                {file ? file.name : 'Selecciona un archivo .xlsx, .xls o .csv'}
              </span>
            </label>
            <input
              id="manifest-file"
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="sr-only"
            />
          </Field>

          <Button type="submit">
            Realizar análisis de Riesgo
          </Button>
        </form>
      )}

      {/* Step 1: Análisis de riesgo — 7-validation checklist */}
      {current === 1 && (
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm space-y-4">
          <p className="text-sm font-medium text-slate-600">Ejecutando validaciones…</p>
          <ul className="space-y-2">
            {VALIDATION_LABELS.map((label, i) => (
              <li key={label} className="flex items-center gap-3">
                <span
                  className={`grid h-5 w-5 shrink-0 place-items-center rounded-full transition-colors duration-300 ${
                    i < checkedCount
                      ? 'bg-emerald-500 text-white'
                      : 'border border-slate-300 bg-slate-50'
                  }`}
                >
                  {i < checkedCount && <Check className="h-3 w-3" strokeWidth={3} />}
                </span>
                <span
                  className={`text-sm transition-colors duration-300 ${
                    i < checkedCount ? 'font-medium text-slate-800' : 'text-slate-400'
                  }`}
                >
                  {label}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Step 2: Resultado */}
      {current === 2 && result && (
        <div className="space-y-4">
          <RiskSummary summary={result.summary} />
          <RiskResultTable rows={result.rows} />
        </div>
      )}
    </div>
  );
}
