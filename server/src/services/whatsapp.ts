/**
 * OUTBOUND WHATSAPP (#31) — the second notification channel, over a self-hosted `evolution-api`
 * instance that already runs on the customs Coolify project (PRD-02 Adenda A §4, §6.3).
 *
 * WHY THIS EXISTS, AND WHY IT IS SHAPED LIKE `mailer.ts` (#22). The AGORA addendum's bounce
 * mitigation (§6.3) says it in one sentence: *"Un requerimiento sin acuse a las N horas escala:
 * segundo canal (WhatsApp por evolution-api, que ya corre) y aviso interno a dirección."* — the
 * frontier table repeats the same instruction for R19/N5's plan-change notices. So this module is
 * the second leg of the exact contract `mailer.ts` already established for the first: sending is a
 * RECORDABLE FACT with three honest outcomes, never a side effect that can silently vanish or crash
 * a request path.
 *
 * THE CONTRACT — deliberately identical in shape to mailer.ts, so a caller reasons about both
 * channels the same way:
 *
 * 1. **It degrades, it does not fail.** `evolution-api` is provisioned by ops
 *    (`EVOLUTION_API_URL`/`EVOLUTION_API_KEY`/`EVOLUTION_INSTANCE`). Until all three are set,
 *    `loadWhatsappConfig()` returns null and every send comes back `{ status: 'omitido' }` with a
 *    stated reason. A tick sweep or an ingest path must never fail because the WhatsApp instance is
 *    not wired up — the ledger row and the primary-channel attempt are what matter; WhatsApp is the
 *    escalation on top of them.
 *
 * 2. **`omitido` is not `enviado`, and callers must not conflate them.** Exactly as in mailer.ts: a
 *    caller that treats `omitido` as success would believe an unanswered client was reached on the
 *    second channel when nothing went out.
 *
 * 3. **It never throws.** A DNS failure, an evolution-api timeout, a non-2xx response — all come
 *    back as `{ status: 'error' }` with the message. Callers log it; nothing here unwinds a
 *    transaction or a request that already committed.
 *
 * WHAT THIS IS NOT: a queue, a session manager, or a chat SDK. `evolution-api` exposes a plain HTTP
 * REST surface in front of a WhatsApp session; this module POSTs one text message to it and reports
 * what happened. See `whatsappFanout.ts` for why a synchronous call — not a queue — is the right
 * choice at this system's volume (a handful of sends per tick, never a campaign).
 */

export interface WhatsappConfig {
  baseUrl: string;
  apiKey: string;
  /** The evolution-api "instance" name — one WhatsApp session, addressed by name in every call. */
  instance: string;
  timeoutMs: number;
}

export interface WhatsappMessage {
  /** Phone number, any punctuation; normalized before use (digits, optional leading `+`). */
  to: string;
  text: string;
}

/**
 * What happened, in the caller's vocabulary — the same three-outcome shape as `MailOutcome`
 * (`mailer.ts`), so a caller checking one channel's result reads the other identically.
 */
export type WhatsappOutcome =
  | { status: 'enviado'; destinatario: string; messageId: string | null }
  | { status: 'omitido'; motivo: string }
  | { status: 'error'; error: string };

/** Read the config, or null when evolution-api has not been provisioned yet. */
export function loadWhatsappConfig(): WhatsappConfig | null {
  const baseUrl = (process.env.EVOLUTION_API_URL ?? '').trim();
  const apiKey = (process.env.EVOLUTION_API_KEY ?? '').trim();
  const instance = (process.env.EVOLUTION_INSTANCE ?? '').trim();
  if (!baseUrl || !apiKey || !instance) return null;

  const timeoutMs = Number(process.env.EVOLUTION_API_TIMEOUT_MS ?? 15_000) || 15_000;
  return { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey, instance, timeoutMs };
}

/** Is outbound WhatsApp available at all? For a UI hint only, never to decide correctness. */
export function whatsappConfigurado(): boolean {
  return loadWhatsappConfig() !== null;
}

// Digits with an optional leading '+', 8–15 digits long — the E.164 length bound. Loose on purpose:
// this system does not own phone-number formatting (clients.phone is free text, per catalogs.ts), so
// the gate here is "plausibly a phone number", not a strict national-format validator.
const RE_TELEFONO = /^\+?[0-9]{8,15}$/;

function normalizarTelefono(raw: string): string {
  return raw.replace(/[\s().-]/g, '');
}

/**
 * Send one WhatsApp text message. NEVER throws.
 *
 * The recipient is validated here, not at the call site, for the same reason mailer.ts validates
 * `to`: every caller resolves it from data (a client record, an internal roster) and a malformed
 * number must come back as a skipped send with a reason, not as an exception in the middle of a
 * ledger write or a tick sweep.
 */
export async function sendWhatsapp(msg: WhatsappMessage): Promise<WhatsappOutcome> {
  const to = normalizarTelefono((msg.to ?? '').trim());
  if (!to) {
    console.warn('[whatsapp] envío omitido — sin destinatario');
    return { status: 'omitido', motivo: 'sin destinatario' };
  }
  if (!RE_TELEFONO.test(to)) {
    console.warn(`[whatsapp] envío omitido — destinatario inválido «${to}»`);
    return { status: 'omitido', motivo: `destinatario inválido: ${to}` };
  }

  const cfg = loadWhatsappConfig();
  if (!cfg) {
    // Loud and specific, exactly like mailer.ts's skip log: the operator reading the container log
    // has to be able to see what did not go out on the second channel while evolution-api was unset.
    console.warn(
      `[whatsapp] evolution-api no configurado (falta EVOLUTION_API_URL/EVOLUTION_API_KEY/EVOLUTION_INSTANCE) — envío OMITIDO a ${to}`,
    );
    return {
      status: 'omitido',
      motivo: 'evolution-api no configurado (EVOLUTION_API_URL/EVOLUTION_API_KEY/EVOLUTION_INSTANCE)',
    };
  }

  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), cfg.timeoutMs);
    let res: Response;
    try {
      // evolution-api's text-send endpoint: POST /message/sendText/{instance}, `apikey` header,
      // `{ number, text }` body. See PRD-02 Adenda A §4/§6.3.
      res = await fetch(`${cfg.baseUrl}/message/sendText/${encodeURIComponent(cfg.instance)}`, {
        method: 'POST',
        signal: ac.signal,
        headers: { 'Content-Type': 'application/json', apikey: cfg.apiKey },
        body: JSON.stringify({ number: to, text: msg.text }),
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return {
        status: 'error',
        error: `evolution-api respondió ${res.status}${body ? `: ${body.slice(0, 300)}` : ''}`,
      };
    }

    const data = (await res.json().catch(() => null)) as { key?: { id?: string } } | null;
    console.info(`[whatsapp] enviado a ${to}`);
    return { status: 'enviado', destinatario: to, messageId: data?.key?.id ?? null };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[whatsapp] falló el envío a ${to}:`, error);
    return { status: 'error', error };
  }
}
