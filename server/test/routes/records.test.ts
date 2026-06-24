import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { hashPassword } from '../../src/auth/password';
import { signToken } from '../../src/auth/token';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

const app = createApp();
let token: string;
let userId: string;

beforeEach(async () => {
  await truncateAll();
  const hash = await hashPassword('p');
  const u = await query(`INSERT INTO users (username,password_hash,role) VALUES ('c',$1,'capturista') RETURNING id`, [hash]);
  userId = u.rows[0].id;
  token = signToken({ userId, role: 'capturista' , tv: 0 });
  await query(`INSERT INTO manifests (mawb_reference, client_name, created_by) VALUES ('369-1','Cliente A',$1),('370-2','Cliente B',$1)`, [userId]);
});

describe('records', () => {
  it('searches by MAWB – Cliente', async () => {
    const res = await request(app).get('/api/records?q=Cliente%20A').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].clientName).toBe('Cliente A');
  });

  it('returns a single record with its 3 artifacts in Consulta', async () => {
    const list = await request(app).get('/api/records?q=369-1').set('Authorization', `Bearer ${token}`);
    const id = list.body[0].id;
    const res = await request(app).get(`/api/records/${id}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('artifacts');
    expect(res.body.artifacts).toHaveProperty('riskAnalysis');
    expect(res.body.artifacts).toHaveProperty('pedimentoPdf');
    expect(res.body.artifacts).toHaveProperty('report');
  });
});

describe('records — Consulta filters', () => {
  const auth = () => ({ Authorization: `Bearer ${token}` });

  it('filters by exact client name', async () => {
    const res = await request(app).get('/api/records?clientName=Cliente%20A').set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].clientName).toBe('Cliente A');
  });

  it('filters by risk result: verde matches manifests containing a verde shipment', async () => {
    const m = await query(`INSERT INTO manifests (mawb_reference, client_name, created_by) VALUES ('500-9','Cliente C',$1) RETURNING id`, [userId]);
    await query(`INSERT INTO shipments (id, manifest_id, data, risk_color) VALUES (gen_random_uuid(), $1, '{}'::jsonb, 'verde')`, [m.rows[0].id]);
    const res = await request(app).get('/api/records?result=verde').set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].mawbReference).toBe('500-9');
  });

  it('filters by risk result: gris matches manifests with no scored shipments', async () => {
    const m = await query(`INSERT INTO manifests (mawb_reference, client_name, created_by) VALUES ('500-9','Cliente C',$1) RETURNING id`, [userId]);
    await query(`INSERT INTO shipments (id, manifest_id, data, risk_color) VALUES (gen_random_uuid(), $1, '{}'::jsonb, 'verde')`, [m.rows[0].id]);
    const res = await request(app).get('/api/records?result=gris').set(auth());
    expect(res.status).toBe(200);
    // The two seeded manifests have no shipments; the verde one is excluded.
    expect(res.body).toHaveLength(2);
    expect(res.body.map((r: { mawbReference: string }) => r.mawbReference).sort()).toEqual(['369-1', '370-2']);
  });

  it('filters by platform id', async () => {
    const c = await query(`INSERT INTO clients (name, created_by) VALUES ('Cliente A',$1) RETURNING id`, [userId]);
    const p = await query(`INSERT INTO client_platforms (client_id, commercial_name, created_by) VALUES ($1,'Tienda A',$2) RETURNING id`, [c.rows[0].id, userId]);
    await query(`INSERT INTO manifests (mawb_reference, client_name, platform_id, created_by) VALUES ('600-1','Cliente A',$1,$2)`, [p.rows[0].id, userId]);
    const res = await request(app).get(`/api/records?platformId=${p.rows[0].id}`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].mawbReference).toBe('600-1');
  });

  it('ignores malformed filter values and a future dateFrom returns nothing', async () => {
    // Non-uuid platformId is ignored (no SQL error); future dateFrom excludes today's records.
    const ignored = await request(app).get('/api/records?platformId=not-a-uuid').set(auth());
    expect(ignored.status).toBe(200);
    expect(ignored.body.length).toBeGreaterThanOrEqual(2);

    const future = await request(app).get('/api/records?dateFrom=2099-01-01').set(auth());
    expect(future.status).toBe(200);
    expect(future.body).toHaveLength(0);
  });
});
