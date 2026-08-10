import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

/**
 * OUTBOUND MAIL (#22) — the one place this system speaks to the outside world by email.
 *
 * PRD-02 §10 recorded this as a hole: "tampoco hay librería de correo". Two requirements depend on
 * it and both have consequences outside the screen — `R18`, the risk requirement whose hard deadline
 * can stop a client's cargo, and `R19`/`N5`, the plan-change fan-out. So this module exists to make
 * the sending of a message a RECORDABLE FACT rather than a side effect: every call returns what
 * happened, and nothing in here ever throws.
 *
 * THE CONTRACT, AND WHY IT IS SHAPED LIKE THIS.
 *
 * 1. **It degrades, it does not fail.** SMTP is provisioned by a human (backlog #22 is a user task:
 *    an app password for `ops@capitalc.com.mx`). Until that happens `loadMailerConfig()` returns
 *    null and every send comes back `{ status: 'omitido' }` with a stated reason. A request path
 *    must never 500 because the mailbox is not set up yet — the operational record (the requerimiento,
 *    the plan) is the valuable thing, the email is the courtesy on top of it.
 *
 * 2. **`omitido` is not `enviado`, and callers must not conflate them.** From the plan's risk table:
 *    *"No arrancar el reloj sin confirmación de envío"* — do not start the clock on a deadline the
 *    client was never told about. Stopping cargo belonging to somebody who was never notified is the
 *    legal failure this whole feature is supposed to prevent, so the three outcomes are distinct
 *    values and the caller is forced to look at which one it got.
 *
 * 3. **It never throws.** An SMTP timeout, a DNS failure, a rejected recipient — all come back as
 *    `{ status: 'error' }` with the message. Callers persist that string; the next tick retries.
 *
 * CONFIG comes from the environment, in the naming style of the existing integrations
 * (`AGORA_*`, `FLIGHT_API_*`): `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`,
 * plus optional `SMTP_SECURE` and `SMTP_TIMEOUT_MS`. `SMTP_HOST` and `SMTP_FROM` are the minimum:
 * a host with no From address produces mail that most receivers silently drop, which is the worst
 * possible outcome — a send we would have recorded as successful.
 */

export interface MailerConfig {
  host: string;
  port: number;
  /** Implicit TLS (port 465). STARTTLS on 587 is negotiated by nodemailer with `secure: false`. */
  secure: boolean;
  user: string | null;
  pass: string | null;
  /** RFC5322 From. Accepts `Name <addr>` as well as a bare address. */
  from: string;
  timeoutMs: number;
}

export interface MailMessage {
  to: string;
  subject: string;
  /** Plain text is required; `html` is optional. A text/plain part always survives the trip. */
  text: string;
  html?: string;
  cc?: string;
  replyTo?: string;
}

/**
 * What happened, in the caller's vocabulary. `omitido` carries the reason so the row that records it
 * says "no SMTP configured" rather than an unexplained absence — an unexplained absence is
 * indistinguishable from someone quietly not telling the client.
 */
export type MailOutcome =
  | { status: 'enviado'; destinatario: string; messageId: string | null; aceptados: string[]; rechazados: string[] }
  | { status: 'omitido'; motivo: string }
  | { status: 'error'; error: string };

/** Read the config, or null when the operator has not provisioned SMTP yet. */
export function loadMailerConfig(): MailerConfig | null {
  const host = (process.env.SMTP_HOST ?? '').trim();
  const from = (process.env.SMTP_FROM ?? '').trim();
  if (!host || !from) return null;

  const port = Number(process.env.SMTP_PORT ?? 587) || 587;
  // Default derived from the port rather than defaulted to false: 465 is implicit TLS and 587 is
  // STARTTLS, and getting that pairing wrong is the classic "hangs until timeout" misconfiguration.
  const secureRaw = (process.env.SMTP_SECURE ?? '').trim().toLowerCase();
  const secure = secureRaw ? secureRaw === 'true' || secureRaw === '1' : port === 465;

  const user = (process.env.SMTP_USER ?? '').trim() || null;
  const pass = process.env.SMTP_PASS ?? null;
  const timeoutMs = Number(process.env.SMTP_TIMEOUT_MS ?? 20_000) || 20_000;

  return { host, port, secure, user, pass, from, timeoutMs };
}

