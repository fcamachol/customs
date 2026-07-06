import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { hashPassword } from '../../src/auth/password';
import { signToken } from '../../src/auth/token';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

const app = createApp();
let token: string; let userId: string;

beforeEach(async () => {
  await truncateAll();
  const hash = await hashPassword('p');
  const u = await query(`INSERT INTO users (username,password_hash,role) VALUES ('c',$1,'capturista') RETURNING id`, [hash]);
  userId = u.rows[0].id; token = signToken({ userId, role: 'capturista', tv: 0 });
  const m = await query(`INSERT INTO manifests (mawb_reference, created_by) VALUES ('369-1',$1) RETURNING id`, [userId]);
  const mid = m.rows[0].id;
  const mk = (color: string) => query('INSERT INTO shipments (id,manifest_id,data,risk_color) VALUES (gen_random_uuid(),$1,$2,$3)', [mid, '{}', color]);
  await mk('verde'); await mk('amarillo'); await mk('rojo');
  await mk('gris');
});

describe('GET /api/dashboard', () => {
  it('returns per-user counts and risk distribution', async () => {
    const res = await request(app).get('/api/dashboard').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.manifests).toBe(1);
    expect(res.body.distribution).toEqual({ verde: 1, amarillo: 1, rojo: 1, gris: 1 });
  });
});
