// Thin client for the AGORA communication hub (PRD-02 Adenda A).
//
// AGORA is transport, not a system of record: it delivers the client's prealerta and carries our
// replies, while the authoritative copy of everything lives here behind the audit hash chain. This
// client therefore does exactly three things — pull an artifact in, push a message out, and stamp
// correlation attributes back — and deliberately nothing else.
//
// A NOTE ON WHAT WE CAN ACTUALLY ARCHIVE. AGORA has two inbound paths and they differ in fidelity:
// the provider-ingress path keeps the original RFC822 message as an ActionMailbox blob, whereas the
// IMAP path (which is how the aduanas inbox is configured today, over Google OAuth) parses the mail
// and keeps only a curated field set — from/to/cc/bcc/subject/date/message_id/in_reply_to/references
// plus the text and HTML bodies. Arbitrary X-* headers are not persisted on that path at all. So
// `buildEmailArchive` snapshots the curated record faithfully and labels it for what it is, rather
// than pretending to hold original MIME. Attachments ARE stored in full on both paths, which is what
// matters most here: the AWB and the manifiesto are the artifacts the cotejo and the risk engine
// consume. If provider ingress is configured later, this is the one place that needs revisiting to
// archive true MIME.

export interface AgoraConfig {
  baseUrl: string;
  accountId: string;
  token: string;
}

export function loadAgoraConfig(): AgoraConfig | null {
  const baseUrl = process.env.AGORA_BASE_URL;
  const accountId = process.env.AGORA_ACCOUNT_ID;
  const token = process.env.AGORA_API_ACCESS_TOKEN;
  if (!baseUrl || !accountId || !token) return null;
  return { baseUrl: baseUrl.replace(/\/+$/, ''), accountId, token };
}

const TIMEOUT_MS = Number(process.env.AGORA_HTTP_TIMEOUT_MS ?? 20_000);
/** Mirrors storage/files.ts MAX_BYTES; a hostile or fat attachment must not exhaust memory. */
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    return await fn(ac.signal);
  } finally {
    clearTimeout(timer);
  }
}

function apiUrl(cfg: AgoraConfig, path: string): string {
  return `${cfg.baseUrl}/api/v1/accounts/${cfg.accountId}${path}`;
}

async function agoraFetch(cfg: AgoraConfig, path: string, init?: RequestInit): Promise<Response> {
  return withTimeout((signal) =>
    fetch(apiUrl(cfg, path), {
      ...init,
      signal,
      headers: {
        api_access_token: cfg.token,
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    }),
  );
}

/**
 * Download an attachment the webhook referenced by URL. Chatwoot hands out ActiveStorage URLs rather
 * than inline bytes, so this is a second hop; the api token is sent because the deployment may be
 * configured to require it, and harmlessly ignored when it is not.
 *
 * The size guard reads the body as a stream-free arrayBuffer but checks Content-Length first, so an
 * oversized blob is refused before it is buffered rather than after.
 */
export async function downloadAttachment(cfg: AgoraConfig, url: string): Promise<Buffer> {
  const res = await withTimeout((signal) =>
    fetch(url, { signal, redirect: 'follow', headers: { api_access_token: cfg.token } }),
  );
  if (!res.ok) throw new Error(`AGORA attachment download failed: ${res.status} ${url}`);
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > MAX_ATTACHMENT_BYTES) {
    throw new Error(`AGORA attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes (declared ${declared})`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_ATTACHMENT_BYTES) {
    throw new Error(`AGORA attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes (actual ${buf.length})`);
  }
  return buf;
}

/**
 * Post a message into an existing conversation. This is how the risk requirement with its hard
 * deadline (R18), plan-change notices (R19) and the POD reach the client: in the same email thread
 * the prealerta arrived on, so their reply comes back to us correlated instead of into a void.
 */
export async function postMessage(
  cfg: AgoraConfig,
  conversationId: string | number,
  body: { content: string; private?: boolean; ccEmails?: string; bccEmails?: string },
): Promise<{ id: number } | null> {
  const res = await agoraFetch(cfg, `/conversations/${conversationId}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      content: body.content,
      private: body.private ?? false,
      message_type: 'outgoing',
      ...(body.ccEmails ? { cc_emails: body.ccEmails } : {}),
      ...(body.bccEmails ? { bcc_emails: body.bccEmails } : {}),
    }),
  });
  if (!res.ok) throw new Error(`AGORA postMessage failed: ${res.status}`);
  return (await res.json().catch(() => null)) as { id: number } | null;
}

/**
 * Stamp the customs context onto the AGORA conversation so the human inbox shows what the thread is
 * about, and so AGORA-side automation can filter on it. Best-effort by design: failing to decorate a
 * conversation must never fail an ingest that already committed.
 *
 * NOTE: this endpoint REPLACES the attribute set rather than merging it, so callers pass the full
 * intended state, not a delta.
 */
export async function setConversationCustomAttributes(
  cfg: AgoraConfig,
  conversationId: string | number,
  attrs: Record<string, unknown>,
): Promise<void> {
  const res = await agoraFetch(cfg, `/conversations/${conversationId}/custom_attributes`, {
    method: 'POST',
    body: JSON.stringify({ custom_attributes: attrs }),
  });
  if (!res.ok) throw new Error(`AGORA setConversationCustomAttributes failed: ${res.status}`);
}

/**
 * Serialize what AGORA actually captured of the message into the artifact we archive.
 *
 * `fidelity` is recorded explicitly so a future reader (or an auditor) can tell whether they are
 * looking at a curated projection or original MIME, instead of having to infer it from which fields
 * happen to be present.
 */
export function buildEmailArchive(message: unknown): Buffer {
  const archive = {
    schema: 'customs.prealerta_email/1',
    fidelity: 'agora_curated_fields',
    note:
      'Curated projection of the inbound email as captured by AGORA. On the IMAP ingest path AGORA ' +
      'does not retain original RFC822 source, so this is the highest-fidelity record available. ' +
      'Attachments are archived separately and in full.',
    archivedAt: new Date().toISOString(),
    message,
  };
  return Buffer.from(JSON.stringify(archive, null, 2), 'utf8');
}
