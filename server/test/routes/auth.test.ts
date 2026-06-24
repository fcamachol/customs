import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { hashPassword } from '../../src/auth/password';
import { signToken } from '../../src/auth/token';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

const app = createApp();

async function seedAdmin() {
  const hash = await hashPassword('adminpass');
  const { rows } = await query(
    `INSERT INTO users (username, password_hash, role) VALUES ($1,$2,'admin') RETURNING id, token_version`,
    ['admin', hash],
  );
  return rows[0] as { id: string; token_version: number };
}

describe('auth routes', () => {
  // F10: Use MFA_ENFORCEMENT=warn so existing admin login tests are unaffected.
  // These tests cover login mechanics (token format, tv claim, logout, audit) — not MFA
  // enforcement. MFA enforcement is covered separately in mfaEnforcement.test.ts.
  beforeEach(async () => {
    process.env.MFA_ENFORCEMENT = 'warn';
    await truncateAll();
    await seedAdmin();
  });
  afterEach(() => {
    delete process.env.MFA_ENFORCEMENT;
  });

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

  it('login token carries tv claim matching DB token_version', async () => {
    const login = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'adminpass' });
    const { verifyToken } = await import('../../src/auth/token');
    const claims = verifyToken(login.body.token);
    expect(claims.tv).toBe(0); // freshly seeded user starts at 0
  });

  describe('POST /api/auth/logout', () => {
    it('returns 401 with no token', async () => {
      const res = await request(app).post('/api/auth/logout');
      expect(res.status).toBe(401);
    });

    it('succeeds with a valid token and bumps token_version', async () => {
      const login = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'adminpass' });
      const token = login.body.token;
      const res = await request(app).post('/api/auth/logout').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      // DB version should now be 1.
      const { rows } = await query(`SELECT token_version FROM users WHERE username='admin'`);
      expect(rows[0].token_version).toBe(1);
    });

    it('invalidates prior tokens after logout (old token rejected on /me)', async () => {
      const login = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'adminpass' });
      const oldToken = login.body.token;
      // Logout with the old token.
      await request(app).post('/api/auth/logout').set('Authorization', `Bearer ${oldToken}`);
      // Old token is now revoked.
      const meRes = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${oldToken}`);
      expect(meRes.status).toBe(401);
    });

    it('a re-login after logout yields a valid new token', async () => {
      const login = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'adminpass' });
      await request(app).post('/api/auth/logout').set('Authorization', `Bearer ${login.body.token}`);
      // New login should work fine.
      const login2 = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'adminpass' });
      expect(login2.status).toBe(200);
      const meRes = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${login2.body.token}`);
      expect(meRes.status).toBe(200);
    });

    it('middleware rejects a token with stale tv (simulated bump)', async () => {
      const { rows } = await query(`SELECT id, token_version FROM users WHERE username='admin'`);
      const user = rows[0];
      // Manually craft a token with tv=0, then bump DB version to 1.
      const staleToken = signToken({ userId: user.id, role: 'admin', tv: 0 });
      await query(`UPDATE users SET token_version=1 WHERE id=$1`, [user.id]);
      const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${staleToken}`);
      expect(res.status).toBe(401);
    });
  });
});
