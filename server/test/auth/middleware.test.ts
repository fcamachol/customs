import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { requireAuth, requireRole } from '../../src/auth/middleware';
import { signToken } from '../../src/auth/token';

// Mock the DB pool so middleware tests don't need a live Postgres instance.
vi.mock('../../src/db/pool', () => ({
  query: vi.fn(),
}));

import { query } from '../../src/db/pool';
const mockQuery = query as unknown as ReturnType<typeof vi.fn>;

function mockRes() {
  const res = {} as Response;
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

describe('auth middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: user exists with matching token_version 0.
    mockQuery.mockResolvedValue({ rows: [{ token_version: 0 }] });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('rejects requests with no token', async () => {
    const req = { headers: {} } as Request;
    const res = mockRes();
    const next = vi.fn();
    await requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('attaches claims and calls next on a valid token with matching tv', async () => {
    const token = signToken({ userId: 'u1', role: 'admin', tv: 0 });
    const req = { headers: { authorization: `Bearer ${token}` } } as Request;
    const res = mockRes();
    const next = vi.fn();
    // DB returns token_version: 0 — matches tv: 0 in token.
    mockQuery.mockResolvedValue({ rows: [{ token_version: 0 }] });
    await requireAuth(req, res, next);
    expect(next).toHaveBeenCalled();
    expect((req as any).user.userId).toBe('u1');
    expect((req as any).user.tv).toBe(0);
  });

  it('rejects a token whose tv is less than the current token_version (revoked)', async () => {
    // Token was signed with tv: 0 but DB now has token_version: 1 (bumped after logout).
    const token = signToken({ userId: 'u1', role: 'admin', tv: 0 });
    const req = { headers: { authorization: `Bearer ${token}` } } as Request;
    const res = mockRes();
    const next = vi.fn();
    mockQuery.mockResolvedValue({ rows: [{ token_version: 1 }] });
    await requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Token revoked' }));
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects when user does not exist in DB', async () => {
    const token = signToken({ userId: 'u-gone', role: 'admin', tv: 0 });
    const req = { headers: { authorization: `Bearer ${token}` } } as Request;
    const res = mockRes();
    const next = vi.fn();
    mockQuery.mockResolvedValue({ rows: [] });
    await requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'User not found' }));
    expect(next).not.toHaveBeenCalled();
  });

  it('blocks a role that is not allowed', () => {
    const req = { user: { userId: 'u1', role: 'capturista', tv: 0 } } as any;
    const res = mockRes();
    const next = vi.fn();
    requireRole('admin')(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});
