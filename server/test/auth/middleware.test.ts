import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { requireAuth, requireRole } from '../../src/auth/middleware';
import { signToken } from '../../src/auth/token';

function mockRes() {
  const res = {} as Response;
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

describe('auth middleware', () => {
  it('rejects requests with no token', () => {
    const req = { headers: {} } as Request; const res = mockRes(); const next = vi.fn();
    requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
  it('attaches claims and calls next on a valid token', () => {
    const token = signToken({ userId: 'u1', role: 'admin' });
    const req = { headers: { authorization: `Bearer ${token}` } } as Request; const res = mockRes(); const next = vi.fn();
    requireAuth(req, res, next);
    expect(next).toHaveBeenCalled();
    expect((req as any).user.userId).toBe('u1');
  });
  it('blocks a role that is not allowed', () => {
    const req = { user: { userId: 'u1', role: 'capturista' } } as any; const res = mockRes(); const next = vi.fn();
    requireRole('admin')(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});
