import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { hashPassword } from '../../src/auth/password';
import { signToken } from '../../src/auth/token';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

const app = createApp();
let token: string;

beforeEach(async () => {
  await truncateAll();
  const hash = await hashPassword('p');
  const u = await query(`INSERT INTO users (username,password_hash,role) VALUES ('c',$1,'capturista') RETURNING id`, [hash]);
  token = signToken({ userId: u.rows[0].id, role: 'capturista' , tv: 0 });
  await query(`INSERT INTO manifests (mawb_reference, client_name, created_by) VALUES ('369-1','Cliente A',$1),('370-2','Cliente B',$1)`, [u.rows[0].id]);
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
