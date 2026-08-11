import { Fragment, useState } from 'react';
import { AlertTriangle, History, Loader2, ShieldAlert } from 'lucide-react';
import { StatusPill, Textarea } from './ui';
import { apiPost, ApiError } from '../api';
import { useAuthOptional } from '../context/AuthContext';
import type { ReasonCodePublico, DisposicionPublica } from '../../shared/types/reports';

export type RiskResultado = 'verde' | 'amarillo' | 'rojo' | 'gris';

/**
 * Una línea de la tabla de riesgo.
 *
 * TODO LO DE LA FASE 4 ES OPCIONAL, Y NO POR PEREZA: esta misma tabla la pinta el paso «Resultado»
 * del alta (`RegistroView`) con las filas que devuelve `POST /api/manifests/:id/risk`, que es la
 * respuesta del motor recién corrido y no lleva disposiciones ni historia — no puede llevarlas,
 * porque acaban de nacer. Con los campos opcionales, esa pantalla sigue funcionando exactamente
 * igual y la de `reports.json` gana los tags, el popover y la acción.
 */
export interface RiskRow {
  mwb: string;
  guide: string;
  consignee: string;
  senderCity: string;
  senderCountry: string;
  /** Descripción de la mercancía (traducida al español cuando aplica). */
  description?: string;
  /** El color EFECTIVO — el que manda en el pill. */
  resultado: RiskResultado;
  motivo: string;
  /** Fase 4 — presentes sólo en el bundle de `reports.json`. */
  shipmentId?: string;
  resultadoMotor?: RiskResultado;
  resultadoAnterior?: RiskResultado | null;
  versionAnterior?: number | null;
  datoCambio?: boolean;
  reasons?: ReasonCodePublico[];
  disposiciones?: DisposicionPublica[];
  revalidacionPendiente?: boolean;
}

export interface RiskSummaryData {
  analizados: number;
  aprobados: number;
  noIdentificados: number;
  validarEnPrevio: number;
  sinDatos?: number;
}

/**
 * Los cuatro cubos, contados sobre el color EFECTIVO.
 *
 * `motor` es el mismo recuento sobre la palabra cruda. Sólo se pinta la cifra secundaria en los
 * cubos donde de verdad difieren: enseñar «6 (motor: 6)» en toda la fila sería ruido, y enseñar
 * sólo el efectivo cuando difiere sería esconder que un humano movió el número.
 */
export function RiskSummary({ summary, motor }: { summary: RiskSummaryData; motor?: RiskSummaryData }) {
  const buckets: { label: string; value: number; crudo?: number; accent: string; dot: string }[] = [
    { label: 'Analizados',         value: summary.analizados,       crudo: motor?.analizados,      accent: 'text-slate-900',    dot: 'bg-slate-400'   },
    { label: 'Aprobados',          value: summary.aprobados,        crudo: motor?.aprobados,       accent: 'text-emerald-600',  dot: 'bg-emerald-500' },
    { label: 'No identificados',   value: summary.noIdentificados,  crudo: motor?.noIdentificados, accent: 'text-amber-600',    dot: 'bg-amber-500'   },
    { label: 'Validar en previo',  value: summary.validarEnPrevio,  crudo: motor?.validarEnPrevio, accent: 'text-red-600',      dot: 'bg-red-500'     },
  ];
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
      {buckets.map((b) => (
        <div key={b.label} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex items-center gap-1.5">
            <span className={`h-1.5 w-1.5 rounded-full ${b.dot}`} />
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{b.label}</div>
          </div>
          <div className={`mt-1.5 text-3xl font-bold tracking-tight tabular-nums ${b.accent}`}>{b.value}</div>
          {b.crudo != null && b.crudo !== b.value && (
            <div className="mt-0.5 text-xs text-slate-500 tabular-nums">motor: {b.crudo}</div>
          )}
        </div>
      ))}
    </div>
  );
}

// =================================================================================================
// La compuerta de rol, en el navegador
// =================================================================================================

const ESCALA: Record<string, number> = { capturista: 1, admin: 2, super_admin: 3 };
const SENALES_FORZADAS = new Set(['prohibidos', 'pirateria']);

type EstadoDisposicion = 'falso_positivo' | 'mitigado' | 'confirmado';

const ETIQUETA_ESTADO: Record<EstadoDisposicion, string> = {
  falso_positivo: 'Falso positivo',
  mitigado: 'Mitigado',
  confirmado: 'Confirmado',
};

