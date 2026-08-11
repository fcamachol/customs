import { useState, useEffect, useMemo } from 'react';
import { Upload, Check, RefreshCw } from 'lucide-react';
import { apiGet, apiPost, apiUpload, ApiError } from '../api';
import { useAuth } from '../context/AuthContext';
import { Stepper, Button, Field, Input, Textarea, SearchSelect } from './ui';
import type { SearchSelectOption } from './ui';
import { CANONICAL_PATHS } from '../../shared/parsing/headerSynonyms';
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
  // Multi-sheet workbooks: the ingested sheet and the ones skipped (present when >1 sheet).
  sheetName?: string;
  skippedSheets?: string[];
}

interface RiskResponse {
  rows: RiskRow[];
  summary: RiskSummaryData;
  /** Presente desde la fase 2: el resumen tras las disposiciones humanas vigentes. */
  summaryEfectivo?: RiskSummaryData;
}

/** El diff que devuelve `POST /api/manifests/:id/versiones` — lo que cambia si se sustituye. */
interface VersionStaged {
  version: number;
  estado?: 'staged';
  status?: 'sin_cambios';
  counts?: { total: number; valid: number; warning: number; error: number };
  diff?: { altas?: string[]; bajas?: string[]; modificadas?: string[]; sinCambio?: number };
}

/**
 * El estado del flujo de SUSTITUCIÓN, que arranca donde antes había un error muerto.
 *
 * `POST /api/manifests` sigue respondiendo 409 ante un MAWB repetido y eso no va a cambiar: crear una
 * SEGUNDA fila `manifests` para el mismo MAWB debe seguir siendo imposible, porque todo el modelo se
 * apoya en «un MAWB = un manifiesto = un caso». Lo que cambia es que el 409 ahora trae
 * `puedeSustituir` y un `manifestId`, así que hay una salida: subir el archivo como VERSIÓN del
 * manifiesto que ya existe. Tres pasos, y el de en medio es el que justifica los otros dos —
 * `motivo` → ver el diff → aplicar: nadie debería reemplazar datos con los que ya se calificó riesgo
 * sin ver antes qué líneas se van y cuáles llegan.
 */
