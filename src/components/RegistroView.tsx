import { useState, useEffect, useMemo } from 'react';
import { Upload, Check } from 'lucide-react';
import { apiGet, apiPost, apiUpload } from '../api';
import { Stepper, Button, Field, Input, SearchSelect } from './ui';
import type { SearchSelectOption } from './ui';
import { extractMawb } from '../lib/extractMawb';
import { AddClientModal, type Client, type ClientPlatform } from './AddClientModal';
import { AddPlatformModal } from './AddPlatformModal';
import { RiskSummary, RiskResultTable, type RiskRow, type RiskSummaryData } from './RiskResultTable';

interface StagingResponse {
  manifestId: string;
  ingestionStatus: string;
  counts: { total: number; valid: number; warning: number; error: number };
  rejected: { rowIndex: number; field: string; message: string }[];
  warnings: { rowIndex: number; field: string; message: string }[];
  unmappedHeaders: string[];
  duplicateHeaders: string[];
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

const STEPS = ['Cargar manifiesto', 'Datos del manifiesto', 'Análisis de riesgo', 'Resultado'];

export default function RegistroView() {
  const [current, setCurrent] = useState(0);
  const [mawbReference, setMawbReference] = useState('');
  const [mawbAmbiguous, setMawbAmbiguous] = useState(false);
  const [clients, setClients] = useState<Client[]>([]);
  const [clientId, setClientId] = useState('');
  const [platformId, setPlatformId] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [platformModalOpen, setPlatformModalOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unmappedHeaders, setUnmappedHeaders] = useState<string[]>([]);
  const [staging, setStaging] = useState<StagingResponse | null>(null);
  const [result, setResult] = useState<RiskResponse | null>(null);
  const [checkedCount, setCheckedCount] = useState(0);

  useEffect(() => {
    apiGet<Client[]>('/api/catalogs/clients').then(setClients).catch(() => {});
  }, []);

  const clientOptions: SearchSelectOption[] = useMemo(
    () => clients.map((c) => ({ value: c.id, label: c.name })),
    [clients],
  );

  const platformOptions: SearchSelectOption[] = useMemo(() => {
    const c = clients.find((c) => c.id === clientId);
    return (c?.platforms ?? []).map((p) => ({
      value: p.id!,
      label: p.commercialName || p.legalName || 'Plataforma',
    }));
  }, [clients, clientId]);

  function handleClientChange(id: string) {
    setClientId(id);
    setPlatformId(''); // platform list depends on the client
  }

  // Checklist animation runs while on the análisis step (index 2).
  useEffect(() => {
    if (current !== 2) {
      setCheckedCount(0);
      return;
    }
    if (checkedCount >= VALIDATION_LABELS.length) return;
    const timer = setTimeout(() => setCheckedCount((n) => n + 1), 220);
    return () => clearTimeout(timer);
  }, [current, checkedCount]);

  async function handleFile(selected: File | null) {
    setFile(selected);
    setMawbReference('');
    setMawbAmbiguous(false);
    if (!selected) return;
    const { mawb, ambiguous } = await extractMawb(selected);
    setMawbReference(mawb ?? '');
    setMawbAmbiguous(ambiguous);
  }

  function handleClientCreated(c: Client) {
    setClients((prev) => [...prev, c]);
    setClientId(c.id);
    setPlatformId(''); // a freshly-created client has no platforms yet
  }

  function handlePlatformCreated(p: ClientPlatform) {
    // Append the new platform to the selected client and select it.
    setClients((prev) =>
      prev.map((c) =>
        c.id === clientId ? { ...c, platforms: [...(c.platforms ?? []), p] } : c,
      ),
    );
    if (p.id) setPlatformId(p.id);
  }

  async function runAnalysis() {
    setError(null);
    setResult(null);
    setUnmappedHeaders([]);
    setStaging(null);

    if (!file) { setError('Selecciona un archivo de manifiesto.'); return; }
    if (!mawbReference.trim()) { setError('El MAWB es requerido.'); return; }
    if (!clientId) { setError('Selecciona un cliente.'); return; }
    if (!platformId) { setError('Selecciona una plataforma.'); return; }

    setCurrent(2);
    setCheckedCount(0);

    try {
      const clientName = clients.find((c) => c.id === clientId)?.name ?? '';
      const form = new FormData();
      form.append('file', file);
      form.append('mawbReference', mawbReference.trim());
      form.append('clientName', clientName);

      const stagingResult = await apiUpload<StagingResponse>('/api/manifests', form);
      setUnmappedHeaders(stagingResult.unmappedHeaders ?? []);
      setStaging(stagingResult);

      if (stagingResult.counts.error > 0) {
        setCurrent(0);
        return;
      }

      await apiPost(`/api/manifests/${stagingResult.manifestId}/client`, { clientId, platformId });
      await apiPost(`/api/manifests/${stagingResult.manifestId}/promote`, {});
      const risk = await apiPost<RiskResponse>(`/api/manifests/${stagingResult.manifestId}/risk`, {});
      setResult(risk);

      setCheckedCount(VALIDATION_LABELS.length);
      setCurrent(3);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ocurrió un error al procesar el manifiesto.');
      setCurrent(1);
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

      {staging && staging.counts.error > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm">
          <p className="font-medium text-amber-800">
            {staging.counts.error} fila(s) con errores no se importarán. Corríjalas y vuelva a subir el archivo.
          </p>
          <ul className="mt-2 list-disc pl-5 text-amber-900">
            {staging.rejected.slice(0, 50).map((r, i) => (
              <li key={i}>Fila {r.rowIndex + 1} — {r.field}: {r.message}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Step 0: Cargar manifiesto */}
      {current === 0 && (
        <div className="space-y-5 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
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
              onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
              className="sr-only"
            />
          </Field>

          <Button type="button" disabled={!file} onClick={() => setCurrent(1)}>
            Continuar
          </Button>
        </div>
      )}

      {/* Step 1: Datos del manifiesto */}
      {current === 1 && (
        <div className="space-y-5 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <Field label="MAWB" htmlFor="mawb">
            <Input
              id="mawb"
              type="text"
              value={mawbReference}
              onChange={(e) => setMawbReference(e.target.value)}
              placeholder="Ej. 045-12345678"
            />
          </Field>
          {mawbAmbiguous && (
            <p className="-mt-3 text-xs font-medium text-amber-700">
              El archivo contiene varios valores MWB. Confirme el MAWB correcto.
            </p>
          )}

          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Cliente" htmlFor="reg-cliente">
              <SearchSelect
                id="reg-cliente"
                value={clientId}
                onChange={handleClientChange}
                options={clientOptions}
                placeholder="Selecciona un cliente…"
                action={{ label: 'Agregar cliente', onClick: () => setModalOpen(true) }}
              />
            </Field>
            <Field label="Plataforma" htmlFor="reg-plataforma">
              <SearchSelect
                id="reg-plataforma"
                value={platformId}
                onChange={setPlatformId}
                options={platformOptions}
                placeholder={clientId ? 'Selecciona una plataforma…' : 'Elige un cliente primero'}
                disabled={!clientId}
                action={{ label: 'Agregar plataforma', onClick: () => setPlatformModalOpen(true) }}
              />
            </Field>
          </div>

          <div className="flex gap-2">
            <Button variant="secondary" type="button" onClick={() => setCurrent(0)}>
              Atrás
            </Button>
            <Button
              type="button"
              disabled={!mawbReference.trim() || !clientId || !platformId}
              onClick={runAnalysis}
            >
              Realizar análisis de Riesgo
            </Button>
          </div>
        </div>
      )}

      {/* Step 2: Análisis de riesgo — 7-validation checklist */}
      {current === 2 && (
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm space-y-4">
          <p className="text-sm font-medium text-slate-600">Ejecutando validaciones…</p>
          <ul className="space-y-2">
            {VALIDATION_LABELS.map((label, i) => (
              <li key={label} className="flex items-center gap-3">
                <span
                  className={`grid h-5 w-5 shrink-0 place-items-center rounded-full transition-colors duration-300 ${
                    i < checkedCount ? 'bg-navy-800 text-white' : 'border border-slate-300 bg-slate-50'
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

      {/* Step 3: Resultado */}
      {current === 3 && result && (
        <div className="space-y-4">
          <RiskSummary summary={result.summary} />
          <RiskResultTable rows={result.rows} />
        </div>
      )}

      <AddClientModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onCreated={handleClientCreated}
      />

      <AddPlatformModal
        open={platformModalOpen}
        clientId={clientId}
        clientName={clients.find((c) => c.id === clientId)?.name}
        onClose={() => setPlatformModalOpen(false)}
        onCreated={handlePlatformCreated}
      />
    </div>
  );
}