/**
 * El MISMO escalón que `server/src/routes/riesgoDisposiciones.ts`, repetido aquí a propósito.
 *
 * No es la autoridad —el servidor decide y responde 403 nombrando el rol que sí podría— sino la
 * cortesía: deshabilitar el botón CON EL MOTIVO ESCRITO es mucho mejor que dejar pulsar y contestar
 * «Forbidden». Si las dos copias divergieran, la que manda sigue siendo la del servidor y el peor
 * síntoma sería un botón habilitado que responde 403; nunca lo contrario.
 */
function compuertaDeRol(args: {
  rol: string | null;
  estado: EstadoDisposicion;
  reason: ReasonCodePublico | null;
  colorMotor: RiskResultado;
}): { ok: boolean; requerido: string; motivo: string } {
  const nivel = args.rol ? (ESCALA[args.rol] ?? 0) : 0;
  const permitir = (requerido: string, motivo: string) => ({ ok: nivel >= ESCALA[requerido], requerido, motivo });

  if (args.estado === 'confirmado') return permitir('capturista', 'confirmar un hallazgo (no suprime nada)');
  if (!args.reason) return permitir('capturista', 'disponer un hallazgo');
  if (args.reason.signalId === 'denied_party') {
    return permitir('super_admin', 'suprimir una coincidencia en lista de sancionados');
  }
  if (args.reason.forcesBand === 'rojo' || SENALES_FORZADAS.has(args.reason.signalId)) {
    return permitir('admin', `suprimir un hallazgo que fuerza rojo (${args.reason.signalId})`);
  }
  if (args.colorMotor === 'rojo') {
    return permitir('admin', 'suprimir un hallazgo en una línea que el motor calificó roja');
  }
  return permitir('capturista', 'suprimir un hallazgo en una línea que el motor no calificó roja');
}

/** Los 409/403 del servidor, dichos en la lengua del usuario y no en la de la API. */
const MENSAJE_ERROR: Record<string, string> = {
  sin_hallazgo_vigente: 'Esa señal ya no dispara en esta línea. Vuelva a cargar el análisis.',
  analisis_rancio: 'El análisis está desactualizado: los datos cambiaron después de la última corrida. Vuelva a correr el análisis de riesgo antes de disponer.',
  hallazgo_ambiguo: 'Esa señal disparó más de una vez en esta línea; no se puede identificar el hallazgo.',
};

function mensajeDeError(err: unknown): string {
  if (err instanceof ApiError) {
    const codigo = typeof err.body.error === 'string' ? err.body.error : '';
    if (MENSAJE_ERROR[codigo]) return MENSAJE_ERROR[codigo];
    if (err.status === 403) {
      const rol = typeof err.body.rolRequerido === 'string' ? err.body.rolRequerido : null;
      return rol ? `Su rol no alcanza: se requiere ${rol}.` : 'Su rol no alcanza para disponer este hallazgo.';
    }
    return err.message;
  }
  return err instanceof Error ? err.message : 'No se pudo registrar la disposición.';
}

// =================================================================================================
// Etiquetas: la gramática visual de dos causas distintas (§ «Ajuste posterior» del diseño)
// =================================================================================================

const TAG = 'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase transition';
/** ÁMBAR = afirmación humana. Es el mismo lenguaje del badge `Override` de `PrealertasView`. */
const TAG_DISPUESTO = `${TAG} bg-amber-100 text-amber-700 hover:bg-amber-200`;
/** NEUTRO = corrección de documento. Nadie afirmó nada; cambió el manifiesto. */
const TAG_VERSION = `${TAG} bg-slate-100 text-slate-600 hover:bg-slate-200`;

const BADGE_AMBAR = 'inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-700 ring-1 ring-inset ring-amber-600/20';

function fecha(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' });
}

/**
 * La historia de una línea: por qué su color es el que es.
 *
 * SE ABRE CON CLIC, NUNCA CON HOVER. La pantalla de riesgo se revisa en tablet junto al pallet, y un
 * popover que sólo existe mientras hay un puntero encima es un popover que en tablet no existe.
 *
 * Se renderiza como una FILA EXPANDIDA y no como un `absolute`: el contenedor de la tabla lleva
 * `overflow-x-auto` para que quepan las columnas, y cualquier capa flotante dentro de una celda
 * quedaría recortada por ese contenedor justo cuando hay scroll horizontal, que es siempre en
 * tablet. Visualmente es el mismo panel; estructuralmente no puede cortarse.
 */
