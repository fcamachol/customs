import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query } from '../../src/db/pool';
import { hashPassword } from '../../src/auth/password';
import { signToken } from '../../src/auth/token';
import { truncateAll } from '../helpers/db';
import type { CincelOutcome } from '../../src/services/cincel';

/**
 * Convenios — upload + NOM-151 signature via Cincel (PRD-02 Excel item 8, R25/D9).
 *
 * What matters here, mirrored from `campo.test.ts`'s evidencia tests and `mailer`/`requerimientos`'
 * three-outcome discipline:
 *   - the uploaded document lands hashed (sha256) BEFORE the convenio row exists (rule R-A)
 *   - `estado_firma` only ever advances to `solicitada` on a CONFIRMED Cincel dispatch — never on
 *     an attempt that was `omitido` (Cincel unconfigured) or `error`
 *   - the completion webhook is HMAC-verified like `routes/prealertas.ts`'s inbound webhook, is
 *     idempotent on a repeat delivery, and stores the NOM-151 evidence hashed like any other artifact
 *   - every state change is on the audit hash chain (`CONVENIO_CARGADO`, `FIRMA_SOLICITADA`,
 *     `FIRMA_COMPLETADA`)
 *
 * `services/cincel.ts` is mocked at the module boundary for the `/firmar` tests — what is under test
 * there is that the route persists each of the three outcomes correctly, not Cincel's wire protocol
 * (that lives in `cincel.test.ts`, against a mocked `fetch`). The webhook tests, by contrast, exercise
 * the REAL `verifyCincelSignature` with a real HMAC, because that check is the endpoint's only gate.
 *
 * `FILE_STORAGE_DIR` is set before `storage/files.ts` is loaded (it resolves the directory once at
 * module scope), hence the dynamic imports below — same pattern as `campo.test.ts`.
 */
const scratch = mkdtempSync(join(tmpdir(), 'convenios-'));
process.env.FILE_STORAGE_DIR = scratch;

const solicitarFirmaMock = vi.fn<(...args: unknown[]) => Promise<CincelOutcome>>();
vi.mock('../../src/services/cincel', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/cincel')>(
    '../../src/services/cincel',
  );
  return {
    ...actual,
    solicitarFirma: (...a: unknown[]) => solicitarFirmaMock(...a),
  };
});

const { createApp } = await import('../../src/app');
const app = createApp();

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< >>\nendobj\ntrailer\n<< >>\n%%EOF\n');

let adminToken: string;
let autoridadToken: string;
let clientId: string;

const WEBHOOK_SECRET = 'cincel-webhook-secret';

