import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { generateSync } from 'otplib';
import { createApp } from '../../src/app';
import { hashPassword } from '../../src/auth/password';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

const app = createApp();

async function seedUser(username: string, password: string) {
  const hash = await hashPassword(password);
  const { rows } = await query(
    `INSERT INTO users (username, password_hash, role) VALUES ($1,$2,'capturista') RETURNING id`,
    [username, hash],
  );
  return rows[0].id as string;
}

async function loginToken(username: string, password: string, code?: string) {
  const body: Record<string, string> = { username, password };
  if (code) body.code = code;
  return request(app).post('/api/auth/login').send(body);
}

describe('MFA routes', () => {
  beforeEach(async () => { await truncateAll(); });

  describe('enrollment', () => {
    it('POST /api/auth/mfa/setup returns secret and otpauthUrl', async () => {
      await seedUser('alice', 'alicepass');
      const login = await loginToken('alice', 'alicepass');
      expect(login.status).toBe(200);
      const token = login.body.token as string;

      const res = await request(app)
        .post('/api/auth/mfa/setup')
        .set('Authorization', `Bearer ${token}`)
        .send();
      expect(res.status).toBe(200);
      expect(typeof res.body.secret).toBe('string');
      expect(res.body.secret.length).toBeGreaterThan(0);
      expect(typeof res.body.otpauthUrl).toBe('string');
      expect(res.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    });

    it('POST /api/auth/mfa/enable with valid code enables MFA', async () => {
      await seedUser('alice', 'alicepass');
      const login = await loginToken('alice', 'alicepass');
      const token = login.body.token as string;

      const setup = await request(app)
        .post('/api/auth/mfa/setup')
        .set('Authorization', `Bearer ${token}`)
        .send();
      const secret = setup.body.secret as string;

      const code = generateSync({ secret });
      const enable = await request(app)
        .post('/api/auth/mfa/enable')
        .set('Authorization', `Bearer ${token}`)
        .send({ code });
      expect(enable.status).toBe(200);
      expect(enable.body.enabled).toBe(true);
    });

    it('POST /api/auth/mfa/enable with wrong code returns 400', async () => {
      await seedUser('alice', 'alicepass');
      const login = await loginToken('alice', 'alicepass');
      const token = login.body.token as string;

      await request(app)
        .post('/api/auth/mfa/setup')
        .set('Authorization', `Bearer ${token}`)
        .send();

      const enable = await request(app)
        .post('/api/auth/mfa/enable')
        .set('Authorization', `Bearer ${token}`)
        .send({ code: '000000' });
      expect(enable.status).toBe(400);
    });

    it('POST /api/auth/mfa/setup requires auth', async () => {
      const res = await request(app).post('/api/auth/mfa/setup').send();
      expect(res.status).toBe(401);
    });
  });

  describe('login with MFA enabled', () => {
    async function setupMfa(username: string, password: string): Promise<string> {
      const login = await loginToken(username, password);
      const token = login.body.token as string;
      const setup = await request(app)
        .post('/api/auth/mfa/setup')
        .set('Authorization', `Bearer ${token}`)
        .send();
      const secret = setup.body.secret as string;
      const code = generateSync({ secret });
      await request(app)
        .post('/api/auth/mfa/enable')
        .set('Authorization', `Bearer ${token}`)
        .send({ code });
      return secret;
    }

    it('login without code when MFA enabled returns 401 with mfa_required', async () => {
      await seedUser('bob', 'bobpass');
      await setupMfa('bob', 'bobpass');

      const res = await loginToken('bob', 'bobpass');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('mfa_required');
    });

    it('login with valid TOTP code returns 200 + token', async () => {
      await seedUser('bob', 'bobpass');
      const secret = await setupMfa('bob', 'bobpass');

      const code = generateSync({ secret });
      const res = await loginToken('bob', 'bobpass', code);
      expect(res.status).toBe(200);
      expect(typeof res.body.token).toBe('string');
    });

    it('login with wrong TOTP code returns 401', async () => {
      await seedUser('bob', 'bobpass');
      await setupMfa('bob', 'bobpass');

      const res = await loginToken('bob', 'bobpass', '000000');
      expect(res.status).toBe(401);
    });

    it('user without MFA enabled logs in with just username/password (no regression)', async () => {
      await seedUser('carol', 'carolpass');
      const res = await loginToken('carol', 'carolpass');
      expect(res.status).toBe(200);
      expect(typeof res.body.token).toBe('string');
    });
  });
});
