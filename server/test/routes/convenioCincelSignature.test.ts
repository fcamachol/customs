import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyCincelSignature } from '../../src/routes/convenios';

/**
 * `routes/convenios.ts`'s `/cincel/webhook` is the one endpoint with no JWT in front of it, and
 * whatever it accepts becomes a `firmada` convenio with NOM-151 evidence attached. Its only gate is
 * this signature check, tested directly exactly like `prealertaSignature.test.ts` tests
 * `verifyAgoraSignature` — same scheme, different secret.
 */

const SECRET = 'test-secret';
const BODY = Buffer.from(JSON.stringify({ event: 'document.completed', document: { id: 'x' } }));
const NOW = 1_770_000_000_000;

function sign(body: Buffer, t: number, secret = SECRET): string {
  const v1 = createHmac('sha256', secret).update(`${t}.${body.toString('utf8')}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

describe('verifyCincelSignature', () => {
  it('accepts a correctly signed, fresh request', () => {
    const t = Math.floor(NOW / 1000);
    expect(verifyCincelSignature(sign(BODY, t), BODY, SECRET, 300, NOW)).toEqual({ ok: true });
  });

  it('rejects a missing signature header', () => {
    expect(verifyCincelSignature(undefined, BODY, SECRET, 300, NOW)).toEqual({
      ok: false,
      reason: 'firma_ausente',
    });
  });

  it('rejects when the raw body was not captured', () => {
    const t = Math.floor(NOW / 1000);
    expect(verifyCincelSignature(sign(BODY, t), undefined, SECRET, 300, NOW)).toEqual({
      ok: false,
      reason: 'cuerpo_crudo_ausente',
    });
  });

  it('rejects a malformed header', () => {
    for (const h of ['', 'garbage', 't=abc,v1=xx', 'v1=deadbeef', 't=123']) {
      expect(verifyCincelSignature(h, BODY, SECRET, 300, NOW).ok).toBe(false);
    }
  });

  it('rejects a stale timestamp — a captured request cannot be replayed later', () => {
    const t = Math.floor(NOW / 1000) - 3600;
    expect(verifyCincelSignature(sign(BODY, t), BODY, SECRET, 300, NOW)).toEqual({
      ok: false,
      reason: 'firma_expirada',
    });
  });

  it('accepts a timestamp inside the tolerance window on both sides', () => {
    const base = Math.floor(NOW / 1000);
    for (const skew of [-299, -1, 0, 1, 299]) {
      expect(verifyCincelSignature(sign(BODY, base + skew), BODY, SECRET, 300, NOW).ok).toBe(true);
    }
  });

  it('rejects a signature made with the wrong secret', () => {
    const t = Math.floor(NOW / 1000);
    expect(verifyCincelSignature(sign(BODY, t, 'other'), BODY, SECRET, 300, NOW)).toEqual({
      ok: false,
      reason: 'firma_invalida',
    });
  });

  it('rejects a tampered body — this is the whole point', () => {
    const t = Math.floor(NOW / 1000);
    const header = sign(BODY, t);
    const tampered = Buffer.from(JSON.stringify({ event: 'document.completed', document: { id: 'y' } }));
    expect(verifyCincelSignature(header, tampered, SECRET, 300, NOW).ok).toBe(false);
  });

  it('rejects a truncated digest instead of throwing on length mismatch', () => {
    const t = Math.floor(NOW / 1000);
    expect(verifyCincelSignature(`t=${t},v1=abcd`, BODY, SECRET, 300, NOW)).toEqual({
      ok: false,
      reason: 'firma_invalida',
    });
  });

  it('tolerates extra parameters in the header', () => {
    const t = Math.floor(NOW / 1000);
    expect(verifyCincelSignature(`${sign(BODY, t)},v2=future`, BODY, SECRET, 300, NOW).ok).toBe(true);
  });
});