type Sustitucion =
  | { fase: 'ofrecida'; manifestId: string }
  | { fase: 'motivo'; manifestId: string }
  | { fase: 'diff'; manifestId: string; staged: VersionStaged }
  | { fase: 'aplicando'; manifestId: string };

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
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin';
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
  const [sustitucion, setSustitucion] = useState<Sustitucion | null>(null);
  const [motivoSustitucion, setMotivoSustitucion] = useState('');
  const [avisoSustitucion, setAvisoSustitucion] = useState<string | null>(null);
  // Admin header-mapping panel state: chosen canonical path per unmapped header, whether to save it
  // for this client or globally, and which headers have already been saved this session.
  const [mappingChoices, setMappingChoices] = useState<Record<string, string>>({});
  const [mappingScope, setMappingScope] = useState<'client' | 'global'>('client');
  const [savedHeaders, setSavedHeaders] = useState<string[]>([]);
  const [savingHeader, setSavingHeader] = useState<string | null>(null);

  useEffect(() => {
    apiGet<Client[]>('/api/catalogs/clients').then(setClients).catch(() => {});
  }, []);

  const clientOptions: SearchSelectOption[] = useMemo(
    () => clients.map((c) => ({ value: c.id, label: c.name })),
    [clients],
  );

  // The canonical paths an admin can map an unmapped column onto.
  const canonicalOptions: SearchSelectOption[] = useMemo(
    () => CANONICAL_PATHS.map((p) => ({ value: p, label: p })),
    [],
  );

  async function saveMapping(header: string) {
    const canonicalPath = mappingChoices[header];
    if (!canonicalPath) return;
    setSavingHeader(header);
    try {
      await apiPost('/api/header-mappings', {
        clientId: mappingScope === 'client' ? clientId : null,
        header,
        canonicalPath,
      });
      setSavedHeaders((prev) => (prev.includes(header) ? prev : [...prev, header]));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo guardar el mapeo de columna.');
    } finally {
      setSavingHeader(null);
    }
  }

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
    setMappingChoices({});
    setSavedHeaders([]);
    setSustitucion(null);
    setAvisoSustitucion(null);
    setMappingScope(clientId ? 'client' : 'global');

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
      // Bind the upload to the client so its saved header mappings apply on this and future uploads.
      form.append('clientId', clientId);

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
      // El 409 por MAWB duplicado ya NO es el final del camino: el servidor dice `puedeSustituir` y
      // devuelve el manifiesto que ya existe, así que en vez de un error rojo se ofrece la salida.
      if (
        err instanceof ApiError && err.status === 409 && err.body.puedeSustituir === true
        && typeof err.body.manifestId === 'string'
      ) {
        setSustitucion({ fase: 'ofrecida', manifestId: err.body.manifestId });
        setMotivoSustitucion('');
        setCurrent(1);
        return;
      }
      setError(err instanceof Error ? err.message : 'Ocurrió un error al procesar el manifiesto.');
      setCurrent(1);
    }
  }

  /** Paso 2: sube el archivo como versión n+1 y trae el diff. NO aplica nada todavía. */
  async function verCambiosDeSustitucion() {
    if (!sustitucion || !file) return;
    const manifestId = sustitucion.manifestId;
    setError(null);
    setAvisoSustitucion(null);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('motivo', motivoSustitucion.trim());
      const staged = await apiUpload<VersionStaged>(`/api/manifests/${manifestId}/versiones`, form);
      if (staged.status === 'sin_cambios') {
        // La compuerta de no-op del servidor: el `line_set_hash` coincide con el de la versión
        // vigente. Decirlo así evita que alguien busque un cambio que su archivo no trae.
        setAvisoSustitucion('El archivo tiene exactamente las mismas líneas que el manifiesto vigente: no hay nada que sustituir.');
        setSustitucion({ fase: 'ofrecida', manifestId });
        return;
      }
      setSustitucion({ fase: 'diff', manifestId, staged });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo preparar la sustitución.');
    }
  }

  /** Paso 3: aplica la versión con su motivo, re-corre el riesgo y enseña el resumen nuevo. */
  async function aplicarSustitucion() {
    if (!sustitucion) return;
    const manifestId = sustitucion.manifestId;
    setError(null);
    setSustitucion({ fase: 'aplicando', manifestId });
    setCurrent(2);
    setCheckedCount(0);
    try {
      await apiPost(`/api/manifests/${manifestId}/promote`, { motivo: motivoSustitucion.trim() });
      const risk = await apiPost<RiskResponse>(`/api/manifests/${manifestId}/risk`, {});
      setResult(risk);
      setSustitucion(null);
      setCheckedCount(VALIDATION_LABELS.length);
      setCurrent(3);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo aplicar la sustitución.');
      setSustitucion({ fase: 'ofrecida', manifestId });
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

      {avisoSustitucion && (
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-medium text-slate-700">
          {avisoSustitucion}
        </div>
      )}

      {/* Sustitución de manifiesto: los tres pasos viven aquí, encima del formulario, porque son la
          respuesta a lo que el usuario acaba de intentar y no un flujo aparte. */}
      {sustitucion && (
        <div className="space-y-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-4">
          <p className="flex items-center gap-2 text-sm font-semibold text-amber-900">
            <RefreshCw className="h-4 w-4 shrink-0" />
            Ya existe un manifiesto para esta guía. ¿Sustituirlo?
          </p>

          {sustitucion.fase === 'ofrecida' && (
            <div className="flex flex-wrap gap-2">
              <Button type="button" onClick={() => setSustitucion({ fase: 'motivo', manifestId: sustitucion.manifestId })}>
                Sustituirlo
              </Button>
              <Button variant="secondary" type="button" onClick={() => { setSustitucion(null); setAvisoSustitucion(null); }}>
                Cancelar
              </Button>
            </div>
          )}

          {sustitucion.fase === 'motivo' && (
            <div className="space-y-3">
              <Field label="Motivo de la sustitución" htmlFor="motivo-sustitucion">
                <Textarea
                  id="motivo-sustitucion"
                  rows={2}
                  value={motivoSustitucion}
                  onChange={(e) => setMotivoSustitucion(e.target.value)}
                  placeholder="Ej. El cliente reenvió el manifiesto con los valores corregidos."
                />
              </Field>
              {/* El motivo es obligatorio desde la v2 y lo exige también un CHECK de la tabla: un
                  documento que sustituye a otro sin decir por qué no es una corrección, es un
                  reemplazo sin expediente. */}
              <div className="flex flex-wrap gap-2">
                <Button type="button" disabled={!motivoSustitucion.trim()} onClick={verCambiosDeSustitucion}>
                  Ver cambios
                </Button>
                <Button variant="secondary" type="button" onClick={() => setSustitucion({ fase: 'ofrecida', manifestId: sustitucion.manifestId })}>
                  Atrás
                </Button>
              </div>
            </div>
          )}

          {sustitucion.fase === 'diff' && (
            <div className="space-y-3">
              <p className="text-sm text-slate-700">
                La versión v{sustitucion.staged.version} traería{' '}
                <span className="font-semibold">{sustitucion.staged.diff?.altas?.length ?? 0}</span> alta(s),{' '}
                <span className="font-semibold">{sustitucion.staged.diff?.bajas?.length ?? 0}</span> baja(s) y{' '}
                <span className="font-semibold">{sustitucion.staged.diff?.modificadas?.length ?? 0}</span> línea(s) modificada(s).
                {sustitucion.staged.diff?.sinCambio != null && ` ${sustitucion.staged.diff.sinCambio} sin cambio.`}
              </p>
              <p className="text-xs text-amber-800">
                Las bajas se retiran del manifiesto y el análisis de riesgo se vuelve a correr sobre las líneas nuevas.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button type="button" onClick={aplicarSustitucion}>Aplicar sustitución</Button>
                <Button variant="secondary" type="button" onClick={() => setSustitucion({ fase: 'motivo', manifestId: sustitucion.manifestId })}>
                  Atrás
                </Button>
              </div>
            </div>
          )}

          {sustitucion.fase === 'aplicando' && (
            <p className="text-sm font-medium text-amber-900">Aplicando la sustitución y recalculando el riesgo…</p>
          )}
        </div>
      )}

      {staging?.skippedSheets && staging.skippedSheets.length > 0 && (
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-xs font-medium text-slate-600">
          El archivo tiene varias hojas; se procesó «{staging.sheetName}». Hojas omitidas: {staging.skippedSheets.join(', ')}.
        </div>
      )}

      {unmappedHeaders.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs font-medium text-amber-800">
          Columnas no mapeadas: {unmappedHeaders.join(', ')}
        </div>
      )}

      {isAdmin && unmappedHeaders.length > 0 && (
        <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div>
            <p className="text-sm font-semibold text-slate-800">Mapear columnas no reconocidas</p>
            <p className="mt-1 text-xs text-slate-500">
              Asocia cada columna a un campo del sistema. Los mapeos guardados se aplicarán en la próxima carga de este manifiesto.
            </p>
          </div>

          <div className="inline-flex rounded-lg border border-slate-200 p-0.5 text-xs font-medium">
            <button
              type="button"
              onClick={() => setMappingScope('client')}
              disabled={!clientId}
              className={`rounded-md px-3 py-1.5 transition ${
                mappingScope === 'client' ? 'bg-navy-800 text-white' : 'text-slate-600 hover:bg-slate-50 disabled:opacity-50'
              }`}
            >
              Solo este cliente
            </button>
            <button
              type="button"
              onClick={() => setMappingScope('global')}
              className={`rounded-md px-3 py-1.5 transition ${
                mappingScope === 'global' ? 'bg-navy-800 text-white' : 'text-slate-600 hover:bg-slate-50'
              }`}
            >
              Global (todos los clientes)
            </button>
          </div>

          <ul className="space-y-3">
            {unmappedHeaders.map((h) => {
              const saved = savedHeaders.includes(h);
              return (
                <li key={h} className="flex flex-wrap items-center gap-3">
                  <span className="min-w-[9rem] flex-1 truncate text-sm font-medium text-slate-700" title={h}>{h}</span>
                  <div className="w-60">
                    <SearchSelect
                      value={mappingChoices[h] ?? ''}
                      onChange={(v) => setMappingChoices((prev) => ({ ...prev, [h]: v }))}
                      options={canonicalOptions}
                      placeholder="Selecciona un campo…"
                      disabled={saved}
                    />
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={!mappingChoices[h] || saved || savingHeader === h}
                    onClick={() => saveMapping(h)}
                  >
                    {saved ? 'Guardado' : savingHeader === h ? 'Guardando…' : 'Guardar'}
                  </Button>
                </li>
              );
            })}
          </ul>
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
          {/* El efectivo manda en pantalla y el crudo va debajo cuando difieren. Recién corrido el
              motor los dos coinciden casi siempre; tras una sustitución sobre un manifiesto con
              disposiciones vigentes, no necesariamente. */}
          <RiskSummary summary={result.summaryEfectivo ?? result.summary} motor={result.summary} />
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
