import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cincelConfigurado, loadCincelConfig, solicitarFirma } from '../../src/services/cincel';

/**
 * CINCEL (NOM-151 digital signature) — unit tests for the one contract callers depend on, exactly
 * like `mailer.test.ts` for #22. `routes/convenios.ts` only advances `estado_firma` to `solicitada` on
 * `enviado`, so the tests are almost entirely about the difference between `enviado`, `omitido` and
 * `error` — never about Cincel's actual wire protocol, which does not exist in this repo (see the
 * module doc comment in `services/cincel.ts`).
 *
 * The global `fetch` is mocked — the house convention for outbound HTTP with no dedicated client
 * library (see `test/services/aeroApi.test.ts`), rather than mocking a package the way `mailer.test.ts`
 * mocks `nodemailer`.
 */

const VARS = ['CINCEL_API_URL', 'CINCEL_API_KEY', 'CINCEL_TIMEOUT_MS'] as const;
const ORIGINAL: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.unstubAllGlobals();
  for (const v of VARS) {
    ORIGINAL[v] = process.env[v];
    delete process.env[v];
  }
});

afterEach(() => {
  for (const v of VARS) {
    if (ORIGINAL[v] === undefined) delete process.env[v];
    else process.env[v] = ORIGINAL[v] as string;
  }
  vi.unstubAllGlobals();
});

function configurar(extra: Record<string, string> = {}): void {
  process.env.CINCEL_API_URL = 'https://cincel.example.com';
  process.env.CINCEL_API_KEY = 'test-key';
  for (const [k, v] of Object.entries(extra)) process.env[k] = v;
}

const INPUT = {
  convenioId: 'c0000000-0000-0000-0000-000000000001',
  fileBytes: Buffer.from('%PDF-1.4 fake contract bytes'),
  fileName: 'convenio.pdf',
  signerName: 'Cliente de Prueba',
  signerEmail: 'cliente@example.com',
};

describe('loadCincelConfig', () => {
  it('returns null when Cincel is not provisioned at all', () => {
    expect(loadCincelConfig()).toBeNull();
    expect(cincelConfigurado()).toBe(false);
  });

  it('returns null with only the URL set', () => {
    process.env.CINCEL_API_URL = 'https://cincel.example.com';
    expect(loadCincelConfig()).toBeNull();
  });

  it('returns null with only the API key set', () => {
    process.env.CINCEL_API_KEY = 'test-key';
    expect(loadCincelConfig()).toBeNull();
  });

  it('strips a trailing slash from the base URL', () => {
    configurar({ CINCEL_API_URL: 'https://cincel.example.com/' });
    expect(loadCincelConfig()).toMatchObject({ baseUrl: 'https://cincel.example.com' });
  });

  it('defaults the timeout to 20s', () => {
    configurar();
    expect(loadCincelConfig()).toMatchObject({ timeoutMs: 20_000 });
  });

  it('reports configured once both vars are present', () => {
    configurar();
    expect(cincelConfigurado()).toBe(true);
  });
});

describe('solicitarFirma — recipients', () => {
  it('omits a request with no signer email rather than calling CINCEL', async () => {
    configurar();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const out = await solicitarFirma({ ...INPUT, signerEmail: '' });
    expect(out).toEqual({ status: 'omitido', motivo: 'firmante sin correo válido: (vacío)' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('omits a request with a malformed signer email', async () => {
    configurar();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const out = await solicitarFirma({ ...INPUT, signerEmail: 'not-an-email' });
    expect(out.status).toBe('omitido');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('solicitarFirma — the unconfigured path', () => {
  it('reports `omitido` with a stated reason instead of throwing', async () => {
    const out = await solicitarFirma(INPUT);
    expect(out).toEqual({
      status: 'omitido',
      motivo: 'CINCEL no configurado (CINCEL_API_URL/CINCEL_API_KEY)',
    });
  });

  it('never calls fetch when there is nothing to call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await solicitarFirma(INPUT);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('logs the skipped request so the operator can see what did not go out', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await solicitarFirma(INPUT);
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).toMatch(/OMITIDA/);
    warn.mockRestore();
  });
});

describe('solicitarFirma — the configured path', () => {
  it('sends the document and reports the CINCEL request id', async () => {
    configurar();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: 'cincel-doc-123', sign_url: 'https://cincel.example.com/sign/abc' }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const out = await solicitarFirma(INPUT);
    expect(out).toEqual({
      status: 'enviado',
      solicitudId: 'cincel-doc-123',
      firmaUrl: 'https://cincel.example.com/sign/abc',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://cincel.example.com/api/v2/documents');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key');
    expect(init.body).toBeInstanceOf(FormData);
  });

  it('reports a null sign_url as null, not undefined', async () => {
    configurar();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ id: 'x' }) })),
    );
    const out = await solicitarFirma(INPUT);
    expect(out).toEqual({ status: 'enviado', solicitudId: 'x', firmaUrl: null });
  });

  it('reports a non-2xx response as `error`, never as a throw', async () => {
    configurar();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 401, text: async () => 'invalid api key' })),
    );
    const out = await solicitarFirma(INPUT);
    expect(out.status).toBe('error');
    expect(out.status === 'error' && out.error).toMatch(/401/);
    expect(out.status === 'error' && out.error).toMatch(/invalid api key/);
  });

  it('reports a response with no id as `error`', async () => {
    configurar();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })),
    );
    const out = await solicitarFirma(INPUT);
    expect(out).toEqual({ status: 'error', error: 'CINCEL no devolvió un id de solicitud' });
  });

  it('reports a network failure (thrown fetch) as `error`, never as an unhandled throw', async () => {
    configurar();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    const out = await solicitarFirma(INPUT);
    expect(out).toEqual({ status: 'error', error: 'ECONNREFUSED' });
  });

  it('aborts and reports `error` past the configured timeout', async () => {
    configurar({ CINCEL_TIMEOUT_MS: '5' });
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }),
    );
    const out = await solicitarFirma(INPUT);
    expect(out.status).toBe('error');
  });
});
