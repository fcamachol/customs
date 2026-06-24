/**
 * Dedicated rate-limit tests.
 *
 * Because all production singleton limiters are NO-OP when NODE_ENV === 'test',
 * this file constructs low-threshold limiter instances via the factory functions
 * with the `_forceEnable: true` option.  That option bypasses the test no-op
 * and returns a real express-rate-limit instance, allowing this test to exercise
 * actual throttling behaviour without affecting the rest of the suite.
 *
 * The pre-existing auth.test.ts / reports.test.ts suites use the production app
 * (createApp) whose singletons are no-op under test, so they are never throttled.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { makeGlobalLimiter, makeLoginLimiter, makePiiReportLimiter } from '../../src/middleware/rateLimit';
import { hashPassword } from '../../src/auth/password';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

// ---------------------------------------------------------------------------
// Helpers: build isolated mini-apps with real low-threshold limiters
// ---------------------------------------------------------------------------

function buildLoginLimiterApp(maxAttempts: number, windowMs: number) {
  // _forceEnable bypasses the NODE_ENV=test no-op
  const limiter = makeLoginLimiter({ windowMs, max: maxAttempts, _forceEnable: true });

  const app = express();
  app.use(express.json());

  // Minimal login stub: returns 401 for bad-password, 200 for good
  app.post('/login', limiter, (req, res) => {
    const { username, password } = req.body ?? {};
    if (username === 'user' && password === 'correct') {
      res.status(200).json({ token: 'tok' });
    } else {
      res.status(401).json({ error: 'Invalid credentials' });
    }
  });

  return app;
}

function buildGlobalLimiterApp(maxRequests: number, windowMs: number) {
  const limiter = makeGlobalLimiter({ windowMs, max: maxRequests, _forceEnable: true });

  const app = express();
  app.use(express.json());
  app.use('/api', limiter);
  app.get('/api/data', (_req, res) => res.json({ ok: true }));

  return app;
}

function buildPiiReportLimiterApp(maxRequests: number, windowMs: number) {
  const limiter = makePiiReportLimiter({ windowMs, max: maxRequests, _forceEnable: true });

  const app = express();
  app.use(express.json());
  app.use(limiter);
  app.get('/reports', (_req, res) => res.json({ ok: true }));

  return app;
}

// ---------------------------------------------------------------------------
// Login brute-force limiter tests
// ---------------------------------------------------------------------------

describe('loginLimiter (real limiter via factory with _forceEnable)', () => {
  const MAX = 4; // deliberately low so tests are fast
  const WINDOW_MS = 5_000;

  it('allows a valid login before the threshold is reached', async () => {
    const app = buildLoginLimiterApp(MAX, WINDOW_MS);
    const res = await request(app)
      .post('/login')
      .send({ username: 'user', password: 'correct' });
    expect(res.status).toBe(200);
  });

  it('returns 429 after MAX failed login attempts', async () => {
    const app = buildLoginLimiterApp(MAX, WINDOW_MS);

    // Fire MAX bad-password attempts — each 401 counts toward the cap
    for (let i = 0; i < MAX; i++) {
      const r = await request(app).post('/login').send({ username: 'user', password: 'wrong' });
      expect(r.status).toBe(401);
    }

    // The next attempt (MAX+1) should be blocked
    const res = await request(app)
      .post('/login')
      .send({ username: 'user', password: 'wrong' });
    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/intentos fallidos/i);
  });

  it('includes a retryAfterSeconds field in the 429 body', async () => {
    const app = buildLoginLimiterApp(MAX, WINDOW_MS);

    for (let i = 0; i < MAX; i++) {
      await request(app).post('/login').send({ username: 'user', password: 'wrong' });
    }

    const res = await request(app)
      .post('/login')
      .send({ username: 'user', password: 'wrong' });
    expect(res.status).toBe(429);
    expect(typeof res.body.retryAfterSeconds).toBe('number');
  });

  it('successful logins do not accumulate toward lockout (skipSuccessfulRequests)', async () => {
    const app = buildLoginLimiterApp(MAX, WINDOW_MS);

    // Fire MAX + 1 successful logins — none should count toward the failure cap
    for (let i = 0; i <= MAX; i++) {
      const res = await request(app)
        .post('/login')
        .send({ username: 'user', password: 'correct' });
      expect(res.status).toBe(200);
    }
  });

  it('does NOT block a good-password login even after N-1 failed attempts', async () => {
    const app = buildLoginLimiterApp(MAX, WINDOW_MS);

    // Fill up N-1 bad attempts (just under the limit)
    for (let i = 0; i < MAX - 1; i++) {
      await request(app).post('/login').send({ username: 'user', password: 'wrong' });
    }

    // A correct credential should still succeed (200 skips counting)
    const res = await request(app)
      .post('/login')
      .send({ username: 'user', password: 'correct' });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Global limiter smoke test
// ---------------------------------------------------------------------------

describe('globalLimiter (real limiter via factory with _forceEnable)', () => {
  const MAX = 3;
  const WINDOW_MS = 5_000;

  it('returns 429 after MAX requests to /api/* from the same IP', async () => {
    const app = buildGlobalLimiterApp(MAX, WINDOW_MS);

    for (let i = 0; i < MAX; i++) {
      const res = await request(app).get('/api/data');
      expect(res.status).toBe(200);
    }

    const res = await request(app).get('/api/data');
    expect(res.status).toBe(429);
  });
});

// ---------------------------------------------------------------------------
// PII report limiter smoke test
// ---------------------------------------------------------------------------

describe('piiReportLimiter (real limiter via factory with _forceEnable)', () => {
  const MAX = 4;
  const WINDOW_MS = 5_000;

  it('returns 429 after MAX requests to the same endpoint', async () => {
    const app = buildPiiReportLimiterApp(MAX, WINDOW_MS);

    for (let i = 0; i < MAX; i++) {
      const res = await request(app).get('/reports');
      expect(res.status).toBe(200);
    }

    const res = await request(app).get('/reports');
    expect(res.status).toBe(429);
  });
});

// ---------------------------------------------------------------------------
// Verify production app singletons are NO-OP under NODE_ENV=test
// ---------------------------------------------------------------------------

describe('production app singletons are NO-OP under NODE_ENV=test', () => {
  beforeEach(async () => {
    await truncateAll();
    const hash = await hashPassword('pw');
    await query(`INSERT INTO users (username, password_hash, role) VALUES ($1,$2,'admin')`, ['admin', hash]);
  });

  it('does not throttle repeated bad-password attempts via the production app', async () => {
    // createApp() uses the singleton loginLimiter which is a pass-through in test
    const { createApp } = await import('../../src/app');
    const app = createApp();

    // Fire more attempts than the production threshold (10) — all should get 401, not 429
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ username: 'admin', password: 'wrong' });
      statuses.push(res.status);
    }
    expect(statuses.every((s) => s === 401)).toBe(true);
  });
});
