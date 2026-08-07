import { query } from '../db/pool';
import { recordAudit } from './audit';
import { loadAgoraConfig, type AgoraConfig } from './agoraClient';
import { ingestPrealerta, type AgoraWebhookPayload } from './prealertaIngest';

/**
 * Reconciliation sweep for missed AGORA webhooks (PRD-02 Adenda A; the reason
 * `integracion_cursores` exists at all).
 *
 * THE WEBHOOK IS A NOTIFICATION, NOT A GUARANTEE. AGORA's `Webhooks::Trigger` is a single RestClient
 * POST with a ~5s timeout and only Sidekiq's default retries behind it, so an AGORA restart or a
 * customs deploy inside a flight window can drop a prealerta with no trace on either side — and a
 * dropped prealerta is cargo nobody planned for. This sweep is the safety net: it periodically asks
 * AGORA for recent messages on the prealertas inbox and reprocesses anything whose Message-ID we
 * have never seen. AGORA itself reconciles the same way (`supra_reconcile_pending_tramites_job`), so
 * this is the house idiom rather than an invention.
 *
 * FOUR DESIGN POINTS WORTH KNOWING:
 *
 * 1. It calls `ingestPrealerta` with `eventId: null` on purpose. There IS no AGORA event id for a
 *    message we pulled rather than received, and inventing one would defeat the redelivery guard.
 *    De-duplication rides on the RFC822 Message-ID unique index instead, which is the key that
 *    survives across both routes. The cheap pre-check here only avoids re-downloading attachments for
 *    mail we already hold; the authoritative gate is still the ingest's own SELECT + unique indexes.
 *
 * 2. Candidates from ALL conversations are pooled and sorted oldest-first before the per-run cap is
 *    applied. That is what makes the watermark safe to advance under truncation: everything at or
 *    before `hasta` has been examined, so nothing older is ever skipped by a later run.
 *
 * 3. The watermark does NOT advance when a conversation failed to list. A failure means we cannot
 *    know what was in that conversation, and moving the bookmark past an unknown would turn a
 *    transient AGORA error into a permanently lost prealerta. A stuck cursor re-reads harmlessly;
 *    an advanced one loses cargo.
 *
 * 4. Every recovery writes `PREALERTA_RECUPERADA_POR_BARRIDO` to the ledger and the audit chain, so
 *    "this caso reached us through the safety net, not through the webhook" is a fact an auditor can
 *    read, not something inferred from the absence of an event id.
 */

const CURSOR_FUENTE = 'agora_prealertas';
const TIPO_EVENTO_RECUPERADA = 'PREALERTA_RECUPERADA_POR_BARRIDO';

const TIMEOUT_MS = Number(process.env.AGORA_HTTP_TIMEOUT_MS ?? 20_000);
/** Chatwoot pages conversations 25 at a time; bound the walk so one run cannot page forever. */
const MAX_CONVERSATION_PAGES = 5;
/** Keep `last_error` readable in a status panel instead of dumping a stack trace into it. */
const MAX_ERROR_CHARS = 500;

export type SweepMessageStatus =
  | 'recuperada'
  | 'conocida'
  | 'duplicada'
  | 'ignorada'
  | 'rechazada'
  | 'error';

export interface SweepMessageOutcome {
  conversationId: number | null;
  /** AGORA's own message id (numeric), kept as a string for symmetry with the stored column. */
  agoraMessageId: string | null;
  /** RFC822 Message-ID — the key idempotency rides on. */
  messageId: string | null;
  createdAt: string | null;
  status: SweepMessageStatus;
  reason?: string;
  operacionId?: string;
}

export interface SweepConversationError {
  conversationId: number | null;
  message: string;
}

export interface SweepSummary {
  ok: boolean;
  /** Set when the sweep could not even start (missing configuration); not an error condition. */
  omitido: string | null;
  /** Start of the window examined, ISO. */
  desde: string | null;
  /** Watermark the cursor was advanced to, ISO, or null when it was deliberately held back. */
  hasta: string | null;
  conversaciones: number;
  candidatos: number;
  revisados: number;
  recuperadas: number;
  conocidas: number;
  duplicadas: number;
  ignoradas: number;
  rechazadas: number;
  errores: number;
  truncado: boolean;
  detalle: SweepMessageOutcome[];
  erroresDetalle: SweepConversationError[];
}

