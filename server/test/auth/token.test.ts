import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { signToken, verifyToken } from '../../src/auth/token';

describe('token', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalJwtSecret = process.env.JWT_SECRET;

  afterEach(() => {
    // Restore env state precisely — avoid setting "undefined" as a string.
    process.env.NODE_ENV = originalNodeEnv;
    if (originalJwtSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = originalJwtSecret;
    }
    vi.resetModules();
  });

  it('round-trips a payload in test environment', () => {
    const token = signToken({ userId: 'u1', role: 'admin' });
    const claims = verifyToken(token);
    expect(claims.userId).toBe('u1');
    expect(claims.role).toBe('admin');
  });

  it('throws on a tampered token', () => {
    expect(() => verifyToken('not.a.token')).toThrow();
  });

  it('throws when NODE_ENV is production and JWT_SECRET is unset', async () => {
    // Set env BEFORE importing so the fresh module's resolver sees the right values.
    delete process.env.JWT_SECRET;
    process.env.NODE_ENV = 'production';
    vi.resetModules();
    const { getJWTSecret } = await import('../../src/auth/token');
    expect(() => getJWTSecret()).toThrow(/JWT_SECRET must be set to a non-default value/);
  });

  it('throws when NODE_ENV is production and JWT_SECRET is the default', async () => {
    process.env.JWT_SECRET = 'change-me-in-production';
    process.env.NODE_ENV = 'production';
    vi.resetModules();
    const { getJWTSecret } = await import('../../src/auth/token');
    expect(() => getJWTSecret()).toThrow(/JWT_SECRET must be set to a non-default value/);
  });

  it('uses a real JWT_SECRET when provided in production', async () => {
    const realSecret = 'a-strong-real-secret-that-is-not-the-default';
    process.env.JWT_SECRET = realSecret;
    process.env.NODE_ENV = 'production';
    vi.resetModules();
    const { getJWTSecret, signToken: freshSign, verifyToken: freshVerify } = await import('../../src/auth/token');
    // Resolver must return the real secret without throwing.
    expect(getJWTSecret()).toBe(realSecret);
    // Sign/verify round-trip works with the real secret.
    const token = freshSign({ userId: 'u2', role: 'capturista' });
    const claims = freshVerify(token);
    expect(claims.userId).toBe('u2');
    expect(claims.role).toBe('capturista');
  });
});
