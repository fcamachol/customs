import { describe, expect, it } from 'vitest';
import { signToken, verifyToken } from '../../src/auth/token';

describe('token', () => {
  it('round-trips a payload', () => {
    const token = signToken({ userId: 'u1', role: 'admin' });
    const claims = verifyToken(token);
    expect(claims.userId).toBe('u1');
    expect(claims.role).toBe('admin');
  });
  it('throws on a tampered token', () => {
    expect(() => verifyToken('not.a.token')).toThrow();
  });
});
