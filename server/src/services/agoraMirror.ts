// Mirror of the operations tracking into the AGORA conversation (task #24).
//
// THE DECISION THIS FILE ENCODES: mirror, do not move. `customs` stays the system of record — the
// append-only `operacion_eventos` ledger and the audit hash chain are what an auditor re-derives a
// finding from, and AGORA incinerates inbound mail after 30 days, so it can never hold the record.
// What AGORA *is* is the human workspace: the place where the coordinator already has the client's
// thread open. So the significant facts are echoed there as PRIVATE notes (internal, never sent to the
// client) plus a small set of conversation custom_attributes, and nothing here is ever load-bearing.
//
// TWO INVARIANTS, both non-negotiable:
//
//  1. NEVER THROW. Every function here swallows its own failures. A mirror is decoration; a mirror
//     failure that unwound a committed caso, or bubbled a 500 to the tramitador pressing a field
//     button, would make the human workspace more authoritative than the record — precisely backwards.
//     Callers still get a boolean so they can log/assert, but they never need a try/catch.
//
//  2. SELECTIVITY OVER COMPLETENESS. A thread that stutters gets muted by humans, and a muted thread
//     is worse than no mirror at all. So the five-minute VUELO_ACTUALIZADO poll is NOT mirrored, and
//     COTEJO_EJECUTADO / RIESGO_EVALUADO are mirrored only when they actually carry something a person
//     has to act on. `esEventoEspejable` is the single place that judgement lives.

import { query } from '../db/pool';
import {
  loadAgoraConfig,
  postMessage,
  setConversationCustomAttributes,
  type AgoraConfig,
} from './agoraClient';
import type { Discrepancia } from '../../../shared/operaciones/cotejo';

export interface MirrorEventoInput {
  operacionId: string;
  /** `operaciones.agora_conversation_id`. Null for a caso that never came in through AGORA. */
  agoraConversationId: string | null;
  tipo: string;
  /** The same payload the ledger row carries, or the subset needed to word the line. */
  payloadResumen: Record<string, unknown>;
}

/**
 * Events mirrored unconditionally.
 *
 * The campo seven because they are the only sensor this system has for the middle of an operation and
 * the coordinator's next action depends on each of them; the three flight-state changes because a
 * delay or a cancellation changes everyone's plan for the day. Deliberately ABSENT:
 *
 *  - VUELO_ACTUALIZADO — emitted by a four-minute poll. Mirroring it would post dozens of near
 *    identical notes per shipment and train humans to ignore the thread.
 *  - PREALERTA_RECIBIDA / PREALERTA_VERSIONADA — the prealerta email IS the AGORA message that
 *    triggered them. Echoing it back into its own thread says nothing new.
 *  - EVIDENCIA_CAPTURADA — the photo lives behind auth in customs; a note saying one exists without
 *    the image adds noise. Revisit if/when the mirror can attach the file itself.
 */
