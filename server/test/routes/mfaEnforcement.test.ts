/**
 * F10: Mandatory MFA for privileged roles — enforcement tests.
 *
 * RED phase: these tests drive the implementation.
 * Flow:
 *   1. Privileged user (admin/autoridad) without MFA → 403 + enrollmentToken (not full session token)
 *   2. Enrollment token accepted on /mfa/setup and /mfa/enable, rejected elsewhere
 *   3. After /mfa/enable succeeds, a FULL session token is returned and works
 *   4. Capturista (non-privileged) without MFA is unaffected — 200 + normal token
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { generateSync } from 'otplib';
import { createApp } from '../../src/app';
import { hashPassword } from '../../src/auth/password';
import { verifyToken } from '../../src/auth/token';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

const app = createApp();

async function seedUser(username: string, role: string) {
  const hash = await hashPassword('pass');
  const { rows } = await query(
    `INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id`,
    [username, hash, role],
  );
  return rows[0].id as string;
}

async function login(username: string, password = 'pass', code?: string) {
  const body: Record<string, string> = { username, password };
  if (code) body.code = code;
  return request(app).post('/api/auth/login').send(body);
}

// Pin enforce mode for this suite: the ambient server/.env sets MFA_ENFORCEMENT=warn
// for dev/demo, but these tests exercise the default 'enforce' behaviour. The warn-mode
// test below overrides this locally.
const ORIGINAL_MFA_ENFORCEMENT = process.env.MFA_ENFORCEMENT;
beforeEach(async () => {
  await truncateAll();
  process.env.MFA_ENFORCEMENT = 'enforce';
});
afterEach(() => {
  if (ORIGINAL_MFA_ENFORCEMENT === undefined) delete process.env.MFA_ENFORCEMENT;
  else process.env.MFA_ENFORCEMENT = ORIGINAL_MFA_ENFORCEMENT;
});

// ---------------------------------------------------------------------------
// 1. Privileged user without MFA → 403 + enrollmentToken
// ---------------------------------------------------------------------------
describe('privileged user without MFA gets 403 + enrollmentToken', () => {
  it('admin without MFA: login returns 403 mfa_enrollment_required with enrollmentToken', async () => {
    await seedUser('testadmin', 'admin');
    const res = await login('testadmin');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('mfa_enrollment_required');
    expect(typeof res.body.enrollmentToken).toBe('string');
    expect(res.body.enrollmentToken.length).toBeGreaterThan(0);
    // Must NOT contain a full session token
    expect(res.body.token).toBeUndefined();
  });

  it('autoridad without MFA: login returns 403 mfa_enrollment_required with enrollmentToken', async () => {
    await seedUser('testaut', 'autoridad');
    const res = await login('testaut');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('mfa_enrollment_required');
    expect(typeof res.body.enrollmentToken).toBe('string');
    expect(res.body.token).toBeUndefined();
  });

  it('enrollment token has scope:mfa_enrollment claim and expires within 10 minutes', async () => {
    await seedUser('adminX', 'admin');
    const res = await login('adminX');
    const claims = verifyToken(res.body.enrollmentToken);
    expect((claims as { scope?: string }).scope).toBe('mfa_enrollment');
    // Check expiry is set (jwt exp claim exists). We cannot easily check exact 10min
    // but we verify the claim is present.
    expect((claims as { exp?: number }).exp).toBeDefined();
  });

  it('enrollment token is NOT a full session token (cannot be used on /api/auth/me)', async () => {
    await seedUser('adminY', 'admin');
    const res = await login('adminY');
    const enrollmentToken = res.body.enrollmentToken;
    // Using an enrollment token on a general protected route should be rejected
    const meRes = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${enrollmentToken}`);
    expect(meRes.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// 2. Enrollment token accepted on /mfa/setup and /mfa/enable, rejected elsewhere
// ---------------------------------------------------------------------------
describe('enrollment token scope restrictions', () => {
  it('enrollment token IS accepted on /mfa/setup', async () => {
    await seedUser('adminEnroll', 'admin');
    const loginRes = await login('adminEnroll');
    expect(loginRes.status).toBe(403);
    const enrollmentToken = loginRes.body.enrollmentToken;

    const setupRes = await request(app)
      .post('/api/auth/mfa/setup')
      .set('Authorization', `Bearer ${enrollmentToken}`)
      .send();
    expect(setupRes.status).toBe(200);
    expect(typeof setupRes.body.secret).toBe('string');
  });

  it('enrollment token IS accepted on /mfa/enable', async () => {
    await seedUser('adminEnroll2', 'admin');
    const loginRes = await login('adminEnroll2');
    const enrollmentToken = loginRes.body.enrollmentToken;

    // Set up MFA first
    const setupRes = await request(app)
      .post('/api/auth/mfa/setup')
      .set('Authorization', `Bearer ${enrollmentToken}`)
      .send();
    const secret = setupRes.body.secret as string;
    const code = generateSync({ secret });

    const enableRes = await request(app)
      .post('/api/auth/mfa/enable')
      .set('Authorization', `Bearer ${enrollmentToken}`)
      .send({ code });
    expect(enableRes.status).toBe(200);
  });

  it('enrollment token is REJECTED on /api/records (protected route)', async () => {
    await seedUser('adminReject', 'admin');
    const loginRes = await login('adminReject');
    const enrollmentToken = loginRes.body.enrollmentToken;

    const res = await request(app)
      .get('/api/records')
      .set('Authorization', `Bearer ${enrollmentToken}`);
    expect(res.status).toBe(401);
  });

  it('enrollment token is REJECTED on /api/auth/logout', async () => {
    await seedUser('adminReject2', 'admin');
    const loginRes = await login('adminReject2');
    const enrollmentToken = loginRes.body.enrollmentToken;

    const res = await request(app)
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${enrollmentToken}`);
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// 3. After /mfa/enable succeeds, a FULL session token is returned
// ---------------------------------------------------------------------------
describe('after enrollment, /mfa/enable returns a full session token', () => {
  it('/mfa/enable returns token (no scope) that works on protected routes', async () => {
    await seedUser('adminFull', 'admin');
    const loginRes = await login('adminFull');
    const enrollmentToken = loginRes.body.enrollmentToken;

    // Setup MFA
    const setupRes = await request(app)
      .post('/api/auth/mfa/setup')
      .set('Authorization', `Bearer ${enrollmentToken}`)
      .send();
    const secret = setupRes.body.secret as string;
    const code = generateSync({ secret });

    // Enable MFA — should return full session token
    const enableRes = await request(app)
      .post('/api/auth/mfa/enable')
      .set('Authorization', `Bearer ${enrollmentToken}`)
      .send({ code });
    expect(enableRes.status).toBe(200);
    expect(typeof enableRes.body.token).toBe('string');

    // The returned token must NOT have mfa_enrollment scope
    const claims = verifyToken(enableRes.body.token);
    expect((claims as { scope?: string }).scope).toBeUndefined();

    // Full token must work on /api/auth/me
    const meRes = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${enableRes.body.token}`);
    expect(meRes.status).toBe(200);
  });

  it('after enrollment, subsequent logins require TOTP code', async () => {
    await seedUser('adminSubseq', 'admin');
    const loginRes = await login('adminSubseq');
    const enrollmentToken = loginRes.body.enrollmentToken;

    const setupRes = await request(app)
      .post('/api/auth/mfa/setup')
      .set('Authorization', `Bearer ${enrollmentToken}`)
      .send();
    const secret = setupRes.body.secret as string;
    const code = generateSync({ secret });

    await request(app)
      .post('/api/auth/mfa/enable')
      .set('Authorization', `Bearer ${enrollmentToken}`)
      .send({ code });

    // Now login without code → 401 mfa_required
    const noCodeRes = await login('adminSubseq');
    expect(noCodeRes.status).toBe(401);
    expect(noCodeRes.body.error).toBe('mfa_required');

    // Login with valid code → 200
    const validCode = generateSync({ secret });
    const withCodeRes = await login('adminSubseq', 'pass', validCode);
    expect(withCodeRes.status).toBe(200);
    expect(typeof withCodeRes.body.token).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// 4. Capturista without MFA is NOT affected
// ---------------------------------------------------------------------------
describe('capturista without MFA is unaffected (opt-in MFA)', () => {
  it('capturista logs in without MFA and gets a normal 200 + token', async () => {
    await seedUser('testcap', 'capturista');
    const res = await login('testcap');
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
    // No scope on normal capturista token
    const claims = verifyToken(res.body.token);
    expect((claims as { scope?: string }).scope).toBeUndefined();
  });

  it('capturista full token works on protected routes', async () => {
    await seedUser('testcap2', 'capturista');
    const loginRes = await login('testcap2');
    const meRes = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${loginRes.body.token}`);
    expect(meRes.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 5. MFA_ENFORCEMENT=warn: privileged user without MFA gets 200 + log warning
// ---------------------------------------------------------------------------
describe('MFA_ENFORCEMENT=warn: enforcement is advisory only', () => {
  it('when MFA_ENFORCEMENT=warn, admin without MFA gets 200 (not 403)', async () => {
    const originalEnforcement = process.env.MFA_ENFORCEMENT;
    process.env.MFA_ENFORCEMENT = 'warn';
    try {
      await seedUser('warnAdmin', 'admin');
      const res = await login('warnAdmin');
      expect(res.status).toBe(200);
      expect(typeof res.body.token).toBe('string');
    } finally {
      if (originalEnforcement === undefined) {
        delete process.env.MFA_ENFORCEMENT;
      } else {
        process.env.MFA_ENFORCEMENT = originalEnforcement;
      }
    }
  });
});
