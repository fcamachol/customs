import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiDownload } from './api';

/**
 * `apiDownload` and the 410 (backlog #39).
 *
 * WHY THIS FILE EXISTS. `GET /api/files/:id` answers three different facts with three different
 * statuses: 404 "we never had this file", 410 "the row and its hash are here, the bytes are gone",
 * 200 the bytes. The 410 body carries the Spanish explanation, the sha256 the evidence was archived
 * under, and the `codigo` the recovery script keys on. The client used to throw `res.statusText`,
 * so all of that arrived on screen as the word "Gone" — a data-loss incident rendered as a glitch.
 * These tests pin that the body survives the throw.
 */

const CUERPO_410 = {
  error:
    'La evidencia ya no está disponible en el almacenamiento. El registro y su hash se conservan; ' +
    'los bytes deben recuperarse desde el origen y verificarse contra el hash.',
  codigo: 'EVIDENCIA_NO_DISPONIBLE',
  fileId: '11111111-1111-1111-1111-111111111111',
  kind: 'pod_firmado',
  originalName: 'POD-20260810-003.pdf',
  contentHash: 'a'.repeat(64),
  sizeBytes: 51_233,
};

function respuesta(status: number, body: unknown, ok = false): Response {
  return {
    ok,
    status,
    statusText: status === 410 ? 'Gone' : 'Error',
    json: async () => body,
    blob: async () => new Blob(['x']),
  } as unknown as Response;
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('apiDownload — evidencia perdida (410)', () => {
  it('throws an ApiError carrying the status and the whole body', async () => {
    fetchMock.mockResolvedValue(respuesta(410, CUERPO_410));

    const err = await apiDownload('/api/files/abc', 'pod.pdf').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    const apiError = err as ApiError;
    expect(apiError.status).toBe(410);
    expect(apiError.body).toEqual(CUERPO_410);
  });

  it('surfaces the Spanish message rather than the HTTP reason phrase', async () => {
    fetchMock.mockResolvedValue(respuesta(410, CUERPO_410));

    const err = (await apiDownload('/api/files/abc', 'pod.pdf').catch((e: unknown) => e)) as ApiError;

    // The whole point: "Gone" told the user nothing. This sentence tells them the record survived.
    expect(err.message).toBe(CUERPO_410.error);
    expect(err.message).not.toBe('Gone');
  });

  it('keeps the contentHash reachable, so the artifact can still be proven and recovered', async () => {
    fetchMock.mockResolvedValue(respuesta(410, CUERPO_410));

    const err = (await apiDownload('/api/files/abc', 'pod.pdf').catch((e: unknown) => e)) as ApiError;

    expect(err.body.contentHash).toBe(CUERPO_410.contentHash);
    expect(err.body.codigo).toBe('EVIDENCIA_NO_DISPONIBLE');
  });
});

describe('apiDownload — the other outcomes', () => {
  it('distinguishes a 404 (we never had it) from a 410 (we had it and lost the bytes)', async () => {
    fetchMock.mockResolvedValue(respuesta(404, { error: 'Archivo no encontrado' }));

    const err = (await apiDownload('/api/files/nope', 'x.pdf').catch((e: unknown) => e)) as ApiError;

    expect(err.status).toBe(404);
    expect(err.message).toBe('Archivo no encontrado');
  });

  it('falls back to the status text when the body is not JSON (a proxy answering HTML)', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    } as unknown as Response);

    const err = (await apiDownload('/api/files/abc', 'x.pdf').catch((e: unknown) => e)) as ApiError;

    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(502);
    expect(err.message).toBe('Bad Gateway');
    expect(err.body).toEqual({});
  });

  it('still downloads on 200 — the error path did not swallow the happy one', async () => {
    const click = vi.fn();
    const createObjectURL = vi.fn(() => 'blob:fake');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });
    const anchor = document.createElement('a');
    anchor.click = click;
    const createElement = vi.spyOn(document, 'createElement').mockReturnValue(anchor);

    fetchMock.mockResolvedValue(respuesta(200, null, true));
    await expect(apiDownload('/api/files/ok', 'pod.pdf')).resolves.toBeUndefined();

    expect(click).toHaveBeenCalled();
    expect(anchor.download).toBe('pod.pdf');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake');
    createElement.mockRestore();
  });
});