const TIPOS_ESPEJO_SIEMPRE = new Set<string>([
  // the campo seven (PRD-02 R30–R35)
  'CARGA_DISPONIBLE',
  'INGRESO_PATIO',
  'INGRESO_ADUANA',
  'INICIO_CARGA',
  'FIN_CARGA',
  'MODULACION',
  'SALIDA_ROJO',
  // flight facts that change the plan
  'ARRIBO_VUELO',
  'VUELO_DEMORADO',
  'VUELO_CANCELADO',
  // The freeze layer (routes/holds.ts). A freeze is the single most important thing an ops human can
  // learn from the thread: it means "do not request a unit", and requesting one anyway is the flete en
  // falso the hold exists to prevent (CT-6). The CLOSES are mirrored for the same reason inverted — a
  // freeze nobody knows was lifted keeps cargo parked. Human-initiated and rare, so no noise risk.
  'HOLD_GLOBAL_ABIERTO',
  'HOLD_GLOBAL_CERRADO',
  'RETENCION_CREADA',
  // The risk requirement with a hard deadline (R18/D13) and its CT-4 expiry. All three are mirrored:
  // the emission is a promise made to the client on the team's behalf, the expiry is a freeze, and
  // the resolution is what tells a coordinator the cargo can move again. Rare and human-consequential,
  // which is exactly the bar for the shared inbox.
  'REQUERIMIENTO_EMITIDO',
  'REQUERIMIENTO_VENCIDO',
  'REQUERIMIENTO_RESUELTO',
  // The contingency engine's plan-changing conclusions (CT-1…CT-7). Mirrored because they answer the
  // question the thread exists for — "is this shipment going out today?" — and because a reassignment
  // proposal is waiting on a human: an unread proposal IS the flete en falso. Deduplicated at the
  // source by `claveAccion`, so a cancelled flight posts one note, not one every five minutes.
  // NOTIFICACION_REQUERIDA is deliberately absent: several fire per contingency and the notice itself
  // is what #31 will send, so mirroring the obligation would double the noise for zero new fact.
  'OPERACION_EXCLUIDA_DEL_PLAN',
  'OPERACION_REPROGRAMADA',
  'REASIGNACION_PROPUESTA',
  // Delivery, signed or refused (R39). This is the answer to the question the thread was opened
  // with — "did my cargo arrive?" — and it is the one fact in the whole chain produced by somebody
  // OUTSIDE this organisation. POD_GENERADO and POD_ENVIADO are deliberately absent: producing a
  // document is our own housekeeping, and a regeneration would post a note saying nothing changed.
  'POD_FIRMADO',
  'POD_RECHAZADO',
  // a best-effort ingest step that failed — the whole point is that it stops being invisible
  'INGESTA_INCIDENCIA',
]);

function discrepanciasDe(payload: Record<string, unknown>): Discrepancia[] {
  const raw = payload.discrepancias;
  return Array.isArray(raw) ? (raw as Discrepancia[]) : [];
}

/**
 * Is this event worth a human's attention in the shared inbox?
 *
 * Exported because it is a product decision, not an implementation detail: it is the thing to argue
 * about when someone says the thread is too noisy or too quiet, and it is unit-testable without a
 * database or an HTTP stub.
 */
export function esEventoEspejable(tipo: string, payload: Record<string, unknown> = {}): boolean {
  if (TIPOS_ESPEJO_SIEMPRE.has(tipo)) return true;

  // A cotejo run that found nothing (or only informativas — including a demoted inferred-value
  // finding, see cotejo.ts) is a clean bill of health. It belongs in the ledger, not in the inbox.
  if (tipo === 'COTEJO_EJECUTADO') {
    return discrepanciasDe(payload).some((d) => d.severidad === 'error');
  }

  // Risk is mirrored only when the engine actually demands documents before the previo. `riesgo_ok`
  // needs no human, and posting it would dilute the ones that do.
  if (tipo === 'RIESGO_EVALUADO') {
    const summary = payload.summary as { validarEnPrevio?: unknown } | undefined;
    return Number(summary?.validarEnPrevio ?? 0) > 0;
  }

  return false;
}

/**
 * Timestamps are formatted in the operation's local timezone, not UTC.
 *
 * A note reading "aterrizó 07 ago 21:03" when the coordinator watched it land at 15:03 destroys trust
 * in the mirror faster than a missing note would. Overridable because the AICM/AIFA operation is
 * America/Mexico_City today and a second aduana would not be.
 */
function zonaOperacion(): string {
  return process.env.OPS_TIMEZONE || 'America/Mexico_City';
}

