import { sendMail, type MailOutcome } from './mailer';
import { sendWhatsapp, type WhatsappOutcome } from './whatsapp';

/**
 * NOTIFICATION FAN-OUT — one recipient list, two channels, one honest record (PRD-02 `R19`/`N5`,
 * Adenda A §6.3, backlog #22 + #31).
 *
 * WHAT THIS IS FOR. Two features owe messages to people outside this system and both had the same
 * hole: the plan publication (`routes/planeacion.ts`) stored a `destinatarios` list and answered
 * *"pendiente: el envío requiere el fan-out (#31)"*, and the contingency engine
 * (`services/replanService.ts`) recorded `NOTIFICACION_REQUERIDA` obligations nothing ever acted on.
 * Both now come through here. `services/whatsappFanout.ts` remains the INTERNAL `dirección` ping
 * keyed on ledger-event significance; this module is the OUTBOUND leg to named recipients, on
 * whichever channel each recipient's handle implies.
 *
 * THE CHANNEL IS DERIVED FROM THE HANDLE, NOT CONFIGURED. `plan_publicaciones.destinatarios` is a
 * free-form `string[]` — that is what the schema accepts and what the coordinator types — so a
 * recipient is classified by shape: something that parses as an email goes by SMTP, something that
 * parses as a phone number goes over WhatsApp, and anything else comes back `omitido` NAMING ITSELF.
 * The alternative (guessing, or silently dropping) is how a warehouse ends up never told about a
 * republished plan while the record says the plan was distributed.
 *
 * THE DISCIPLINE, INHERITED FROM `mailer.ts` AND `whatsapp.ts` AND NOT WEAKENED HERE:
 *
 *  1. **Never throws.** Every function returns what happened. These calls run after a write that has
 *     already committed — a published plan, a ledger event — and a notification side channel must
 *     never put a committed fact at risk.
 *  2. **`omitido` is not `enviado`.** The three outcomes stay distinct all the way into the response
 *     body and the stored payload. A caller that collapses them would report a plan as distributed
 *     when SMTP is not provisioned.
 *  3. **The obligation and the delivery are DIFFERENT FACTS, recorded separately.** Callers record
 *     "this had to be sent" in the ledger, inside their transaction; this module reports "this is
 *     what happened when we tried", afterwards. Nothing here ever rewrites the obligation.
 *
 * SYNCHRONOUS, NOT QUEUED — the same call this codebase already made in `mailer.ts` and
 * `whatsappFanout.ts`: a handful of sends per publication or per tick, never a campaign.
 */

export type CanalNotificacion = 'email' | 'whatsapp';

/** What happened for ONE recipient. The `canal` is null when the handle matched neither shape. */
export interface EnvioResultado {
  destino: string;
  canal: CanalNotificacion | null;
  estado: 'enviado' | 'omitido' | 'error';
  /** Human-readable, in Spanish, and always populated — including on success. */
  detalle: string;
}

export interface MensajeNotificacion {
  /** Used as the email subject. WhatsApp has no subject line, so it is prefixed onto the text. */
  asunto: string;
  texto: string;
}

const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** A phone as a human writes it: optional `+`, then 8–15 digits once punctuation is stripped. */
const RE_TELEFONO = /^\+?\d{8,15}$/;

/**
 * Which channel a recipient handle implies, or null when it implies none.
 *
 * Exported because it is the rule that decides whether somebody gets told at all, and it is worth
 * testing without an SMTP server or a WhatsApp session.
 */
export function clasificarDestino(raw: string): CanalNotificacion | null {
  const v = (raw ?? '').trim();
  if (!v) return null;
  if (RE_EMAIL.test(v)) return 'email';
  if (RE_TELEFONO.test(v.replace(/[\s()\-.]/g, ''))) return 'whatsapp';
  return null;
}

/** Normalize the outcome vocabularies of the two channel modules into one shape. */
function desdeCorreo(destino: string, outcome: MailOutcome): EnvioResultado {
  if (outcome.status === 'enviado') {
    return { destino, canal: 'email', estado: 'enviado', detalle: `enviado a ${outcome.aceptados.join(', ')}` };
  }
  if (outcome.status === 'omitido') {
    return { destino, canal: 'email', estado: 'omitido', detalle: outcome.motivo };
  }
  return { destino, canal: 'email', estado: 'error', detalle: outcome.error };
}

function desdeWhatsapp(destino: string, outcome: WhatsappOutcome): EnvioResultado {
  if (outcome.status === 'enviado') {
    return { destino, canal: 'whatsapp', estado: 'enviado', detalle: `enviado a ${outcome.destinatario}` };
  }
  if (outcome.status === 'omitido') {
    return { destino, canal: 'whatsapp', estado: 'omitido', detalle: outcome.motivo };
  }
  return { destino, canal: 'whatsapp', estado: 'error', detalle: outcome.error };
}

/**
 * Send one message to one recipient over whichever channel its handle implies. NEVER throws.
 *
 * An unrecognized handle is `omitido` with the handle quoted back, not a silent drop: "we could not
 * tell who «almacén NLU» is" is actionable, an absence is not.
 */
