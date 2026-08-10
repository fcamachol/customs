import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * OUTBOUND WHATSAPP (#31) — unit tests for the one contract callers depend on.
 *
 * Same reason `mailer.test.ts` exists and is shaped the way it is: §6.3's escalation path only
 * protects a client from an unnoticed bounce if this module is honest about `enviado` vs `omitido`
 * vs `error`. So these tests are almost entirely about that distinction, not about evolution-api's
 * wire protocol.
 *
 * `global.fetch` is mocked. A test suite that opened a real HTTP connection would be testing the
 * network, not this module.
 */
const fetchMock = vi.fn();

const { loadWhatsappConfig, sendWhatsapp, whatsappConfigurado } = await import(
  '../../src/services/whatsapp'
);

const VARS = [
  'EVOLUTION_API_URL',
  'EVOLUTION_API_KEY',
  'EVOLUTION_INSTANCE',
  'EVOLUTION_API_TIMEOUT_MS',
] as const;
const ORIGINAL: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
  for (const v of VARS) {
    ORIGINAL[v] = process.env[v];
    delete process.env[v];
  }
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ key: { id: 'ABCD1234' } }),
    text: async () => '',
  });
});

afterEach(() => {
  for (const v of VARS) {
    if (ORIGINAL[v] === undefined) delete process.env[v];
    else process.env[v] = ORIGINAL[v] as string;
  }
  vi.unstubAllGlobals();
});

function configurar(extra: Record<string, string> = {}): void {
  process.env.EVOLUTION_API_URL = 'https://evolution.example.com';
  process.env.EVOLUTION_API_KEY = 'test-api-key';
  process.env.EVOLUTION_INSTANCE = 'capitalc';
  for (const [k, v] of Object.entries(extra)) process.env[k] = v;
}

describe('loadWhatsappConfig', () => {
  it('returns null when evolution-api is not provisioned at all', () => {
    expect(loadWhatsappConfig()).toBeNull();
    expect(whatsappConfigurado()).toBe(false);
  });

  it('returns null when only the URL is set', () => {
    process.env.EVOLUTION_API_URL = 'https://evolution.example.com';
    expect(loadWhatsappConfig()).toBeNull();
  });

  it('returns null when only URL and key are set — the instance name is also required', () => {
    process.env.EVOLUTION_API_URL = 'https://evolution.example.com';
    process.env.EVOLUTION_API_KEY = 'k';
    expect(loadWhatsappConfig()).toBeNull();
  });

  it('trims a trailing slash from the base URL', () => {
    configurar({ EVOLUTION_API_URL: 'https://evolution.example.com/' });
    expect(loadWhatsappConfig()).toMatchObject({ baseUrl: 'https://evolution.example.com' });
  });

  it('defaults the timeout and lets it be overridden', () => {
    configurar();
    expect(loadWhatsappConfig()).toMatchObject({ timeoutMs: 15_000 });
    configurar({ EVOLUTION_API_TIMEOUT_MS: '5000' });
    expect(loadWhatsappConfig()).toMatchObject({ timeoutMs: 5000 });
  });
});

describe('sendWhatsapp — the unconfigured path', () => {
  it('reports `omitido` with a stated reason instead of throwing', async () => {
    const out = await sendWhatsapp({ to: '+525512345678', text: 'hola' });
    expect(out.status).toBe('omitido');
    expect(out.status === 'omitido' && out.motivo).toMatch(/evolution-api no configurado/);
  });

  it('never calls fetch when there is nothing to send with', async () => {
    await sendWhatsapp({ to: '+525512345678', text: 'hola' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('logs the skipped send so the operator can see what did not go out', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await sendWhatsapp({ to: '+525512345678', text: 'ACTION REQUIRED' });
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).toMatch(/OMITIDO/);
    warn.mockRestore();
  });
});

describe('sendWhatsapp — recipients', () => {
  it('omits a send with no recipient rather than calling evolution-api with an empty number', async () => {
    configurar();
    const out = await sendWhatsapp({ to: '', text: 'hola' });
    expect(out).toEqual({ status: 'omitido', motivo: 'sin destinatario' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('omits a malformed number as a skipped send, not as an exception', async () => {
    configurar();
    const out = await sendWhatsapp({ to: 'not-a-phone', text: 'hola' });
    expect(out.status).toBe('omitido');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('normalizes punctuation out of the phone number before sending', async () => {
    configurar();
    await sendWhatsapp({ to: '+52 (55) 1234-5678', text: 'hola' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.number).toBe('+525512345678');
  });
});

describe('sendWhatsapp — the configured path', () => {
  it('posts to evolution-api\'s sendText endpoint with the apikey header', async () => {
    configurar();
    await sendWhatsapp({ to: '525512345678', text: 'body text' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://evolution.example.com/message/sendText/capitalc',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ apikey: 'test-api-key' }),
      }),
    );
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ number: '525512345678', text: 'body text' });
  });

  it('reports `enviado` with the message id on a 2xx response', async () => {
    configurar();
    const out = await sendWhatsapp({ to: '525512345678', text: 'hola' });
    expect(out).toEqual({ status: 'enviado', destinatario: '525512345678', messageId: 'ABCD1234' });
  });

  it('reports a non-2xx response as `error`, never as a throw', async () => {
    configurar();
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' });
    const out = await sendWhatsapp({ to: '525512345678', text: 'hola' });
    expect(out.status).toBe('error');
    expect(out.status === 'error' && out.error).toMatch(/500/);
  });

  it('reports a network failure as `error`, never as a throw', async () => {
    configurar();
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const out = await sendWhatsapp({ to: '525512345678', text: 'hola' });
    expect(out).toEqual({ status: 'error', error: 'ECONNREFUSED' });
  });

  it('tolerates a response body that is not JSON', async () => {
    configurar();
    fetchMock.mockResolvedValue({ ok: true, json: async () => { throw new Error('not json'); } });
    const out = await sendWhatsapp({ to: '525512345678', text: 'hola' });
    expect(out).toEqual({ status: 'enviado', destinatario: '525512345678', messageId: null });
  });
});