function PopoverHistoria({ row, version }: { row: RiskRow; version?: number }) {
  const disposiciones = row.disposiciones ?? [];
  const versionActual = version != null ? `v${version}` : 'la versión vigente';
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-md">
      <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-500">
        <History className="h-3.5 w-3.5" /> Historia de la línea {row.guide}
      </p>

      <div className="mt-3 space-y-1 text-sm text-slate-700">
        <p>
          El motor calificó <span className="font-semibold">{row.resultadoMotor ?? row.resultado}</span>
          {row.resultadoMotor && row.resultadoMotor !== row.resultado && (
            <> · efectivo tras las disposiciones: <span className="font-semibold">{row.resultado}</span></>
          )}
        </p>
      </div>

      {row.resultadoAnterior && (
        <div className="mt-3 rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-700">
          <p>
            En la v{row.versionAnterior} esta línea era{' '}
            <span className="font-semibold">{row.resultadoAnterior}</span>; en {versionActual} es{' '}
            <span className="font-semibold">{row.resultadoMotor ?? row.resultado}</span>.
          </p>
          {/* El matiz que sale gratis del `row_hash` de bronce y que evita una llamada telefónica:
              `agregado`, `direcciones` y `bbdd` son señales ENTRE filas, así que una línea puede
              cambiar de color con su renglón intacto. */}
          <p className="mt-1 text-xs text-slate-500">
            {row.datoCambio === false
              ? `Su dato no cambió; cambió el conjunto en la ${versionActual}.`
              : `Su dato cambió en la ${versionActual}.`}
          </p>
        </div>
      )}

      {disposiciones.length > 0 && (
        <ul className="mt-3 space-y-2">
          {disposiciones.map((d) => (
            <li key={d.id} className="rounded-md border border-amber-200 bg-amber-50/60 px-3 py-2 text-sm">
              <p className="font-semibold text-amber-800">
                {ETIQUETA_ESTADO[d.estado]} · {d.signalId}
                {d.revalidacionPendiente && <span className="ml-2 text-xs font-bold uppercase">Revalidar</span>}
              </p>
              <p className="mt-0.5 text-slate-700">{d.motivo}</p>
              <p className="mt-0.5 text-xs text-slate-500">
                {d.createdByUsuario ?? d.createdBy ?? 'sistema'} · {fecha(d.createdAt)}
              </p>
            </li>
          ))}
        </ul>
      )}

      {disposiciones.length === 0 && !row.resultadoAnterior && (
        <p className="mt-3 text-sm text-slate-500">Sin disposiciones ni correcciones: el color es el del motor.</p>
      )}
    </div>
  );
}

/**
 * El formulario de disposición, EN LÍNEA y en dos pasos.
 *
 * Sin modal anidado: el workspace los quitó a propósito y el patrón de casa es el confirmar-en-línea
 * del borrado de pedimento (`CaptureWorkspace`). Paso 1, se compone la afirmación (qué hallazgo, qué
 * se afirma, por qué); paso 2, se confirma. Tapar una bandera de aduana no debería costar un solo
 * clic distraído.
 */
