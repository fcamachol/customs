import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { hashPassword } from '../../src/auth/password';
import { signToken } from '../../src/auth/token';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

const app = createApp();
let adminToken: string; let clientId: string;

beforeEach(async () => {
  await truncateAll();
  const hash = await hashPassword('p');
  const u = await query(`INSERT INTO users (username,password_hash,role) VALUES ('a',$1,'admin') RETURNING id`, [hash]);
  adminToken = signToken({ userId: u.rows[0].id, role: 'admin', tv: 0 });
  const c = await query(`INSERT INTO clients (name) VALUES ('ACME') RETURNING id`);
  clientId = c.rows[0].id;
});

describe('client platforms CRUD', () => {
  it('adds a platform and returns it in GET /clients', async () => {
    const add = await request(app)
      .post(`/api/catalogs/clients/${clientId}/platforms`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ commercialName: 'Shop A', countryOfOrigin: 'CN', legalName: '', email: '' });
    expect(add.status).toBe(201);
    expect(add.body.id).toBeTruthy();
    expect(add.body.commercialName).toBe('Shop A');
    expect(add.body.legalName).toBeNull();

    const list = await request(app).get('/api/catalogs/clients').set('Authorization', `Bearer ${adminToken}`);
    expect(list.status).toBe(200);
    const acme = list.body.find((c: { id: string }) => c.id === clientId);
    expect(acme.platforms).toHaveLength(1);
    expect(acme.platforms[0].commercialName).toBe('Shop A');
  });

  it('returns an empty platforms array for a client with none', async () => {
    const list = await request(app).get('/api/catalogs/clients').set('Authorization', `Bearer ${adminToken}`);
    const acme = list.body.find((c: { id: string }) => c.id === clientId);
    expect(acme.platforms).toEqual([]);
  });

  it('edits a platform', async () => {
    const add = await request(app).post(`/api/catalogs/clients/${clientId}/platforms`)
      .set('Authorization', `Bearer ${adminToken}`).send({ commercialName: 'Old' });
    const pid = add.body.id;
    const put = await request(app).put(`/api/catalogs/clients/${clientId}/platforms/${pid}`)
      .set('Authorization', `Bearer ${adminToken}`).send({ commercialName: 'New', countryOfOrigin: 'US' });
    expect(put.status).toBe(200);
    expect(put.body.commercialName).toBe('New');
    expect(put.body.countryOfOrigin).toBe('US');
  });

  it('deletes a platform', async () => {
    const add = await request(app).post(`/api/catalogs/clients/${clientId}/platforms`)
      .set('Authorization', `Bearer ${adminToken}`).send({ commercialName: 'X' });
    const del = await request(app).delete(`/api/catalogs/clients/${clientId}/platforms/${add.body.id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(del.status).toBe(200);
    const list = await request(app).get('/api/catalogs/clients').set('Authorization', `Bearer ${adminToken}`);
    expect(list.body.find((c: { id: string }) => c.id === clientId).platforms).toEqual([]);
  });

  it('404s adding a platform to a missing client', async () => {
    const res = await request(app)
      .post('/api/catalogs/clients/00000000-0000-0000-0000-000000000000/platforms')
      .set('Authorization', `Bearer ${adminToken}`).send({ commercialName: 'X' });
    expect(res.status).toBe(404);
  });
});
