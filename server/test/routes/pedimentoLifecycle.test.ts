import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { hashPassword } from '../../src/auth/password';
import { signToken } from '../../src/auth/token';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

const app = createApp();
let token: string;          // admin (owner)
let capturistaToken: string; // capturista (owner)
let otherToken: string;     // capturista B (non-owner)
let autoridadToken: string; // autoridad (cannot write)
let capId: string;
let otherId: string;
let manifestId: string;

async function addPedimento(
  mId: string,
  fields: { subStatus?: string; ownedBy?: string } = {},
) {
  const ownerId = fields.ownedBy ?? capId;
  const r = await query<{ id: string }>(
    `INSERT INTO pedimentos (manifest_id, numero_pedimento, sub_status, created_by)
     VALUES ($1, '111', $2, $3) RETURNING id`,
    [mId, fields.subStatus ?? 'pendiente', ownerId],
  );
  return r.rows[0].id;
}

beforeEach(async () => {
  await truncateAll();
  const hash = await hashPassword('p');

  const adminRes = await query(
    `INSERT INTO users (username, password_hash, role) VALUES ('admin', $1, 'admin') RETURNING id`,
    [hash],
  );
  const adminId = adminRes.rows[0].id;
  token = signToken({ userId: adminId, role: 'admin', tv: 0 });

  const capRes = await query(
    `INSERT INTO users (username, password_hash, role) VALUES ('cap', $1, 'capturista') RETURNING id`,
    [hash],
  );
  capId = capRes.rows[0].id;
  capturistaToken = signToken({ userId: capId, role: 'capturista', tv: 0 });

  const otherRes = await query(
    `INSERT INTO users (username, password_hash, role) VALUES ('other', $1, 'capturista') RETURNING id`,
    [hash],
  );
  otherId = otherRes.rows[0].id;
  otherToken = signToken({ userId: otherId, role: 'capturista', tv: 0 });

  const autRes = await query(
    `INSERT INTO users (username, password_hash, role) VALUES ('aut', $1, 'autoridad') RETURNING id`,
    [hash],
  );
  autoridadToken = signToken({ userId: autRes.rows[0].id, role: 'autoridad', tv: 0 });

  const mRes = await query(
    `INSERT INTO manifests (mawb_reference, client_name, created_by) VALUES ('TEST-001', 'Cliente Test', $1) RETURNING id`,
    [capId],
  );
  manifestId = mRes.rows[0].id;
});

describe('POST /api/pedimentos/:id/finalize', () => {
  it('finalize: prevalidado -> cargado (then locked: capture 409)', async () => {
    const pid = await addPedimento(manifestId, { subStatus: 'prevalidado' });

    const res = await request(app)
      .post(`/api/pedimentos/${pid}/finalize`)
      .set('Authorization', `Bearer ${capturistaToken}`);

    expect(res.status).toBe(200);
    expect(res.body.subStatus).toBe('cargado');

    const { rows } = await query(`SELECT sub_status FROM pedimentos WHERE id=$1`, [pid]);
    expect(rows[0].sub_status).toBe('cargado');

    // now locked: capture should 409
    const cap = await request(app)
      .post(`/api/pedimentos/${pid}/import-data`)
      .set('Authorization', `Bearer ${capturistaToken}`)
      .send({ patente: 'x', version: 0 });
    expect(cap.status).toBe(409);
  });

  it('finalize rejected when not prevalidado (409)', async () => {
    const pid = await addPedimento(manifestId, { subStatus: 'capturado' });
    const res = await request(app)
      .post(`/api/pedimentos/${pid}/finalize`)
      .set('Authorization', `Bearer ${capturistaToken}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBeTruthy();
  });

  it('finalize 404 for unknown id', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000000';
    const res = await request(app)
      .post(`/api/pedimentos/${fakeId}/finalize`)
      .set('Authorization', `Bearer ${capturistaToken}`);
    expect(res.status).toBe(404);
  });

  it('finalize 403 for autoridad (requireRole blocks write)', async () => {
    const pid = await addPedimento(manifestId, { subStatus: 'prevalidado' });
    const res = await request(app)
      .post(`/api/pedimentos/${pid}/finalize`)
      .set('Authorization', `Bearer ${autoridadToken}`);
    expect(res.status).toBe(403);
  });

  it('admin can finalize a pedimento owned by another capturista', async () => {
    // All capturistas share visibility (canSeeAll=true), admin also passes
    const pid = await addPedimento(manifestId, { subStatus: 'prevalidado', ownedBy: otherId });
    const res = await request(app)
      .post(`/api/pedimentos/${pid}/finalize`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.subStatus).toBe('cargado');
  });
});

describe('POST /api/pedimentos/:id/reopen', () => {
  it('reopen: rechazado -> capturado', async () => {
    const pid = await addPedimento(manifestId, { subStatus: 'rechazado' });
    const res = await request(app)
      .post(`/api/pedimentos/${pid}/reopen`)
      .set('Authorization', `Bearer ${capturistaToken}`);

    expect(res.status).toBe(200);
    expect(res.body.subStatus).toBe('capturado');

    const { rows } = await query(`SELECT sub_status FROM pedimentos WHERE id=$1`, [pid]);
    expect(rows[0].sub_status).toBe('capturado');
  });

  it('reopen rejected when not rechazado (409)', async () => {
    const pid = await addPedimento(manifestId, { subStatus: 'capturado' });
    const res = await request(app)
      .post(`/api/pedimentos/${pid}/reopen`)
      .set('Authorization', `Bearer ${capturistaToken}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBeTruthy();
  });

  it('reopen 404 for unknown id', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000000';
    const res = await request(app)
      .post(`/api/pedimentos/${fakeId}/reopen`)
      .set('Authorization', `Bearer ${capturistaToken}`);
    expect(res.status).toBe(404);
  });

  it('reopen 403 for autoridad (requireRole blocks write)', async () => {
    const pid = await addPedimento(manifestId, { subStatus: 'rechazado' });
    const res = await request(app)
      .post(`/api/pedimentos/${pid}/reopen`)
      .set('Authorization', `Bearer ${autoridadToken}`);
    expect(res.status).toBe(403);
  });
});