function FormularioDisponer({
  row,
  manifestId,
  onHecho,
  onCancelar,
}: {
  row: RiskRow;
  manifestId: string;
  onHecho: () => void;
  onCancelar: () => void;
}) {
  const auth = useAuthOptional();
  const rol = auth?.user?.role ?? null;
  const reasons = row.reasons ?? [];
  const [signalId, setSignalId] = useState<string>(reasons[0]?.signalId ?? '');
  const [estado, setEstado] = useState<EstadoDisposicion>('falso_positivo');
  const [motivo, setMotivo] = useState('');
  const [requerimientoId, setRequerimientoId] = useState('');
  const [confirmando, setConfirmando] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reason = reasons.find((r) => r.signalId === signalId) ?? null;
  const compuerta = compuertaDeRol({ rol, estado, reason, colorMotor: row.resultadoMotor ?? row.resultado });

  /**
   * `mitigado` exige evidencia: el CHECK de la tabla pide `evidencia_file_id` O `requerimiento_id`.
   * Esta pantalla ofrece el requerimiento porque es lo que ya existe en el backend; no hay superficie
   * de subida de evidencia colgada del riesgo, y inventar una aquí sería construir media función.
   * «El hallazgo era real y está resuelto» sin nada que lo respalde no es una mitigación, es un
   * falso positivo mal etiquetado — y para eso está la otra opción.
   */
  const faltaEvidencia = estado === 'mitigado' && !requerimientoId.trim();
  const bloqueo = !reason
    ? 'Esta línea no tiene hallazgos vigentes que disponer.'
    : !compuerta.ok
      ? `Su rol (${rol ?? 'sin sesión'}) no alcanza para ${compuerta.motivo}. Se requiere ${compuerta.requerido}.`
      : !motivo.trim()
        ? 'El motivo es obligatorio.'
        : faltaEvidencia
          ? 'Una mitigación necesita citar un requerimiento que la respalde.'
          : null;

  async function enviar() {
    setBusy(true);
    setError(null);
    try {
      await apiPost(`/api/manifests/${manifestId}/riesgo/disposiciones`, {
        shipmentId: row.shipmentId,
        signalId,
        estado,
        motivo: motivo.trim(),
        ...(requerimientoId.trim() ? { requerimientoId: requerimientoId.trim() } : {}),
      });
      onHecho();
    } catch (err) {
      setError(mensajeDeError(err));
      setConfirmando(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-md">
      <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Disponer un hallazgo — guía {row.guide}</p>

      {reasons.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">Esta línea no tiene hallazgos vigentes que disponer.</p>
      ) : (
        <div className="mt-3 space-y-4">
          <fieldset>
            <legend className="mb-1.5 text-xs font-bold uppercase tracking-wide text-slate-600">Hallazgo</legend>
            <div className="space-y-1.5">
              {reasons.map((r) => (
                <label key={r.signalId} className="flex cursor-pointer items-start gap-2 text-sm text-slate-700">
                  <input
                    type="radio"
                    name={`hallazgo-${row.shipmentId}`}
                    checked={signalId === r.signalId}
                    onChange={() => { setSignalId(r.signalId); setConfirmando(false); }}
                    className="mt-1"
                  />
                  <span>
                    <span className="font-medium text-slate-800">{r.detail}</span>
                    <span className="ml-1.5 text-xs text-slate-500">({r.signalId})</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend className="mb-1.5 text-xs font-bold uppercase tracking-wide text-slate-600">Qué se afirma</legend>
            <div className="flex flex-wrap gap-4">
              {(Object.keys(ETIQUETA_ESTADO) as EstadoDisposicion[]).map((e) => (
                <label key={e} className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
                  <input
                    type="radio"
                    name={`estado-${row.shipmentId}`}
                    checked={estado === e}
                    onChange={() => { setEstado(e); setConfirmando(false); }}
                  />
                  {ETIQUETA_ESTADO[e]}
                </label>
              ))}
            </div>
          </fieldset>

          <div>
            <label htmlFor={`motivo-${row.shipmentId}`} className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-slate-600">
              Motivo
            </label>
            <Textarea
              id={`motivo-${row.shipmentId}`}
              rows={3}
              value={motivo}
              onChange={(e) => { setMotivo(e.target.value); setConfirmando(false); }}
              placeholder="Por qué el motor se equivocó, o cómo se resolvió el hallazgo."
            />
          </div>

          {estado === 'mitigado' && (
            <div>
              <label htmlFor={`req-${row.shipmentId}`} className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-slate-600">
                Requerimiento que lo respalda
              </label>
              <input
                id={`req-${row.shipmentId}`}
                value={requerimientoId}
                onChange={(e) => { setRequerimientoId(e.target.value); setConfirmando(false); }}
                placeholder="Id del requerimiento emitido al cliente"
                className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-navy-500 focus:ring-2 focus:ring-navy-500/25"
              />
            </div>
          )}

          {error && (
            <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700">{error}</p>
          )}
          {bloqueo && !error && <p className="text-xs font-medium text-amber-700">{bloqueo}</p>}

          <div className="flex flex-wrap items-center gap-2">
            {confirmando ? (
              <>
                <span className="text-xs font-medium text-amber-800">¿Registrar esta disposición? Queda en el expediente y no se borra.</span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={enviar}
                  className="inline-flex items-center gap-1.5 rounded-md bg-amber-600 px-2.5 py-1 text-xs font-semibold text-white transition hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  Confirmar
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setConfirmando(false)}
                  className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-semibold text-slate-600 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Cancelar
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  disabled={!!bloqueo}
                  onClick={() => setConfirmando(true)}
                  className="rounded-md bg-navy-800 px-2.5 py-1 text-xs font-semibold text-white transition hover:bg-navy-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Registrar disposición
                </button>
                <button
                  type="button"
                  onClick={onCancelar}
                  className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-semibold text-slate-600 transition hover:bg-slate-100"
                >
                  Cerrar
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function RiskResultTable({
  rows,
  manifestId,
  version,
  onDisposicion,
}: {
  rows: RiskRow[];
  /** Sin él no hay acción `Disponer`: no hay a dónde mandar la afirmación. */
  manifestId?: string;
  /** `manifests.version_vigente` — el número que el popover nombra como «la vN». */
  version?: number;
  /** El panel vuelve a pedir el bundle: el color efectivo lo acaba de reescribir el servidor. */
  onDisposicion?: () => void;
}) {
  const [historia, setHistoria] = useState<number | null>(null);
  const [disponiendo, setDisponiendo] = useState<number | null>(null);
  const puedeDisponer = Boolean(manifestId);

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="overflow-x-auto">
        <table className="min-w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
              <th className="px-4 py-3">MWB</th>
              <th className="px-4 py-3">Guía</th>
              <th className="px-4 py-3">Destinatario</th>
              <th className="px-4 py-3">Descripción de la mercancía</th>
              <th className="px-4 py-3">Resultado</th>
              <th className="px-4 py-3">Disposición</th>
              <th className="px-4 py-3">Motivo</th>
              {puedeDisponer && <th className="px-4 py-3" />}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r, i) => {
              const disposiciones = r.disposiciones ?? [];
              const abierta = historia === i || disponiendo === i;
              return (
                <Fragment key={`${r.mwb}-${i}`}>
                  <tr className="align-top text-slate-700 transition-colors hover:bg-slate-50/70">
                    <td className="px-4 py-3 font-mono text-xs text-slate-600">{r.mwb}</td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-600">{r.guide}</td>
                    <td className="px-4 py-3 font-medium text-slate-800">{r.consignee}</td>
                    <td className="px-4 py-3">{r.description || '—'}</td>
                    <td className="px-4 py-3">
                      <StatusPill resultado={r.resultado} />
                      {/* LA PALABRA DEL MOTOR NUNCA DESAPARECE DE LA PANTALLA. Cuando el efectivo y
                          el crudo difieren es porque alguien afirmó algo, y el veredicto original
                          tiene que seguir siendo legible sin abrir nada. */}
                      {r.resultadoMotor && r.resultadoMotor !== r.resultado && (
                        <div className="mt-1 text-xs text-slate-500">motor: {r.resultadoMotor}</div>
                      )}
                      <div className="mt-1 flex flex-wrap gap-1">
                        {disposiciones.length > 0 && (
                          <button
                            type="button"
                            className={TAG_DISPUESTO}
                            aria-expanded={historia === i}
                            onClick={() => { setHistoria(historia === i ? null : i); setDisponiendo(null); }}
                          >
                            Dispuesto
                          </button>
                        )}
                        {r.resultadoAnterior && (
                          <button
                            type="button"
                            className={TAG_VERSION}
                            aria-expanded={historia === i}
                            onClick={() => { setHistoria(historia === i ? null : i); setDisponiendo(null); }}
                          >
                            v{version ?? r.versionAnterior}
                          </button>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {disposiciones.map((d) => (
                          <span key={d.id} className={BADGE_AMBAR}>{ETIQUETA_ESTADO[d.estado]}</span>
                        ))}
                        {r.revalidacionPendiente && (
                          <span className={BADGE_AMBAR}>
                            <AlertTriangle className="h-3.5 w-3.5" /> Revalidar
                          </span>
                        )}
                        {disposiciones.length === 0 && !r.revalidacionPendiente && <span className="text-slate-400">—</span>}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-slate-600">{r.motivo}</td>
                    {puedeDisponer && (
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          onClick={() => { setDisponiendo(disponiendo === i ? null : i); setHistoria(null); }}
                          className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 transition hover:bg-slate-100"
                        >
                          <ShieldAlert className="h-3.5 w-3.5" /> Disponer
                        </button>
                      </td>
                    )}
                  </tr>
                  {abierta && (
                    <tr className="bg-slate-50/60">
                      <td colSpan={puedeDisponer ? 8 : 7} className="px-4 py-3">
                        {historia === i && <PopoverHistoria row={r} version={version} />}
                        {disponiendo === i && manifestId && (
                          <FormularioDisponer
                            row={r}
                            manifestId={manifestId}
                            onHecho={() => { setDisponiendo(null); onDisposicion?.(); }}
                            onCancelar={() => setDisponiendo(null)}
                          />
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
