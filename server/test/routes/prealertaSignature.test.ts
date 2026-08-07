import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyAgoraSignature } from '../../src/routes/prealertas';

/**
 * The prealerta webhook is the one endpoint with no JWT in front of it, and whatever it accepts
 * becomes a customs case. Its only gate is this signature check, so the check gets tested directly
 * rather than only through the route.
 */

const SECRET = 'test-secret';
const BODY = Buffer.from(JSON.stringify({ event: 'message_created', id: 1 }));
const NOW = 1_770_000_000_000; // fixed clock: these assertions must not drift with wall time

function sign(body: Buffer, t: number, secret = SECRET): string {
  const v1 = createHmac('sha256', secret).update(`${t}.${body.toString('utf8')}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

describe('verifyAgoraSignature', () => {
  it('accepts a correctly signed, fresh request', () => {
    const t = Math.floor(NOW / 1000);
    expect(verifyAgoraSignature(sign(BODY, t), BODY, SECRET, 300, NOW)).toEqual({ ok: true });
  });

  it('rejects a missing signature header', () => {
    const r = verifyAgoraSignature(undefined, BODY, SECRET, 300, NOW);
    expect(r).toEqual({ ok: false, reason: 'firma_ausente' });
  });

  it('rejects when the raw body was not captured', () => {
    // Guards against a future refactor dropping the express.json verify hook: without raw bytes we
    // must refuse, never fall back to re-serializing req.body.
    const t = Math.floor(NOW / 1000);
    const r = verifyAgoraSignature(sign(BODY, t), undefined, SECRET, 300, NOW);
    expect(r).toEqual({ ok: false, reason: 'cuerpo_crudo_ausente' });
  });

  it('rejects a malformed header', () => {
    for (const h of ['', 'garbage', 't=abc,v1=xx', 'v1=deadbeef', 't=123']) {
      const r = verifyAgoraSignature(h, BODY, SECRET, 300, NOW);
      expect(r.ok).toBe(false);
    }
  });

  it('rejects a stale timestamp — a captured request cannot be replayed later', () => {
    const t = Math.floor(NOW / 1000) - 3600;
    expect(verifyAgoraSignature(sign(BODY, t), BODY, SECRET, 300, NOW)).toEqual({
      ok: false,
      reason: 'firma_expirada',
    });
  });

  it('rejects a timestamp too far in the future', () => {
    const t = Math.floor(NOW / 1000) + 3600;
    expect(verifyAgoraSignature(sign(BODY, t), BODY, SECRET, 300, NOW).ok).toBe(false);
  });

  it('accepts a timestamp inside the tolerance window on both sides', () => {
    const base = Math.floor(NOW / 1000);
    for (const skew of [-299, -1, 0, 1, 299]) {
      expect(verifyAgoraSignature(sign(BODY, base + skew), BODY, SECRET, 300, NOW).ok).toBe(true);
    }
  });

  it('rejects a signature made with the wrong secret', () => {
    const t = Math.floor(NOW / 1000);
    expect(verifyAgoraSignature(sign(BODY, t, 'other'), BODY, SECRET, 300, NOW)).toEqual({
      ok: false,
      reason: 'firma_invalida',
    });
  });

  it('rejects a tampered body — this is the whole point', () => {
    const t = Math.floor(NOW / 1000);
    const header = sign(BODY, t);
    const tampered = Buffer.from(JSON.stringify({ event: 'message_created', id: 999 }));
    expect(verifyAgoraSignature(header, tampered, SECRET, 300, NOW).ok).toBe(false);
  });

  it('rejects a signature bound to a different timestamp than the header claims', () => {
    const t = Math.floor(NOW / 1000);
    const good = createHmac('sha256', SECRET).update(`${t}.${BODY.toString('utf8')}`).digest('hex');
    // Same digest, different declared t: must not verify.
    expect(verifyAgoraSignature(`t=${t + 5},v1=${good}`, BODY, SECRET, 300, NOW).ok).toBe(false);
  });

  it('rejects a truncated digest instead of throwing on length mismatch', () => {
    const t = Math.floor(NOW / 1000);
    const r = verifyAgoraSignature(`t=${t},v1=abcd`, BODY, SECRET, 300, NOW);
    expect(r).toEqual({ ok: false, reason: 'firma_invalida' });
  });

  it('tolerates extra parameters in the header', () => {
    const t = Math.floor(NOW / 1000);
    expect(verifyAgoraSignature(`${sign(BODY, t)},v2=future`, BODY, SECRET, 300, NOW).ok).toBe(true);
  });
});