/** Everything that identifies a transport, so a changed env var rebuilds it instead of being ignored. */
function fingerprint(cfg: MailerConfig): string {
  return [cfg.host, cfg.port, cfg.secure, cfg.user ?? '', cfg.from, cfg.timeoutMs].join('|');
}

let cached: { key: string; transporter: Transporter } | null = null;

/**
 * One pooled transport per configuration.
 *
 * Pooled because the expiry sweep can notify a batch of casos in a single tick and a fresh TCP+TLS
 * handshake per message is how a five-minute scheduled task turns into a two-minute one. Keyed on the
 * config fingerprint so a rotated password or a changed host takes effect on the next call rather
 * than living on in a stale connection pool.
 */
function getTransporter(cfg: MailerConfig): Transporter {
  const key = fingerprint(cfg);
  if (cached && cached.key === key) return cached.transporter;
  cached?.transporter.close?.();
  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    ...(cfg.user ? { auth: { user: cfg.user, pass: cfg.pass ?? '' } } : {}),
    pool: true,
    maxConnections: 2,
    connectionTimeout: cfg.timeoutMs,
    greetingTimeout: cfg.timeoutMs,
    socketTimeout: cfg.timeoutMs,
  });
  cached = { key, transporter };
  return transporter;
}

/**
 * Drop the pooled transport. Exported for tests and for a future credential-rotation endpoint; the
 * pool holds sockets open, and a test process that never closes them does not exit.
 */
export function resetMailer(): void {
  cached?.transporter.close?.();
  cached = null;
}

/** Is outbound mail available at all? Callers use it to word a UI hint, never to decide correctness. */
export function mailerConfigurado(): boolean {
  return loadMailerConfig() !== null;
}

const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Send one message. NEVER throws.
 *
 * The recipient is validated here rather than at the call site because every caller resolves it from
 * data (a client record, a prealerta sender) and a malformed address must be reported as a skipped
 * send with a reason, not as an exception in the middle of a ledger write.
 */
export async function sendMail(msg: MailMessage): Promise<MailOutcome> {
  const to = (msg.to ?? '').trim();
  if (!to) {
    console.warn(`[mailer] envío omitido — sin destinatario · asunto: ${msg.subject}`);
    return { status: 'omitido', motivo: 'sin destinatario' };
  }
  if (!RE_EMAIL.test(to)) {
    console.warn(`[mailer] envío omitido — destinatario inválido «${to}» · asunto: ${msg.subject}`);
    return { status: 'omitido', motivo: `destinatario inválido: ${to}` };
  }

  const cfg = loadMailerConfig();
  if (!cfg) {
    // Logged at warn, once per attempt, and deliberately loud about the consequence: the operator
    // reading the container log has to be able to see what did not get sent while SMTP was missing.
    console.warn(
      `[mailer] SMTP no configurado (falta SMTP_HOST/SMTP_FROM) — envío OMITIDO a ${to} · asunto: ${msg.subject}`,
    );
    return { status: 'omitido', motivo: 'SMTP no configurado (SMTP_HOST/SMTP_FROM)' };
  }

  try {
    const info = await getTransporter(cfg).sendMail({
      from: cfg.from,
      to,
      subject: msg.subject,
      text: msg.text,
      ...(msg.html ? { html: msg.html } : {}),
      ...(msg.cc ? { cc: msg.cc } : {}),
      ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
    });
    // `accepted`/`rejected` are `Array<string | Address>` depending on how the caller wrote the
    // envelope; normalized to plain addresses so the persisted record is one shape.
    const direcciones = (lista: unknown): string[] =>
      (Array.isArray(lista) ? lista : []).map((a) =>
        typeof a === 'string' ? a : String((a as { address?: string })?.address ?? a),
      );
    const aceptados = direcciones(info.accepted);
    const rechazados = direcciones(info.rejected);
    // A server that accepted the envelope but rejected every recipient is a FAILED send. Reporting it
    // as `enviado` would let a deadline start running against a client who never got the message.
    if (!aceptados.length) {
      return {
        status: 'error',
        error: `el servidor SMTP rechazó a todos los destinatarios: ${rechazados.join(', ') || to}`,
      };
    }
    console.info(`[mailer] enviado a ${aceptados.join(', ')} · asunto: ${msg.subject}`);
    return {
      status: 'enviado',
      destinatario: to,
      messageId: info.messageId ?? null,
      aceptados,
      rechazados,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[mailer] falló el envío a ${to} · asunto: ${msg.subject}:`, error);
    return { status: 'error', error };
  }
}
