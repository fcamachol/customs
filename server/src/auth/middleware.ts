import type { NextFunction, Request, Response } from 'express';
import { verifyToken, type Claims, type Role } from './token';
import { query } from '../db/pool';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { user?: Claims; }
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) { res.status(401).json({ error: 'Missing bearer token' }); return; }
  let claims: Claims;
  try { claims = verifyToken(header.slice('Bearer '.length)); }
  catch { res.status(401).json({ error: 'Invalid token' }); return; }

  // One indexed PK lookup to verify token_version and user existence.
  const { rows } = await query<{ token_version: number }>(
    `SELECT token_version FROM users WHERE id=$1`,
    [claims.userId],
  );
  const userRow = rows[0];
  if (!userRow) { res.status(401).json({ error: 'User not found' }); return; }
  if (claims.tv !== userRow.token_version) {
    res.status(401).json({ error: 'Token revoked' }); return;
  }

  req.user = claims;
  next();
}

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const role = req.user?.role;
    // super_admin is a superset of admin: it satisfies any admin-gated route.
    const ok = !!role && (roles.includes(role) || (role === 'super_admin' && roles.includes('admin')));
    if (!ok) { res.status(403).json({ error: 'Forbidden' }); return; }
    next();
  };
}