function signCincelWebhook(body: Buffer, secret = WEBHOOK_SECRET, tMs = Date.now()): string {
  const t = Math.floor(tMs / 1000);
  const v1 = createHmac('sha256', secret).update(`${t}.${body.toString('utf8')}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

beforeEach(async () => {
  await truncateAll();
  vi.clearAllMocks();
  process.env.CINCEL_WEBHOOK_SECRET = WEBHOOK_SECRET;
  delete process.env.CINCEL_SIGNATURE_TOLERANCE_SEC;

  const hash = await hashPassword('p');
  const [adm, auto, cl] = await Promise.all([
    query<{ id: string }>(
      `INSERT INTO users (username,password_hash,role) VALUES ('adm-conv',$1,'admin') RETURNING id`,
      [hash],
    ),
    query<{ id: string }>(
      `INSERT INTO users (username,password_hash,role) VALUES ('auto-conv',$1,'autoridad') RETURNING id`,
      [hash],
    ),
    query<{ id: string }>(
      `INSERT INTO clients (name, email) VALUES ('Cliente de Prueba SA de CV', 'cliente@example.com') RETURNING id`,
    ),
  ]);
  adminToken = signToken({ userId: adm.rows[0].id, role: 'admin', tv: 0 });
  autoridadToken = signToken({ userId: auto.rows[0].id, role: 'autoridad', tv: 0 });
  clientId = cl.rows[0].id;
});

describe('POST /api/convenios — upload', () => {
  it('stores the file with its sha256, a borrador convenio row and a CONVENIO_CARGADO audit row', async () => {
    const res = await request(app)
      .post('/api/convenios')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('clientId', clientId)
      .field('vigenciaDesde', '2026-01-01')
      .field('vigenciaHasta', '2027-01-01')
      .attach('file', PDF, 'convenio.pdf');

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ clientId, estadoFirma: 'borrador' });

    const esperado = createHash('sha256').update(PDF).digest('hex');
    const file = await query<{ kind: string; content_hash: string }>(
      'SELECT kind, content_hash FROM files WHERE id=$1',
      [res.body.fileId],
    );
    expect(file.rows[0]).toMatchObject({ kind: 'convenio', content_hash: esperado });

    const audit = await query<{ after: Record<string, unknown> }>(
      `SELECT after FROM audit_log WHERE action='CONVENIO_CARGADO'`,
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].after).toMatchObject({ clientId, contentHash: esperado });
  });

  it('404s for an unknown client', async () => {
    const res = await request(app)
      .post('/api/convenios')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('clientId', '00000000-0000-0000-0000-000000000000')
      .attach('file', PDF, 'convenio.pdf');
    expect(res.status).toBe(404);
    expect((await query('SELECT id FROM files')).rows).toHaveLength(0);
  });

  it('refuses a content type that is not a PDF or an image', async () => {
    const res = await request(app)
      .post('/api/convenios')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('clientId', clientId)
      .attach('file', Buffer.from('#!/bin/sh\nrm -rf /\n'), {
        filename: 'evil.sh',
        contentType: 'application/x-sh',
      });
    expect(res.status).toBe(400);
    expect((await query('SELECT id FROM convenios')).rows).toHaveLength(0);
  });

  it('refuses an upload with no file', async () => {
    const res = await request(app)
      .post('/api/convenios')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('clientId', clientId);
    expect(res.status).toBe(400);
  });

  it('refuses autoridad — uploading a contract is an admin act', async () => {
    await request(app)
      .post('/api/convenios')
      .set('Authorization', `Bearer ${autoridadToken}`)
      .field('clientId', clientId)
      .attach('file', PDF, 'convenio.pdf')
      .expect(403);
  });

  it('requires auth', async () => {
    await request(app).post('/api/convenios').field('clientId', clientId).expect(401);
  });
});

async function subirConvenio(): Promise<{ id: string; fileId: string }> {
  const res = await request(app)
    .post('/api/convenios')
    .set('Authorization', `Bearer ${adminToken}`)
    .field('clientId', clientId)
    .attach('file', PDF, 'convenio.pdf');
  return { id: res.body.id, fileId: res.body.fileId };
}

describe('GET /api/convenios and /api/convenios/:id', () => {
  it('lists convenios, optionally filtered by clientId, and reads one back in full', async () => {
    const { id } = await subirConvenio();

    const lista = await request(app)
      .get('/api/convenios')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(lista.status).toBe(200);
    expect(lista.body).toHaveLength(1);
    expect(lista.body[0]).toMatchObject({ id, clientId, clientNombre: 'Cliente de Prueba SA de CV' });

    const filtrada = await request(app)
      .get(`/api/convenios?clientId=${clientId}`)
      .set('Authorization', `Bearer ${autoridadToken}`);
    expect(filtrada.body).toHaveLength(1);

    const otraVacia = await request(app)
      .get(`/api/convenios?clientId=00000000-0000-0000-0000-000000000000`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(otraVacia.body).toHaveLength(0);

    const detalle = await request(app)
      .get(`/api/convenios/${id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(detalle.status).toBe(200);
    expect(detalle.body).toMatchObject({ id, clientEmail: 'cliente@example.com', estadoFirma: 'borrador' });
  });

  it('404s for an unknown convenio', async () => {
    await request(app)
      .get('/api/convenios/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(404);
  });
});

