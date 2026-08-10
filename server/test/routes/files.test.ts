import { beforeEach, describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import request from 'supertest';
import { createApp } from '../../src/app';
import { hashPassword } from '../../src/auth/password';
import { signToken } from '../../src/auth/token';
import { saveFile } from '../../src/storage/files';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

const app = createApp();
let token: string;

beforeEach(async () => {
  await truncateAll();
  const hash = await hashPassword('p');
  const u = await query(`INSERT INTO users (username,password_hash,role) VALUES ('c',$1,'capturista') RETURNING id`, [hash]);
  token = signToken({ userId: u.rows[0].id, role: 'capturista' , tv: 0 });
});

interface FilaAudit { action: string; entity_id: string; after: Record<string, unknown> | null }

/**
 * The success audit row is written when the transfer FINISHES — i.e. after the client already has
 * the response. Polling for it briefly is the honest way to assert it: reading the table the instant
 * supertest resolves would be a race, not a test.
 */
async function esperarAudit(action: string, timeoutMs = 3000): Promise<FilaAudit[]> {
  const hasta = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await query<FilaAudit>(
      `SELECT action, entity_id, after FROM audit_log WHERE action=$1 ORDER BY id ASC`, [action]);
    if (rows.length || Date.now() > hasta) return rows;
    await new Promise((r) => setTimeout(r, 25));
  }
}

function descargar(id: string) {
  return request(app)
    .get(`/api/files/${id}`)
    .set('Authorization', `Bearer ${token}`)
    .buffer()
    .parse((r, cb) => {
      const chunks: Buffer[] = []; r.on('data', (c) => chunks.push(c as Buffer)); r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
}

describe('GET /api/files/:id', () => {
  it('streams the stored file bytes for a valid id', async () => {
    const buf = Buffer.from('downloadable content');
    const meta = await saveFile({ kind: 'pedimento_pdf', originalName: 'p.pdf', bytes: buf, uploadedBy: null });
    const res = await descargar(meta.id);
    expect(res.status).toBe(200);
    expect(Buffer.from(res.body).toString()).toBe('downloadable content');
  });

  it('returns 404 for an unknown id', async () => {
    const res = await request(app)
      .get('/api/files/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it('audits a completed download exactly once, as a success', async () => {
    const meta = await saveFile({ kind: 'pedimento_pdf', originalName: 'p.pdf', bytes: Buffer.from('x'), uploadedBy: null });
    await descargar(meta.id);

    const filas = await esperarAudit('DOWNLOAD_FILE');
    expect(filas.length).toBe(1);
    expect(filas[0].entity_id).toBe(meta.id);
    const fallos = await query(
      `SELECT action FROM audit_log WHERE action IN ('DOWNLOAD_FILE_UNAVAILABLE','DOWNLOAD_FILE_FAILED')`);
    expect(fallos.rows.length).toBe(0);
  });
});

/**
 * The ephemeral-storage failure (#39): `FILE_STORAGE_DIR` had no persistent volume in production, so
 * a redeploy destroyed the bytes while the row and its sha256 survived. What the API says about that
 * is the product's honesty on the line — a 500 would read as "retry later" and bury a data-loss
 * incident, so the row's continued existence and its hash have to come back instead.
 */
describe('GET /api/files/:id when the stored blob is gone (backlog #39)', () => {
  async function archivoHuerfano() {
    const bytes = Buffer.from('evidencia archivada que se perdió en el redespliegue');
    const meta = await saveFile({ kind: 'awb', originalName: 'awb-160-05930216.pdf', bytes, uploadedBy: null });
    await unlink(meta.storagePath);
    return { meta, bytes };
  }

  it('answers 410 Gone carrying the stored content hash', async () => {
    const { meta, bytes } = await archivoHuerfano();

    const res = await request(app).get(`/api/files/${meta.id}`).set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(410);
    expect(res.body.codigo).toBe('evidencia_no_disponible');
    expect(res.body.fileId).toBe(meta.id);
    // The hash is the point: the caller can still prove what the artifact was.
    expect(res.body.contentHash).toBe(meta.contentHash);
    expect(res.body.contentHash).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(res.body.originalName).toBe('awb-160-05930216.pdf');
    expect(res.body.kind).toBe('awb');
    expect(res.body.sizeBytes).toBe(bytes.length);
    expect(typeof res.body.error).toBe('string');
  });

  it('keeps the server storage path out of the response body', async () => {
    const { meta } = await archivoHuerfano();
    const res = await request(app).get(`/api/files/${meta.id}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(410);
    expect(JSON.stringify(res.body)).not.toContain(meta.storagePath);
  });

  it('audits the miss distinctly and never as a completed download', async () => {
    const { meta } = await archivoHuerfano();

    await request(app).get(`/api/files/${meta.id}`).set('Authorization', `Bearer ${token}`);

    const filas = await esperarAudit('DOWNLOAD_FILE_UNAVAILABLE');
    expect(filas.length).toBe(1);
    expect(filas[0].entity_id).toBe(meta.id);
    const after = (filas[0].after ?? {}) as Record<string, unknown>;
    expect(after.contentHash).toBe(meta.contentHash);
    // The operator needs to know WHICH path lost the blob; only the client is kept from seeing it.
    expect(after.storagePath).toBe(meta.storagePath);

    const exitos = await query(`SELECT id FROM audit_log WHERE action='DOWNLOAD_FILE'`);
    expect(exitos.rows.length).toBe(0);
  });

  it('still answers 404 — never 410 — for a file that never existed', async () => {
    const res = await request(app)
      .get('/api/files/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
    const audit = await query(
      `SELECT id FROM audit_log WHERE action IN ('DOWNLOAD_FILE','DOWNLOAD_FILE_UNAVAILABLE')`);
    expect(audit.rows.length).toBe(0);
  });
});
