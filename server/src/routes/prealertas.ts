import { Router, type Request, type Response, type NextFunction } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ingestPrealerta, type AgoraWebhookPayload } from '../services/prealertaIngest';

export const prealertasRouter = Router();

/**
 * Inbound webhook from AGORA (PRD-02 R1, Adenda A §6.2).
 *
 * This endpoint is UNAUTHENTICATED in the usual sense — no JWT, no session — because the caller is a
 * machine we do not control the session of. Its identity is proved by the HMAC that AGORA attaches:
 *
 *   X-Agora-Signature: t=<unix seconds>,v1=<hex hmac_sha256(secret, "<t>.<raw body>")>
 *   X-Agora-Event-Id:  <uuid>
 *
 * Three properties matter and each is enforced below:
 *   - authenticity  — the HMAC must verify against AGORA_WEBHOOK_SIGNING_SECRET
 *   - freshness     — `t` must be inside the tolerance window, so a captured request cannot be
 *                     replayed later
 *   - idempotency   — X-Agora-Event-Id and the RFC822 Message-ID are both unique keys downstream, so
 *                     a redelivery is a no-op rather than a duplicated caso
 *
 * The signature is computed over the RAW request body. Re-serializing `req.body` would produce
 * different bytes (key order, whitespace, unicode escaping) and the HMAC would never match, which is
 * why app.ts captures `rawBody` in the json parser's verify hook.
 *
 * Note that AGORA only signs when the webhook has a signing_secret configured; unsigned deliveries
 * (legacy Chatwoot behaviour, and what an automation rule's `send_webhook_event` action produces)
 * are refused here rather than trusted.
 */

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

/**
 * Deliberately a single object shape rather than a discriminated union: the repo-root tsconfig runs
 * without `strict`, so `strictNullChecks` is off and boolean-literal narrowing on `ok` degrades
 * there — a union would type-check under server/tsconfig.json and fail at the root. One shape with an
 * optional `reason` behaves identically under both configs.
 */
export interface SignatureVerdict {
  ok: boolean;
  reason?: string;
}

export function verifyAgoraSignature(
  header: string | undefined,
  rawBody: Buffer | undefined,
  secret: string,
  toleranceSec: number,
  nowMs: number = Date.now(),
): SignatureVerdict {
  if (!header) return { ok: false, reason: 'firma_ausente' };
  if (!rawBody) return { ok: false, reason: 'cuerpo_crudo_ausente' };

  const parts = new Map<string, string>();
  for (const kv of header.split(',')) {
    const idx = kv.indexOf('=');
    if (idx > 0) parts.set(kv.slice(0, idx).trim(), kv.slice(idx + 1).trim());
  }
  const t = Number(parts.get('t'));
  const v1 = parts.get('v1');
  if (!Number.isFinite(t) || !v1) return { ok: false, reason: 'firma_malformada' };

  if (Math.abs(nowMs / 1000 - t) > toleranceSec) return { ok: false, reason: 'firma_expirada' };

  const expected = createHmac('sha256', secret).update(`${t}.${rawBody.toString('utf8')}`).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(v1, 'hex');
  } catch {
    return { ok: false, reason: 'firma_malformada' };
  }
  // Length check first: timingSafeEqual throws on mismatched lengths rather than returning false.
  if (provided.length !== expected.length) return { ok: false, reason: 'firma_invalida' };
  if (!timingSafeEqual(provided, expected)) return { ok: false, reason: 'firma_invalida' };
  return { ok: true };
}

prealertasRouter.post('/inbound', async (req: RawBodyRequest, res: Response, next: NextFunction) => {
  try {
    const secret = process.env.AGORA_WEBHOOK_SIGNING_SECRET;
    if (!secret) {
      // Fail closed. Running this endpoint without a secret would accept anything that can reach the
      // host, and what it accepts becomes a customs case.
      console.error('[prealertas] AGORA_WEBHOOK_SIGNING_SECRET no está configurado');
      res.status(503).json({ error: 'Webhook no configurado' });
      return;
    }
    const tolerance = Number(process.env.AGORA_SIGNATURE_TOLERANCE_SEC ?? 300);
    const verdict = verifyAgoraSignature(
      req.header('x-agora-signature'),
      req.rawBody,
      secret,
      tolerance,
    );
    if (!verdict.ok) {
      // Deliberately terse to the caller, explicit in the log: a probing client learns nothing about
      // which of the checks it failed.
      console.warn(`[prealertas] firma rechazada: ${verdict.reason}`);
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const eventId = req.header('x-agora-event-id') ?? null;
    const outcome = await ingestPrealerta(req.body as AgoraWebhookPayload, {
      eventId,
      expectedInboxId: process.env.AGORA_PREALERTAS_INBOX_ID ?? null,
    });

    // A duplicate or an ignored event is a SUCCESS from the sender's point of view: returning an
    // error would make AGORA retry forever on something we have deliberately decided not to act on.
    // A genuine failure (archival, DB) throws instead and lands as a 500, which is what we DO want
    // retried.
    res.status(202).json(outcome);
  } catch (err) {
    next(err);
  }
});