/** Shape of the bits of a Chatwoot conversation listing we rely on. */
interface AgoraConversation {
  id?: number;
  inbox_id?: number;
  last_activity_at?: number;
  [k: string]: unknown;
}

/** Shape of the bits of a Chatwoot message we rely on. */
interface AgoraMessage {
  id?: number;
  content?: string | null;
  /** 0 = incoming, 1 = outgoing in the numeric form; some versions serialize the string. */
  message_type?: number | string;
  private?: boolean;
  created_at?: number;
  conversation_id?: number;
  content_attributes?: AgoraWebhookPayload['content_attributes'];
  sender?: { id?: number; email?: string; name?: string };
  attachments?: AgoraWebhookPayload['attachments'];
  [k: string]: unknown;
}

function lookbackHours(): number {
  const raw = Number(process.env.SWEEP_LOOKBACK_HOURS);
  return Number.isFinite(raw) && raw > 0 ? raw : 24;
}

function maxMessages(): number {
  const raw = Number(process.env.SWEEP_MAX_MESSAGES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 50;
}

function errText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > MAX_ERROR_CHARS ? `${msg.slice(0, MAX_ERROR_CHARS)}…` : msg;
}

/**
 * GET against the AGORA application API. Written here rather than in agoraClient.ts because the sweep
 * is the only reader; the client keeps its three write-shaped concerns. Same timeout idiom, same
 * `api_access_token` header.
 */
async function agoraGet<T>(cfg: AgoraConfig, path: string): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${cfg.baseUrl}/api/v1/accounts/${cfg.accountId}${path}`, {
      signal: ac.signal,
      headers: { api_access_token: cfg.token, 'Content-Type': 'application/json' },
    });
    if (!res.ok) throw new Error(`AGORA GET ${path} falló: ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Chatwoot has moved the collection between `{data:{payload:[…]}}` and `{payload:[…]}` across
 * versions, and AGORA is a fork of unknown vintage — so read all the shapes rather than betting on
 * one and discovering the bet was wrong through a silently empty sweep.
 */
function extractPayload(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  const b = (body ?? {}) as { payload?: unknown; data?: unknown };
  const data = (b.data ?? {}) as { payload?: unknown };
  if (Array.isArray(data.payload)) return data.payload;
  if (Array.isArray(b.payload)) return b.payload;
  if (Array.isArray(b.data)) return b.data as unknown[];
  return [];
}

/** Unix seconds is what Chatwoot sends; milliseconds is tolerated so a fork cannot silently skew us. */
function createdAtMs(m: AgoraMessage): number | null {
  const raw = Number(m.created_at);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  return raw > 1e12 ? raw : raw * 1000;
}

function isIncoming(m: AgoraMessage): boolean {
  const t = m.message_type;
  return t === 0 || t === '0' || t === 'incoming';
}

function messageIdOf(m: AgoraMessage): string | null {
  const email = (m.content_attributes ?? {}).email ?? {};
  const raw = email.message_id;
  return typeof raw === 'string' && raw ? raw : null;
}

/**
 * List the conversations of the prealertas inbox, newest activity first, walking pages until one is
 * empty, every conversation on it predates the window, or the page cap is hit.
 */
export async function listPrealertaConversations(
  cfg: AgoraConfig,
  inboxId: string,
  sinceMs: number,
): Promise<AgoraConversation[]> {
  const out: AgoraConversation[] = [];
  for (let page = 1; page <= MAX_CONVERSATION_PAGES; page++) {
    const body = await agoraGet<unknown>(
      cfg,
      `/conversations?inbox_id=${encodeURIComponent(inboxId)}&status=all&page=${page}`,
    );
    const rows = extractPayload(body) as AgoraConversation[];
    if (!rows.length) break;
    out.push(...rows);
    // Ordered by last activity descending, so once a whole page predates the window there is nothing
    // newer further down. Conversations with no `last_activity_at` are never used to stop the walk.
    const anyFresh = rows.some((c) => {
      const act = Number(c.last_activity_at);
      return !Number.isFinite(act) || act <= 0 || act * 1000 >= sinceMs;
    });
    if (!anyFresh) break;
  }
  return out;
}

/** Fetch one conversation's messages. */
export async function listConversationMessages(
  cfg: AgoraConfig,
  conversationId: number | string,
): Promise<AgoraMessage[]> {
  const body = await agoraGet<unknown>(cfg, `/conversations/${conversationId}/messages`);
  return extractPayload(body) as AgoraMessage[];
}