describe('POST /api/convenios/:id/firmar — dispatch', () => {
  it('advances estado_firma to solicitada only on a confirmed CINCEL dispatch', async () => {
    const { id } = await subirConvenio();
    solicitarFirmaMock.mockResolvedValue({
      status: 'enviado',
      solicitudId: 'cincel-doc-1',
      firmaUrl: 'https://cincel.example.com/sign/1',
    });

    const res = await request(app)
      .post(`/api/convenios/${id}/firmar`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, estadoFirma: 'solicitada' });

    const row = await query<{
      estado_firma: string;
      cincel_solicitud_id: string;
      firma_url: string;
      solicitud_firma_estado: string;
      solicitado_at: Date | null;
    }>(
      `SELECT estado_firma, cincel_solicitud_id, firma_url, solicitud_firma_estado, solicitado_at
         FROM convenios WHERE id=$1`,
      [id],
    );
    expect(row.rows[0]).toMatchObject({
      estado_firma: 'solicitada',
      cincel_solicitud_id: 'cincel-doc-1',
      firma_url: 'https://cincel.example.com/sign/1',
      solicitud_firma_estado: 'enviada',
    });
    expect(row.rows[0].solicitado_at).not.toBeNull();

    // Resolved from the client row, since the request body sent neither.
    expect(solicitarFirmaMock).toHaveBeenCalledWith(
      expect.objectContaining({ signerEmail: 'cliente@example.com', convenioId: id }),
    );

    const audit = await query(`SELECT after FROM audit_log WHERE action='FIRMA_SOLICITADA'`);
    expect(audit.rows).toHaveLength(1);
  });

  it('leaves estado_firma at borrador when CINCEL is unconfigured (omitido) — records it, never throws', async () => {
    const { id } = await subirConvenio();
    solicitarFirmaMock.mockResolvedValue({
      status: 'omitido',
      motivo: 'CINCEL no configurado (CINCEL_API_URL/CINCEL_API_KEY)',
    });

    const res = await request(app)
      .post(`/api/convenios/${id}/firmar`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ estadoFirma: 'borrador' });
    expect(res.body.cincel.status).toBe('omitido');

    const row = await query<{ estado_firma: string; solicitud_firma_estado: string; solicitado_at: Date | null }>(
      'SELECT estado_firma, solicitud_firma_estado, solicitado_at FROM convenios WHERE id=$1',
      [id],
    );
    expect(row.rows[0]).toMatchObject({ estado_firma: 'borrador', solicitud_firma_estado: 'omitida' });
    expect(row.rows[0].solicitado_at).toBeNull();
  });

  it('leaves estado_firma untouched on a CINCEL error and allows a retry', async () => {
    const { id } = await subirConvenio();
    solicitarFirmaMock.mockResolvedValue({ status: 'error', error: 'ECONNREFUSED' });

    const primero = await request(app)
      .post(`/api/convenios/${id}/firmar`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(primero.body.estadoFirma).toBe('borrador');

    solicitarFirmaMock.mockResolvedValue({
      status: 'enviado',
      solicitudId: 'cincel-doc-retry',
      firmaUrl: null,
    });
    const segundo = await request(app)
      .post(`/api/convenios/${id}/firmar`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(segundo.body.estadoFirma).toBe('solicitada');

    const row = await query<{ solicitud_firma_intentos: number }>(
      'SELECT solicitud_firma_intentos FROM convenios WHERE id=$1',
      [id],
    );
    expect(row.rows[0].solicitud_firma_intentos).toBe(2);
  });

  it('uses an explicit signer override when the body provides one', async () => {
    const { id } = await subirConvenio();
    solicitarFirmaMock.mockResolvedValue({ status: 'enviado', solicitudId: 'x', firmaUrl: null });

    await request(app)
      .post(`/api/convenios/${id}/firmar`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ signerNombre: 'Apoderado Legal', signerEmail: 'legal@example.com' });

    expect(solicitarFirmaMock).toHaveBeenCalledWith(
      expect.objectContaining({ signerName: 'Apoderado Legal', signerEmail: 'legal@example.com' }),
    );
  });

  it('409s a re-request against an already-firmada convenio', async () => {
    const { id } = await subirConvenio();
    await query(`UPDATE convenios SET estado_firma='firmada' WHERE id=$1`, [id]);

    const res = await request(app)
      .post(`/api/convenios/${id}/firmar`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(409);
    expect(solicitarFirmaMock).not.toHaveBeenCalled();
  });

  it('404s for an unknown convenio', async () => {
    await request(app)
      .post('/api/convenios/00000000-0000-0000-0000-000000000000/firmar')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
      .expect(404);
  });

  it('refuses autoridad', async () => {
    const { id } = await subirConvenio();
    await request(app)
      .post(`/api/convenios/${id}/firmar`)
      .set('Authorization', `Bearer ${autoridadToken}`)
      .send({})
      .expect(403);
  });
});