export async function enviarNotificacion(
  destino: string,
  mensaje: MensajeNotificacion,
): Promise<EnvioResultado> {
  const limpio = (destino ?? '').trim();
  try {
    const canal = clasificarDestino(limpio);
    if (!canal) {
      console.warn(
        `[notificaciones] destinatario no reconocido «${limpio || '(vacío)'}» — envío OMITIDO · ${mensaje.asunto}`,
      );
      return {
        destino: limpio,
        canal: null,
        estado: 'omitido',
        detalle: `destinatario no reconocido como correo ni teléfono: «${limpio || '(vacío)'}»`,
      };
    }
    if (canal === 'email') {
      return desdeCorreo(limpio, await sendMail({ to: limpio, subject: mensaje.asunto, text: mensaje.texto }));
    }
    // WhatsApp has no subject field; the subject becomes the first line so both channels carry the
    // same headline and a reader comparing them does not find two different statements of one fact.
    return desdeWhatsapp(
      limpio,
      await sendWhatsapp({ to: limpio, text: `${mensaje.asunto}\n\n${mensaje.texto}` }),
    );
  } catch (err) {
    // Neither channel module throws, so reaching here means something genuinely unexpected. It is
    // still reported rather than raised: the fact being announced is already committed.
    const error = err instanceof Error ? err.message : String(err);
    console.warn(`[notificaciones] falló el envío a ${limpio}:`, error);
    return { destino: limpio, canal: null, estado: 'error', detalle: error };
  }
}

/**
 * Fan one message out to a list, de-duplicated, in order. NEVER throws.
 *
 * De-duplication matters because the recipient list is typed by a human and the same warehouse
 * address arriving twice would send two messages and record two outcomes for one obligation.
 */
export async function enviarNotificaciones(
  destinos: readonly string[],
  mensaje: MensajeNotificacion,
): Promise<EnvioResultado[]> {
  const vistos = new Set<string>();
  const unicos: string[] = [];
  for (const d of destinos ?? []) {
    const v = (d ?? '').trim();
    if (!v || vistos.has(v.toLowerCase())) continue;
    vistos.add(v.toLowerCase());
    unicos.push(v);
  }
  const salidas: EnvioResultado[] = [];
  for (const d of unicos) salidas.push(await enviarNotificacion(d, mensaje));
  return salidas;
}

export interface ResumenEnvios {
  intentados: number;
  enviados: number;
  omitidos: number;
  errores: number;
}

/**
 * The counts a caller puts in an API response or an audit payload.
 *
 * Deliberately FOUR numbers and not a boolean: "the plan went out" is not a fact this system can
 * state when two of five recipients were skipped for want of SMTP, and a summary that could not
 * express that would be the same lie the `'pendiente…'` placeholder was replacing.
 */
export function resumirEnvios(resultados: readonly EnvioResultado[]): ResumenEnvios {
  return {
    intentados: resultados.length,
    enviados: resultados.filter((r) => r.estado === 'enviado').length,
    omitidos: resultados.filter((r) => r.estado === 'omitido').length,
    errores: resultados.filter((r) => r.estado === 'error').length,
  };
}

/**
 * The standing rosters, by role, from the environment.
 *
 * `almacen`, `coordinacion` and `direccion` are not rows in any table — they are the operation's own
 * people and its warehouse counterpart, provisioned the way every other integration in this codebase
 * is (`SMTP_*`, `AGORA_*`, `EVOLUTION_*`): comma-separated handles, of either shape, mixed freely.
 * `direccion` falls back to `WHATSAPP_INTERNAL_NUMBERS` so the roster #31 already provisioned keeps
 * working without being typed a second time.
 *
 * An unset variable yields an empty list, and an empty list makes every caller report `omitido` with
 * the variable's name — the "config-gated services never throw, and say what is missing" rule.
 */
export function contactosDeRol(rol: 'almacen' | 'coordinacion' | 'direccion'): string[] {
  const porRol: Record<typeof rol, string[]> = {
    almacen: [process.env.NOTIFICACION_ALMACEN ?? ''],
    coordinacion: [process.env.NOTIFICACION_COORDINACION ?? ''],
    direccion: [process.env.NOTIFICACION_DIRECCION ?? '', process.env.WHATSAPP_INTERNAL_NUMBERS ?? ''],
  };
  const vistos = new Set<string>();
  const salida: string[] = [];
  for (const bruto of porRol[rol]) {
    for (const parte of bruto.split(',')) {
      const v = parte.trim();
      if (!v || vistos.has(v.toLowerCase())) continue;
      vistos.add(v.toLowerCase());
      salida.push(v);
    }
  }
  return salida;
}

/** The env var a caller names when a role's roster is empty, so the log says what to provision. */
export const VARIABLE_DE_ROL: Record<'almacen' | 'coordinacion' | 'direccion', string> = {
  almacen: 'NOTIFICACION_ALMACEN',
  coordinacion: 'NOTIFICACION_COORDINACION',
  direccion: 'NOTIFICACION_DIRECCION / WHATSAPP_INTERNAL_NUMBERS',
};
