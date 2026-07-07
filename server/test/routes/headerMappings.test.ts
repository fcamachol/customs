import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { hashPassword } from '../../src/auth/password';
import { signToken } from '../../src/auth/token';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

const app = createApp();
let adminToken: string; let capToken: string; let clientId: string;

beforeEach(async () => {
  await truncateAll();
  const hash = await hashPassword('p');
  const a = await query(`INSERT INTO users (username,password_hash,role) VALUES ('a',$1,'admin') RETURNING id`, [hash]);
  adminToken = signToken({ userId: a.rows[0].id, role: 'admin', tv: 0 });
  const c = await query(`INSERT INTO users (username,password_hash,role) VALUES ('c',$1,'capturista') RETURNING id`, [hash]);
  capToken = signToken({ userId: c.rows[0].id, role: 'capturista', tv: 0 });
  const cl = await query(`INSERT INTO clients (name) VALUES ('ACME') RETURNING id`);
  clientId = cl.rows[0].id;
});

describe('header-mappings CRUD', () => {
  it('creates a client-specific mapping (normalizing the header) and lists it', async () => {
    const create = await request(app).post('/api/header-mappings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId, header: '  Detalle   Mercancía ', canonicalPath: 'core.description' });
    expect(create.status).toBe(201);
    expect(create.body.headerNormalized).toBe('detalle mercancia');
    expect(create.body.canonicalPath).toBe('core.description');
    expect(create.body.clientId).toBe(clientId);

    const list = await request(app).get(`/api/header-mappings?clientId=${clientId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].headerNormalized).toBe('detalle mercancia');
  });

  it('creates a global mapping (no clientId) and includes it in a client list', async () => {
    await request(app).post('/api/header-mappings').set('Authorization', `Bearer ${adminToken}`)
      .send({ header: 'Clave Global', canonicalPath: 'core.hsCode' });
    const list = await request(app).get(`/api/header-mappings?clientId=${clientId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(list.body.map((m: { headerNormalized: string }) => m.headerNormalized)).toContain('clave global');
    // Global list (no clientId) shows the global row too.
    const globalList = await request(app).get('/api/header-mappings').set('Authorization', `Bearer ${adminToken}`);
    expect(globalList.body).toHaveLength(1);
  });

  it('upserts the same (client, header) instead of duplicating', async () => {
    await request(app).post('/api/header-mappings').set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId, header: 'Detalle', canonicalPath: 'core.description' });
    const second = await request(app).post('/api/header-mappings').set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId, header: 'Detalle', canonicalPath: 'core.hsCode' });
    expect(second.status).toBe(201);
    const list = await request(app).get(`/api/header-mappings?clientId=${clientId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].canonicalPath).toBe('core.hsCode');
  });

  it('rejects an unknown canonical path with 400', async () => {
    const res = await request(app).post('/api/header-mappings').set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId, header: 'X', canonicalPath: 'core.notARealPath' });
    expect(res.status).toBe(400);
  });

  it('404s a mapping for a missing client', async () => {
    const res = await request(app).post('/api/header-mappings').set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId: '00000000-0000-0000-0000-000000000000', header: 'X', canonicalPath: 'core.hsCode' });
    expect(res.status).toBe(404);
  });

  it('deletes a mapping', async () => {
    const create = await request(app).post('/api/header-mappings').set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId, header: 'Borrar', canonicalPath: 'core.description' });
    const del = await request(app).delete(`/api/header-mappings/${create.body.id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(del.status).toBe(200);
    const list = await request(app).get(`/api/header-mappings?clientId=${clientId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(list.body).toHaveLength(0);
  });

  it('forbids a non-admin from creating, deleting, and listing', async () => {
    const create = await request(app).post('/api/header-mappings').set('Authorization', `Bearer ${capToken}`)
      .send({ clientId, header: 'X', canonicalPath: 'core.description' });
    expect(create.status).toBe(403);
    const list = await request(app).get('/api/header-mappings').set('Authorization', `Bearer ${capToken}`);
    expect(list.status).toBe(403);
    const del = await request(app).delete('/api/header-mappings/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${capToken}`);
    expect(del.status).toBe(403);
  });
});