/**
 * Rebuild the exact payload the `message_created` webhook would have delivered, so the ingest runs
 * one code path regardless of how the message reached us. Chatwoot's numeric `message_type` is mapped
 * to the string form the webhook uses, because the ingest gates on `'incoming'`.
 */
export function buildWebhookPayload(
  m: AgoraMessage,
  conv: AgoraConversation,
  inboxId: string | null,
): AgoraWebhookPayload {
  const email = (m.content_attributes ?? {}).email ?? {};
  const from = email.from;
  const fromEmail = Array.isArray(from) ? from[0] : typeof from === 'string' ? from : null;
  const convId = m.conversation_id ?? conv.id ?? null;
  const inbox = conv.inbox_id ?? (inboxId != null && inboxId !== '' ? Number(inboxId) : undefined);
  return {
    event: 'message_created',
    id: m.id,
    message_type: 'incoming',
    private: false,
    content: m.content ?? null,
    content_attributes: m.content_attributes ?? {},
    conversation: {
      ...(convId != null ? { id: Number(convId) } : {}),
      ...(inbox != null && Number.isFinite(Number(inbox)) ? { inbox_id: Number(inbox) } : {}),
    },
    ...(inbox != null && Number.isFinite(Number(inbox)) ? { inbox: { id: Number(inbox) } } : {}),
    sender: { ...(m.sender ?? {}), email: m.sender?.email ?? fromEmail ?? undefined },
    attachments: m.attachments ?? [],
    /** Marks provenance inside the archived email artifact — this copy came from the sweep. */
    recuperado_por_barrido: true,
  };
}

async function readCursor(): Promise<Date | null> {
  // The migration seeds this row, but `truncateAll` in tests (and a future manual wipe) can remove
  // it; re-creating it is cheaper than special-casing "no cursor yet" on every read.
  await query(
    `INSERT INTO integracion_cursores (fuente) VALUES ($1) ON CONFLICT (fuente) DO NOTHING`,
    [CURSOR_FUENTE],
  );
  const r = await query<{ last_synced_at: Date | null }>(
    `SELECT last_synced_at FROM integracion_cursores WHERE fuente = $1`,
    [CURSOR_FUENTE],
  );
  const raw = r.rows[0] ? r.rows[0].last_synced_at : null;
  return raw ? new Date(raw) : null;
}

/**
 * One UPDATE closes the run: the watermark (when it is safe to move), the run stamp, and the error
 * state with the same semantics the flight phase uses — an error message increments the consecutive
 * counter, a clean run resets it to zero.
 *
 * GREATEST guards against a clock or ordering surprise walking the bookmark backwards.
 */
async function writeCursor(
  advanceTo: Date | null,
  lastEventId: string | null,
  lastError: string | null,
): Promise<void> {
  await query(
    `UPDATE integracion_cursores
        SET last_synced_at = CASE WHEN $2::timestamptz IS NULL THEN last_synced_at
                                  ELSE GREATEST(COALESCE(last_synced_at, $2::timestamptz), $2::timestamptz)
                             END,
            last_event_id = COALESCE($3::text, last_event_id),
            last_run_at = now(),
            last_error = $1::text,
            consecutive_errors = CASE WHEN $1::text IS NULL THEN 0
                                      ELSE consecutive_errors + 1 END,
            updated_at = now()
      WHERE fuente = $4`,
    [lastError, advanceTo ? advanceTo.toISOString() : null, lastEventId, CURSOR_FUENTE],
  );
}

/**
 * Cheap pre-check so known mail does not cost us an attachment download per run. Deliberately NOT the
 * authority: `ingestPrealerta` re-checks inside its own transaction and the unique indexes settle any
 * race this read could lose.
 */
async function alreadyKnown(messageId: string | null, agoraMessageId: string | null): Promise<boolean> {
  if (!messageId && !agoraMessageId) return false;
  const r = await query<{ id: string }>(
    `SELECT id FROM prealertas
      WHERE ($1::text IS NOT NULL AND message_id = $1)
         OR ($2::text IS NOT NULL AND agora_message_id = $2)
      LIMIT 1`,
    [messageId, agoraMessageId],
  );
  return r.rows.length > 0;
}

/**
 * Record the recovery on the operación's timeline and in the audit chain. Only reached for a genuine
 * recovery (`processed`): a duplicate or an ignored message recovered nothing, and logging one would
 * make the safety net look busier than it was.
 */
