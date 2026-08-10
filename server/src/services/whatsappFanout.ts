import { sendWhatsapp, whatsappConfigurado, type WhatsappOutcome } from './whatsapp';
import { formatearEvento } from './agoraMirror';

/**
 * WHATSAPP FAN-OUT (#31) — the second channel PRD-02's AGORA addendum names twice:
 *
 *  - §6.3 (R18 bounce mitigation): *"Un requerimiento sin acuse a las N horas escala: segundo canal
 *    (WhatsApp por evolution-api) y aviso interno a dirección."*
 *  - The frontier table (R19/N5): plan-change notices to almacén/transportista/cliente go
 *    *"también por WhatsApp"*.
 *
 * SCOPE DECISION — read this before adding a `tipo`. R19's literal trigger, a published plan version
 * (`plan_publicaciones`), does not exist yet: despacho/planeación is backlog item #29. There is
 * nothing to fan out to almacén/transportista until that ships. What DOES exist today, and already
 * changes what can be planned, is the freeze layer: a global hold ("todo está parado", CT-6), a
 * retención (CT-5), and a risk deadline that expired and opened one (CT-4). `TIPOS_AVISO_INTERNO`
 * below is the internal-to-`dirección` half of the two PRD lines above, generalized from "when the
 * plan changes" to "when the freeze layer changes what can be planned" — the only concrete instance
 * of that sentence this codebase can act on right now. Wire R19's client/almacén/transportista leg
 * here once #29 lands a real plan-change event.
 *
 * The client-facing escalation half (§6.3's "segundo canal") is intentionally NOT event-driven the
 * same way: `escalarPorWhatsapp` below is called directly from `requerimientosService.ts`, the one
 * place that already resolves a client contact and already gates a legal deadline on delivery
 * confirmation. "Sin acuse a las N horas" is approximated as "the primary channel did not confirm
 * delivery" rather than a new acknowledgement timer, because there is no acknowledgement capture in
 * this codebase — that is AGORA's `ConversationParser`, itself unbuilt (PRD-02 Adenda A §4). This
 * reuses the exact invariant `requerimientosService.ts` already enforces for the deadline clock
 * (`notificado_at` stays null without a confirmed send), just extended one step: no confirmation on
 * the primary channel is precisely when the second channel is supposed to fire.
 *
 * SYNCHRONOUS, NOT QUEUED — same decision as `mailer.ts` / `agoraMirror.ts`: volume here is a
 * handful of sends per tick or per human action, not a campaign, so a send is awaited inline and its
 * outcome handed back to the caller (who logs/records it) rather than pushed to a background worker.
 * Revisit if a future channel needs real throughput.
 *
 * BOTH FUNCTIONS BELOW NEVER THROW — the same invariant `mirrorEventoToAgora` holds: a notification
 * side channel must never put a write that already committed at risk.
 */

const TIPOS_AVISO_INTERNO = new Set<string>([
  // CT-6 — "todo está parado". The single most disruptive event in the system; internal management
  // has to know even if nobody is watching the AGORA inbox at that moment.
  'HOLD_GLOBAL_ABIERTO',
  'HOLD_GLOBAL_CERRADO',
  // CT-5 — the authority pulled a pallet. Changes what a truck can carry today.
  'RETENCION_CREADA',
  // CT-4 — a client's risk deadline ran out; a hold now blocks the operación from being planned.
  'REQUERIMIENTO_VENCIDO',
]);

/**
 * Is this ledger event worth an internal WhatsApp ping? Exported for the same reason
 * `esEventoEspejable` is: it is a product decision (which facts reach `dirección` outside AGORA),
 * not an implementation detail, and it is unit-testable without a database or an HTTP stub.
 */
export function esEventoAvisableInterno(tipo: string): boolean {
  return TIPOS_AVISO_INTERNO.has(tipo);
}

/** `WHATSAPP_INTERNAL_NUMBERS` — comma-separated phone numbers for the internal "dirección" roster. */
function numerosInternos(): string[] {
  return (process.env.WHATSAPP_INTERNAL_NUMBERS ?? '')
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);
}

export interface AvisoInternoInput {
  /** Included as a short prefix so the internal roster can tell casos apart at a glance. Omit for a
   *  global event (a global hold has no single operación). */
  operacionId?: string | null;
  tipo: string;
  /** The same payload the ledger row carries — reused verbatim by `formatearEvento` (agoraMirror.ts)
   *  so the WhatsApp line and the AGORA note never say two different things about the same fact. */
  payloadResumen: Record<string, unknown>;
}

/**
 * Best-effort internal WhatsApp ping for a plan-changing ledger event.
 *
 * Returns one outcome per configured internal number (empty array when the event is not
 * significant, WhatsApp is unconfigured, or no roster is set). Never throws.
 */
export async function avisarInternoPorEvento(input: AvisoInternoInput): Promise<WhatsappOutcome[]> {
  try {
    if (!esEventoAvisableInterno(input.tipo)) return [];

    const numeros = numerosInternos();
    if (!numeros.length) {
      // Only worth a log line when WhatsApp itself IS configured — otherwise this is the ordinary
      // "channel not provisioned" case sendWhatsapp already logs loudly for every other caller.
      if (whatsappConfigurado()) {
        console.warn(
          `[whatsappFanout] ${input.tipo} — WHATSAPP_INTERNAL_NUMBERS vacío, aviso interno OMITIDO`,
        );
      }
      return [];
    }

    const prefijo = input.operacionId ? `[${input.operacionId.slice(0, 8)}] ` : '';
    const texto = `${prefijo}${formatearEvento(input.tipo, input.payloadResumen)}`;

    const salidas: WhatsappOutcome[] = [];
    for (const to of numeros) {
      salidas.push(await sendWhatsapp({ to, text: texto }));
    }
    return salidas;
  } catch (err) {
    console.warn(`[whatsappFanout] no se pudo avisar internamente ${input.tipo}:`, err);
    return [];
  }
}

/**
 * Client-side escalation — §6.3's "segundo canal". Called by `requerimientosService.ts` right after
 * it tries the primary channel (email): fires only when the primary channel did NOT confirm
 * delivery. `enviado` means the client was told and there is nothing to escalate; `omitido`/`error`
 * is exactly the "sin confirmación de envío" state that already keeps the deadline clock from
 * starting — the same fact, read a second time to decide whether to try a second channel.
 */
export async function escalarPorWhatsapp(params: {
  telefono: string | null;
  canalPrimarioEstado: 'enviado' | 'omitido' | 'error';
  texto: string;
}): Promise<WhatsappOutcome | null> {
  if (params.canalPrimarioEstado === 'enviado') return null;
  if (!params.telefono) return null;
  // sendWhatsapp never throws — no try/catch needed here, unlike the AGORA mirror calls it sits
  // alongside, which wrap a client that CAN throw (agoraClient.ts's postMessage).
  return sendWhatsapp({ to: params.telefono, text: params.texto });
}