/** `07 ago 15:03`. Returns null for anything unparseable, so callers can drop the fragment. */
export function fechaCorta(value: unknown): string | null {
  if (typeof value !== 'string' && !(value instanceof Date)) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat('es-MX', {
      timeZone: zonaOperacion(),
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(d);
    const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
    const mes = get('month').replace(/\.$/, '');
    return `${get('day')} ${mes} ${get('hour')}:${get('minute')}`;
  } catch {
    // A bad TZ name must not cost us the note.
    return d.toISOString().slice(0, 16).replace('T', ' ');
  }
}

/** Minutes between the reported time and now, when the gap is worth stating. */
function retrasoCaptura(ocurridoAt: unknown): string {
  const iso = typeof ocurridoAt === 'string' ? Date.parse(ocurridoAt) : NaN;
  if (!Number.isFinite(iso)) return '';
  const min = Math.round((Date.now() - iso) / 60000);
  // R33: phones are prohibited at the semáforo, so a late capture is CORRECT input. Saying how late
  // makes the delay a recorded fact instead of a silent distortion of the timeline.
  return min >= 1 ? ` (capturado ${min} min después)` : '';
}

function conFecha(base: string, ocurridoAt: unknown): string {
  const f = fechaCorta(ocurridoAt);
  return f ? `${base} ${f}` : base;
}

/** Up to three error-severity findings, worded for a human skimming an inbox. */
function lineaCotejo(payload: Record<string, unknown>): string {
  const errores = discrepanciasDe(payload).filter((d) => d.severidad === 'error');
  const piezas = errores.slice(0, 3).map((d) => {
    const det = (d.detalle ?? {}) as Record<string, unknown>;
    const campo = typeof det.campo === 'string' ? det.campo : null;
    if (campo && det.declarado !== undefined && det.manifiesto !== undefined) {
      return `${d.codigo}: ${campo} ${String(det.declarado)} vs manifiesto ${String(det.manifiesto)}`;
    }
    return `${d.codigo}: ${d.mensaje}`;
  });
  const resto = errores.length > 3 ? ` (+${errores.length - 3} más)` : '';
  return `⚠️ COTEJO — ${piezas.join(' · ')}${resto}`;
}

/**
 * One compact Spanish line per event type. A map rather than a switch so an unknown tipo has an
 * obvious, honest fallback instead of silently producing nothing: a mirror that drops facts it does
 * not recognize is how a timeline quietly diverges from the record.
 */
const FORMATEADORES: Record<string, (p: Record<string, unknown>) => string> = {
  CARGA_DISPONIBLE: (p) =>
    conFecha('📦 CARGA_DISPONIBLE — el almacén liberó la carga', p.ocurridoAt),
  INGRESO_PATIO: (p) => {
    const demora = typeof p.demoraMin === 'number' ? ` (cita ${p.demoraMin >= 0 ? '+' : ''}${p.demoraMin} min)` : '';
    return `${conFecha('🚛 INGRESO_PATIO — unidad en patio regulador', p.ocurridoAt)}${demora}`;
  },
  INGRESO_ADUANA: (p) => conFecha('🏛️ INGRESO_ADUANA — unidad dentro de la aduana', p.ocurridoAt),
  INICIO_CARGA: (p) => conFecha('⏳ INICIO_CARGA — inició la carga', p.ocurridoAt),
  FIN_CARGA: (p) => conFecha('✅ FIN_CARGA — terminó la carga', p.ocurridoAt),
  MODULACION: (p) => {
    const sem = p.semaforo === 'red' ? '🔴' : p.semaforo === 'green' ? '🟢' : '⚪';
    return `${sem} MODULACION — semáforo ${String(p.semaforo ?? 'sin resultado')}${retrasoCaptura(p.ocurridoAt)}`;
  },
  SALIDA_ROJO: (p) => {
    const enRojo = typeof p.tiempoEnRojoMin === 'number' ? ` — ${p.tiempoEnRojoMin} min en rojo` : '';
    return `${conFecha('🟢 SALIDA_ROJO — salió de reconocimiento', p.ocurridoAt)}${enRojo}`;
  },
  ARRIBO_VUELO: (p) => {
    const vuelo = typeof p.numeroVuelo === 'string' ? p.numeroVuelo : 'el vuelo';
    return conFecha(`🛬 ARRIBO_VUELO — ${vuelo} aterrizó`, p.arriboReal ?? p.ocurridoAt ?? new Date().toISOString());
  },
  VUELO_DEMORADO: (p) => {
    const vuelo = typeof p.numeroVuelo === 'string' ? p.numeroVuelo : 'el vuelo';
    const eta = fechaCorta(p.etaEstimado);
    return `🕐 VUELO_DEMORADO — ${vuelo} demorado${eta ? `, nuevo ETA ${eta}` : ''}`;
  },
  VUELO_CANCELADO: (p) => {
    const vuelo = typeof p.numeroVuelo === 'string' ? p.numeroVuelo : 'el vuelo';
    return `⛔ VUELO_CANCELADO — ${vuelo} cancelado${p.fuente ? ` (fuente ${String(p.fuente)})` : ''}`;
  },
  // R39. The POD folio is quoted because it is what the client's warehouse writes on the paper, and
  // a coordinator chasing a signature asks for it by that string.
  POD_FIRMADO: (p) => {
    const quien = typeof p.firmadoPor === 'string' && p.firmadoPor ? ` por ${p.firmadoPor}` : '';
    return conFecha(`📝 POD FIRMADO ${String(p.folio ?? '')}${quien} — entrega completada`, p.firmadoAt ?? p.ocurridoAt);
  },
  POD_RECHAZADO: (p) =>
    `⛔ POD RECHAZADO ${String(p.folio ?? '')} — el cliente NO recibió: ${String(p.motivo ?? 'sin motivo')}`,
  COTEJO_EJECUTADO: lineaCotejo,
  RIESGO_EVALUADO: (p) => {
    const s = (p.summary ?? {}) as Record<string, unknown>;
    const total = s.total ?? s.evaluadas ?? null;
    return (
      `🚩 RIESGO — ${String(s.validarEnPrevio ?? 0)} partida(s)` +
      `${total !== null ? ` de ${String(total)}` : ''} requieren validación en previo`
    );
  },
  // The freeze layer. `efecto` is the operational consequence holds.ts already spells out in every
  // payload, and it is the sentence a coordinator actually needs — so it is quoted verbatim rather than
  // paraphrased here, where it could drift from the ledger.
  HOLD_GLOBAL_ABIERTO: (p) =>
    `🧊 HOLD GLOBAL — se congela la planeación (${String(p.tipoHold ?? 'hold')}): ` +
    `${String(p.motivo ?? 'sin motivo')}. ${String(p.efecto ?? '')}`.trim(),
  HOLD_GLOBAL_CERRADO: (p) => {
    const aun = Number(p.operacionesAunBloqueadas ?? 0);
    return (
      `♻️ HOLD GLOBAL CERRADO — ${String(p.efecto ?? 'se reanuda la planeación.')}` +
      (aun > 0 ? ` ${aun} caso(s) siguen con hold propio.` : '')
    );
  },
  RETENCION_CREADA: (p) => {
    const que = p.guia ? `guía ${String(p.guia)}` : `alcance ${String(p.alcance ?? 'operación')}`;
    const oficio = p.oficioReferencia ? ` (oficio ${String(p.oficioReferencia)})` : '';
    return `🚫 RETENCIÓN — la autoridad retuvo ${que}${oficio}: ${String(p.motivo ?? 'sin motivo')}`;
  },
  // R18. The deadline is the whole message — a note that says "requerimiento emitido" without saying
  // by when is not actionable. `notificacion` is spelled out because `omitida` means the client has
  // NOT been told and the clock is not running (SMTP unprovisioned, #22).
  REQUERIMIENTO_EMITIDO: (p) => {
    const guia = p.guia ? ` guía ${String(p.guia)}` : '';
    const plazo = fechaCorta(p.venceAt);
    const aviso = p.notificacion === 'enviado' ? '' : ` · ⚠️ cliente NO notificado (${String(p.notificacion ?? 'sin envío')})`;
    return `📄 REQUERIMIENTO — riesgo${guia}: el cliente debe resolver${plazo ? ` antes del ${plazo}` : ''}${aviso}`;
  },
  REQUERIMIENTO_VENCIDO: (p) => {
    const guia = p.guia ? ` guía ${String(p.guia)}` : '';
    return `⏰ REQUERIMIENTO VENCIDO${guia} — ${String(p.efecto ?? 'se abre hold de riesgo (CT-4).')}`;
  },
  REQUERIMIENTO_RESUELTO: (p) => {
    const guia = p.guia ? ` guía ${String(p.guia)}` : '';
    const tiempo = p.aTiempo === false ? ' (fuera de plazo, aceptado)' : '';
    const sigue = p.holdActivo ? ' · la operación sigue con hold' : '';
    return `✅ REQUERIMIENTO RESUELTO${guia}${tiempo} — riesgo liberado${sigue}`;
  },
  INGESTA_INCIDENCIA: (p) =>
    `🛠️ INGESTA_INCIDENCIA — falló el paso «${String(p.paso ?? 'desconocido')}»: ${String(p.error ?? 'sin detalle')}`,
  // The contingency engine. `motivo` is the engine's own Spanish sentence and is quoted rather than
  // paraphrased, for the same reason `efecto` is above: the note and the ledger must not drift.
  OPERACION_EXCLUIDA_DEL_PLAN: (p) =>
    `📤 FUERA DEL PLAN (${String(p.contingencia ?? 'CT')}) — ${String(p.motivo ?? 'sin motivo')}`,
  OPERACION_REPROGRAMADA: (p) =>
    `📅 REPROGRAMADA (${String(p.contingencia ?? 'CT-1')}) — nueva fecha ${String(p.nuevaFecha ?? 'por definir')}. ` +
    `${String(p.motivo ?? '')}`.trim(),
  // R19 / N5. The version number and the DELTA are the message: a republication that does not say
  // what changed is the emailed second workbook with better storage. Read by the internal WhatsApp
  // roster too (`whatsappFanout.ts`), which is why it must stand alone without the plan open.
  PLAN_PUBLICADO: (p) => {
    const v = p.version ? ` v${String(p.version)}` : '';
    const fecha = p.fechaOperacion ? ` del ${String(p.fechaOperacion)}` : '';
    const motivo = p.motivo ? ` · motivo: ${String(p.motivo)}` : '';
    return `🗓️ PLAN PUBLICADO${v}${fecha} — ${String(p.resumen ?? 'sin resumen de cambios')}${motivo}`;
  },
  // The engine recorded that somebody HAS to be told (CT-1…CT-6). It is not a claim that they were:
  // the delivery attempt is a separate fact, recorded on the replan action's payload.
  NOTIFICACION_REQUERIDA: (p) =>
    `📣 AVISO REQUERIDO (${String(p.contingencia ?? 'CT')}) → ${String(p.destinatario ?? 'destinatario')} — ` +
    `${String(p.motivo ?? '')}`.trim(),
  REASIGNACION_PROPUESTA: (p) => {
    const candidatas = Array.isArray(p.candidatas) ? p.candidatas.length : 0;
    return (
      `🔁 REASIGNACIÓN PROPUESTA (CT-7) — requiere confirmación: compromete tarifa. ` +
      `${candidatas} candidata(s). ${String(p.motivo ?? '')}`.trim()
    );
  },
};

/** Chatwoot accepts long content; a wall of text in an inbox is still unreadable. */
const MAX_NOTA = 900;

export function formatearEvento(tipo: string, payload: Record<string, unknown> = {}): string {
  const fmt = FORMATEADORES[tipo];
  const linea = fmt
    ? fmt(payload)
    : // Generic fallback, deliberately still informative: tipo + timestamp beats silence.
      conFecha(`• ${tipo}`, payload.ocurridoAt ?? new Date().toISOString());
  return linea.length > MAX_NOTA ? `${linea.slice(0, MAX_NOTA - 1)}…` : linea;
}

/**
 * Echo one ledger event into the conversation as a PRIVATE note.
 *
 * `private: true` matters twice over: the note is internal (the client must never receive our raw
 * operational chatter), and prealertaIngest ignores private messages, so the mirror cannot feed itself
 * back through the webhook and create a phantom prealerta.
 *
 * Returns true only when a note was actually posted; false for "not configured", "no conversation",
 * "not significant" and "AGORA rejected it" alike. Never throws.
 */
export async function mirrorEventoToAgora(input: MirrorEventoInput): Promise<boolean> {
  try {
    const cfg = loadAgoraConfig();
    if (!cfg || !input.agoraConversationId) return false;
    if (!esEventoEspejable(input.tipo, input.payloadResumen)) return false;

    await postMessage(cfg, input.agoraConversationId, {
      content: formatearEvento(input.tipo, input.payloadResumen),
      private: true,
    });
    return true;
  } catch (err) {
    console.warn(
      `[agoraMirror] no se pudo espejar ${input.tipo} de la operación ${input.operacionId}:`,
      err,
    );
    return false;
  }
}

/**
 * The conversation's customs context, as the inbox shows it in the sidebar.
 *
 * `banderas` is the discrepancy COUNT rather than a boolean so a filter can sort by it, and because
 * "3 banderas" tells a coordinator more than "sí".
 */
export interface EstadoEspejo {
  mawb: string;
  operacion_id: string;
  etapa: string;
  semaforo?: string | null;
  vuelo_estado?: string | null;
  banderas?: number;
}

/**
 * Stamp the whole attribute set onto the conversation.
 *
 * `setConversationCustomAttributes` REPLACES the set rather than merging it (see its doc comment), so
 * this takes the FULL intended state and every caller must pass everything it wants to survive —
 * which is exactly why `mirrorEstadoDeOperacion` below exists and why call sites should prefer it over
 * hand-assembling a partial `attrs`. Undefined values are dropped so an unknown field reads as absent
 * instead of as the literal string "undefined" in the sidebar.
 */
export async function mirrorEstadoToAgora(input: {
  agoraConversationId: string | null;
  attrs: EstadoEspejo;
}): Promise<boolean> {
  try {
    const cfg = loadAgoraConfig();
    if (!cfg || !input.agoraConversationId) return false;
    const attrs: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input.attrs)) {
      if (v !== undefined && v !== null) attrs[k] = v;
    }
    await setConversationCustomAttributes(cfg, input.agoraConversationId, attrs);
    return true;
  } catch (err) {
    console.warn('[agoraMirror] no se pudieron escribir custom_attributes en AGORA:', err);
    return false;
  }
}