async function recordRecovery(
  operacionId: string,
  info: { messageId: string | null; conversationId: number | null; prealertaId?: string },
): Promise<void> {
  const ins = await query<{ operacion_mawb: string }>(
    `INSERT INTO operacion_eventos
       (operacion_id, operacion_mawb, tipo, origen, ocurrido_at, payload)
     SELECT o.id, o.mawb, $2, 'sistema', now(), $3::jsonb
       FROM operaciones o
      WHERE o.id = $1
     RETURNING operacion_mawb`,
    [
      operacionId,
      TIPO_EVENTO_RECUPERADA,
      JSON.stringify({ messageId: info.messageId, conversationId: info.conversationId }),
    ],
  );
  await recordAudit({
    userId: null,
    action: TIPO_EVENTO_RECUPERADA,
    entity: 'operacion',
    entityId: operacionId,
    after: {
      mawb: ins.rows[0] ? ins.rows[0].operacion_mawb : null,
      prealertaId: info.prealertaId ?? null,
      messageId: info.messageId,
      conversationId: info.conversationId,
    },
    ip: null,
  });
}

function emptySummary(over: Partial<SweepSummary> = {}): SweepSummary {
  return {
    ok: true,
    omitido: null,
    desde: null,
    hasta: null,
    conversaciones: 0,
    candidatos: 0,
    revisados: 0,
    recuperadas: 0,
    conocidas: 0,
    duplicadas: 0,
    ignoradas: 0,
    rechazadas: 0,
    errores: 0,
    truncado: false,
    detalle: [],
    erroresDetalle: [],
    ...over,
  };
}

/**
 * Run one reconciliation pass. Never throws for an AGORA or network problem: the caller is the ops
 * tick, and one phase failing must not take the other down with it. Failures surface as `ok: false`
 * plus `last_error` / `consecutive_errors` on the cursor, which is what makes a persistently broken
 * sweep visible instead of silent.
 */