describe('POST /api/convenios/cincel/webhook — signature completion', () => {
  const evidenciaBase64 = Buffer.from('%PDF-1.4 constancia NOM-151').toString('base64');

  async function conCincelSolicitado(): Promise<string> {
    const { id } = await subirConvenio();
    await query(
      `UPDATE convenios SET estado_firma='solicitada', cincel_solicitud_id='cincel-doc-99' WHERE id=$1`,
      [id],
    );
    return id;
  }

  it('marks the convenio firmada and stores the NOM-151 evidence hashed', async () => {
    const id = await conCincelSolicitado();
    const body = Buffer.from(
      JSON.stringify({
        event: 'document.completed',
        document: { id: 'cincel-doc-99', status: 'completed' },
        evidence: { filename: 'constancia.pdf', contentBase64: evidenciaBase64 },
      }),
    );

    const res = await request(app)
      .post('/api/convenios/cincel/webhook')
      .type('json')
      .set('X-Cincel-Signature', signCincelWebhook(body))
      .send(body.toString('utf8'));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, convenioId: id });

    const row = await query<{ estado_firma: string; firmado_at: Date | null; firma_evidencia_file_id: string }>(
      'SELECT estado_firma, firmado_at, firma_evidencia_file_id FROM convenios WHERE id=$1',
      [id],
    );
    expect(row.rows[0].estado_firma).toBe('firmada');
    expect(row.rows[0].firmado_at).not.toBeNull();
    expect(row.rows[0].firma_evidencia_file_id).toBeTruthy();

    const esperado = createHash('sha256').update(Buffer.from(evidenciaBase64, 'base64')).digest('hex');
    const file = await query<{ kind: string; content_hash: string }>(
      'SELECT kind, content_hash FROM files WHERE id=$1',
      [row.rows[0].firma_evidencia_file_id],
    );
    expect(file.rows[0]).toMatchObject({ kind: 'convenio', content_hash: esperado });

    const audit = await query(`SELECT after FROM audit_log WHERE action='FIRMA_COMPLETADA'`);
    expect(audit.rows).toHaveLength(1);
  });

  it('is idempotent on a redelivery of the same completion', async () => {
    await conCincelSolicitado();
    const body = Buffer.from(
      JSON.stringify({
        event: 'document.completed',
        document: { id: 'cincel-doc-99' },
        evidence: { contentBase64: evidenciaBase64 },
      }),
    );
    const header = signCincelWebhook(body);

    await request(app)
      .post('/api/convenios/cincel/webhook')
      .type('json')
      .set('X-Cincel-Signature', header)
      .send(body.toString('utf8'))
      .expect(200);

    const segundo = await request(app)
      .post('/api/convenios/cincel/webhook')
      .type('json')
      .set('X-Cincel-Signature', signCincelWebhook(body))
      .send(body.toString('utf8'));
    expect(segundo.status).toBe(202);
    expect(segundo.body).toMatchObject({ ok: true, noop: true });

    expect((await query(`SELECT id FROM audit_log WHERE action='FIRMA_COMPLETADA'`)).rows).toHaveLength(1);
    expect((await query(`SELECT id FROM files WHERE kind='convenio'`)).rows).toHaveLength(2); // upload + evidence, once
  });

  it('ignores (202) an event type it does not act on', async () => {
    const body = Buffer.from(JSON.stringify({ event: 'document.created', document: { id: 'cincel-doc-99' } }));
    const res = await request(app)
      .post('/api/convenios/cincel/webhook')
      .type('json')
      .set('X-Cincel-Signature', signCincelWebhook(body))
      .send(body.toString('utf8'));
    expect(res.status).toBe(202);
    expect(res.body.ignorado).toBe(true);
  });

  it('ignores (202) a document.id with no matching convenio', async () => {
    const body = Buffer.from(
      JSON.stringify({ event: 'document.completed', document: { id: 'unknown-doc' }, evidence: { contentBase64: evidenciaBase64 } }),
    );
    const res = await request(app)
      .post('/api/convenios/cincel/webhook')
      .type('json')
      .set('X-Cincel-Signature', signCincelWebhook(body))
      .send(body.toString('utf8'));
    expect(res.status).toBe(202);
    expect(res.body.motivo).toBe('convenio_no_encontrado');
  });

  it('rejects a missing/invalid signature', async () => {
    const body = Buffer.from(JSON.stringify({ event: 'document.completed', document: { id: 'x' } }));
    await request(app).post('/api/convenios/cincel/webhook').type('json').send(body.toString('utf8')).expect(401);
    await request(app)
      .post('/api/convenios/cincel/webhook')
      .type('json')
      .set('X-Cincel-Signature', 't=1,v1=deadbeef')
      .send(body.toString('utf8'))
      .expect(401);
  });

  it('fails closed (503) when CINCEL_WEBHOOK_SECRET is not configured', async () => {
    delete process.env.CINCEL_WEBHOOK_SECRET;
    const body = Buffer.from(JSON.stringify({ event: 'document.completed', document: { id: 'x' } }));
    const res = await request(app)
      .post('/api/convenios/cincel/webhook')
      .type('json')
      .set('X-Cincel-Signature', signCincelWebhook(body, 'irrelevant'))
      .send(body.toString('utf8'));
    expect(res.status).toBe(503);
  });

  it('400s a completion event with no document.id', async () => {
    const body = Buffer.from(JSON.stringify({ event: 'document.completed', document: {} }));
    const res = await request(app)
      .post('/api/convenios/cincel/webhook')
      .type('json')
      .set('X-Cincel-Signature', signCincelWebhook(body))
      .send(body.toString('utf8'));
    expect(res.status).toBe(400);
  });

  it('400s a completion event with no evidence payload', async () => {
    const id = await conCincelSolicitado();
    const body = Buffer.from(JSON.stringify({ event: 'document.completed', document: { id: 'cincel-doc-99' } }));
    const res = await request(app)
      .post('/api/convenios/cincel/webhook')
      .type('json')
      .set('X-Cincel-Signature', signCincelWebhook(body))
      .send(body.toString('utf8'));
    expect(res.status).toBe(400);
    const row = await query<{ estado_firma: string }>('SELECT estado_firma FROM convenios WHERE id=$1', [id]);
    expect(row.rows[0].estado_firma).toBe('solicitada');
  });
});