/**
 * Read the caso's current state and stamp it, in one call.
 *
 * The convenient form, and the correct one: because the Chatwoot endpoint replaces the attribute set,
 * assembling it from anything other than the live row is how `semaforo` set by the field capture gets
 * silently erased by the next flight poll.
 */
export async function mirrorEstadoDeOperacion(operacionId: string): Promise<boolean> {
  try {
    if (!loadAgoraConfig()) return false;
    const { rows } = await query<{
      mawb: string;
      agora_conversation_id: string | null;
      etapa: string;
      semaforo: string | null;
      vuelo_estado: string | null;
      banderas: string | number | null;
    }>(
      `SELECT o.mawb,
              o.agora_conversation_id,
              o.etapa,
              o.semaforo,
              v.estado AS vuelo_estado,
              COALESCE(jsonb_array_length(o.discrepancias), 0) AS banderas
         FROM operaciones o
         LEFT JOIN vuelos v ON v.id = o.vuelo_id
        WHERE o.id = $1`,
      [operacionId],
    );
    const op = rows[0];
    if (!op || !op.agora_conversation_id) return false;

    return await mirrorEstadoToAgora({
      agoraConversationId: op.agora_conversation_id,
      attrs: {
        mawb: op.mawb,
        operacion_id: operacionId,
        etapa: op.etapa,
        semaforo: op.semaforo,
        vuelo_estado: op.vuelo_estado,
        banderas: Number(op.banderas ?? 0),
      },
    });
  } catch (err) {
    console.warn(`[agoraMirror] no se pudo espejar el estado de ${operacionId}:`, err);
    return false;
  }
}

export type { AgoraConfig };