export async function runAgoraSweep(
  opts: { maxMessages?: number; lookbackHours?: number } = {},
): Promise<SweepSummary> {
  const cfg = loadAgoraConfig();
  if (!cfg) return emptySummary({ omitido: 'agora_no_configurado' });

  const inboxId = process.env.AGORA_PREALERTAS_INBOX_ID ?? null;
  // Without the inbox id there is nothing to list, and the ingest would refuse every message anyway
  // (`inbox_no_vigilado`) — so this is configuration missing, not an error to count against AGORA.
  if (!inboxId) return emptySummary({ omitido: 'inbox_no_configurado' });

  const cap = opts.maxMessages ?? maxMessages();
  const hours = opts.lookbackHours ?? lookbackHours();
  const cursorAt = await readCursor();
  const sinceMs = cursorAt ? cursorAt.getTime() : Date.now() - hours * 3_600_000;
  const desde = new Date(sinceMs).toISOString();

  const detalle: SweepMessageOutcome[] = [];
  const erroresDetalle: SweepConversationError[] = [];

  let conversaciones: AgoraConversation[];
  try {
    conversaciones = await listPrealertaConversations(cfg, inboxId, sinceMs);
  } catch (err) {
    // Listing is the one step with no partial result to keep: without conversations there is nothing
    // to sweep, so the run is a failure in full and the watermark stays exactly where it was.
    const message = errText(err);
    await writeCursor(null, null, `no se pudieron listar conversaciones: ${message}`);
    return emptySummary({
      ok: false,
      desde,
      errores: 1,
      erroresDetalle: [{ conversationId: null, message }],
    });
  }

  // Collect candidates across every conversation FIRST, then order them oldest-first. Both halves of
  // that matter: pooling makes the cap fair across conversations, and the ordering is what lets the
  // watermark advance safely when the cap truncates the run.
  const candidatos: Array<{ m: AgoraMessage; conv: AgoraConversation; ts: number }> = [];
  for (const conv of conversaciones) {
    if (conv.id == null) continue;
    try {
      const mensajes = await listConversationMessages(cfg, conv.id);
      for (const m of mensajes) {
        if (!isIncoming(m) || m.private) continue;
        const ts = createdAtMs(m);
        // A message with no usable timestamp cannot be placed relative to the watermark. Skipping it
        // is the safe call: processing it would be unbounded in time and could resurrect ancient mail.
        if (ts == null || ts <= sinceMs) continue;
        candidatos.push({ m, conv, ts });
      }
    } catch (err) {
      // One conversation failing must not cost us the rest of the inbox — but it DOES hold the
      // watermark back, because we no longer know what that conversation contained.
      erroresDetalle.push({ conversationId: conv.id ?? null, message: errText(err) });
    }
  }
  candidatos.sort((a, b) => a.ts - b.ts);

  const truncado = candidatos.length > cap;
  const lote = truncado ? candidatos.slice(0, cap) : candidatos;

  let recuperadas = 0;
  let conocidas = 0;
  let duplicadas = 0;
  let ignoradas = 0;
  let rechazadas = 0;
  let watermark: number | null = null;
  let lastEventId: string | null = null;

  for (const { m, conv, ts } of lote) {
    const messageId = messageIdOf(m);
    const agoraMessageId = m.id != null ? String(m.id) : null;
    const conversationId = m.conversation_id ?? conv.id ?? null;
    const base = {
      conversationId: conversationId != null ? Number(conversationId) : null,
      agoraMessageId,
      messageId,
      createdAt: new Date(ts).toISOString(),
    };

    try {
      if (await alreadyKnown(messageId, agoraMessageId)) {
        conocidas++;
        detalle.push({ ...base, status: 'conocida' });
      } else {
        const out = await ingestPrealerta(buildWebhookPayload(m, conv, inboxId), {
          eventId: null,
          expectedInboxId: inboxId,
        });
        // Field access is deliberately defensive rather than relying on union narrowing: the
        // repo-root tsconfig runs without strictNullChecks, where narrowing degrades (see the note in
        // routes/prealertas.ts).
        const asAny = out as {
          status: string;
          reason?: string;
          operacionId?: string;
          prealertaId?: string;
        };
        if (asAny.status === 'processed' && asAny.operacionId) {
          recuperadas++;
          await recordRecovery(asAny.operacionId, {
            messageId,
            conversationId: base.conversationId,
            prealertaId: asAny.prealertaId,
          });
          detalle.push({ ...base, status: 'recuperada', operacionId: asAny.operacionId });
        } else if (asAny.status === 'duplicate') {
          duplicadas++;
          detalle.push({ ...base, status: 'duplicada' });
        } else if (asAny.status === 'rejected') {
          rechazadas++;
          detalle.push({
            ...base,
            status: 'rechazada',
            reason: asAny.reason,
            ...(asAny.operacionId ? { operacionId: asAny.operacionId } : {}),
          });
        } else {
          ignoradas++;
          detalle.push({ ...base, status: 'ignorada', reason: asAny.reason });
        }
      }
      // Examined successfully: the bookmark may pass this message. Advanced per message rather than
      // in one jump at the end so a failure halfway through still banks the work that succeeded.
      watermark = watermark == null || ts > watermark ? ts : watermark;
      if (agoraMessageId) lastEventId = agoraMessageId;
    } catch (err) {
      // A single bad message (unreadable attachment, storage hiccup) is reported and left for the
      // next run; the rest of the batch still runs, and since ANY error holds the watermark back the
      // failed message is guaranteed to be retried rather than skipped.
      erroresDetalle.push({ conversationId: base.conversationId, message: errText(err) });
      detalle.push({ ...base, status: 'error', reason: errText(err) });
    }
  }

  const errores = erroresDetalle.length;
  const lastError = errores
    ? `${errores} ${errores === 1 ? 'conversación' : 'conversaciones'} con error: ${erroresDetalle
        .map((e) => `${e.conversationId ?? 'sin-id'}: ${e.message}`)
        .join('; ')
        .slice(0, MAX_ERROR_CHARS)}`
    : null;
  // Hold the watermark on any error: we cannot prove we saw everything up to it, and a bookmark that
  // moves past an unknown converts a transient failure into cargo nobody planned for.
  const advanceTo = errores === 0 && watermark != null ? new Date(watermark) : null;
  await writeCursor(advanceTo, errores === 0 ? lastEventId : null, lastError);

  return {
    ok: errores === 0,
    omitido: null,
    desde,
    hasta: advanceTo ? advanceTo.toISOString() : null,
    conversaciones: conversaciones.length,
    candidatos: candidatos.length,
    revisados: detalle.length,
    recuperadas,
    conocidas,
    duplicadas,
    ignoradas,
    rechazadas,
    errores,
    truncado,
    detalle,
    erroresDetalle,
  };
}
