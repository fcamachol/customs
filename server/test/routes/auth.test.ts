import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { hashPassword } from '../../src/auth/password';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

const app = createApp();

async function seedAdmin() {
  const hash = await hashPassword('adminpass');
  await query(`INSERT INTO users (username, password_hash, role) VALUES ($1,$2,'admin')`, ['admin', hash]);
}

describe('auth routes', () => {
  beforeEach(async () => { await truncateAll(); await seedAdmin(); });

  it('logs in with valid credentials and returns a token', async () => {
    const res = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'adminpass' });
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
    expect(res.body.user.role).toBe('admin');
  });
  it('rejects bad credentials with 401', async () => {
    const res = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'nope' });
    expect(res.status).toBe(401);
  });
  it('writes a LOGIN audit row on success', async () => {
    await request(app).post('/api/auth/login').send({ username: 'admin', password: 'adminpass' });
    const { rows } = await query(`SELECT * FROM audit_log WHERE action='LOGIN'`);
    expect(rows).toHaveLength(1);
  });
  it('returns the current user from /me with a valid token', async () => {
    const login = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'adminpass' });
    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${login.body.token}`);
    expect(res.status).toBe(200);
    expect(res.body.username).toBe('admin');
  });
});
