import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { hashPassword } from '../../src/auth/password';
import { signToken } from '../../src/auth/token';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

const app = createApp();
let tokenA: string; // capturista A (owner)
let tokenB: string; // capturista B (non-owner)
let tokenAut: string; // autoridad
let manifestId: string;

beforeEach(async () => {
  await truncateAll();
  const hash = await hashPassword('p');
  const a = await query(`INSERT INTO users (username,password_hash,role) VALUES ('a',$1,'capturista') RETURNING id`, [hash]);
  const b = await query(`INSERT INTO users (username,password_hash,role) VALUES ('b',$1,'capturista') RETURNING id`, [hash]);
  const aut = await query(`INSERT INTO users (username,password_hash,role) VALUES ('aut',$1,'autoridad') RETURNING id`, [hash]);
  tokenA = signToken({ userId: a.rows[0].id, role: 'capturista' });
  tokenB = signToken({ userId: b.rows[0].id, role: 'capturista' });
  tokenAut = signToken({ userId: aut.rows[0].id, role: 'autoridad' });
  const m = await query(
    `INSERT INTO manifests (mawb_reference, client_name, created_by) VALUES ('369-1','Cliente A',$1) RETURNING id`,
    [a.rows[0].id]);
  manifestId = m.rows[0].id;
});

describe('ownership scoping', () => {
  // PRD RF-22: capturistas share visibility — B can see A's manifests in the list
  it('capturista B sees A\'s manifest in the list (shared visibility)', async () => {
    const res = await request(app).get('/api/records?q=Cliente').set('Authorization', `Bearer ${tokenB}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it('owner A sees their own manifest in the list', async () => {
    const res = await request(app).get('/api/records?q=Cliente').set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it('autoridad sees A\'s manifest in the list', async () => {
    const res = await request(app).get('/api/records?q=Cliente').set('Authorization', `Bearer ${tokenAut}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  // PRD RF-22: capturistas share visibility — B can access A's record detail
  it('capturista B gets 200 on A\'s record :id (shared visibility)', async () => {
    const res = await request(app).get(`/api/records/${manifestId}`).set('Authorization', `Bearer ${tokenB}`);
    expect(res.status).toBe(200);
  });

  it('owner A gets 200 on their record :id', async () => {
    const res = await request(app).get(`/api/records/${manifestId}`).set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
  });

  it('autoridad gets 200 on A\'s record :id', async () => {
    const res = await request(app).get(`/api/records/${manifestId}`).set('Authorization', `Bearer ${tokenAut}`);
    expect(res.status).toBe(200);
  });

  // PRD RF-22: capturistas share visibility — B can export A's records
  it('capturista B gets 200 on A\'s export (shared visibility)', async () => {
    const res = await request(app).get(`/api/records/${manifestId}/risk.xlsx`).set('Authorization', `Bearer ${tokenB}`);
    expect(res.status).toBe(200);
  });

  it('autoridad is not forbidden from A\'s export', async () => {
    const res = await request(app).get(`/api/records/${manifestId}/risk.xlsx`).set('Authorization', `Bearer ${tokenAut}`);
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(200);
  });
});
