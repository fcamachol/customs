import type { NextFunction, Request, Response } from 'express';
import { verifyToken, type Claims, type Role } from './token';
import { query } from '../db/pool';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { user?: Claims; }
  }
}

async function verifyAndAttach(
  req: Request,
  res: Response,
  next: NextFunction,
  allowEnrollmentScope: boolean,
): Promise<void> {
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

  // F10: Reject enrollment-scoped tokens on all routes except mfa/setup and mfa/enable.
  if (!allowEnrollmentScope && (claims as { scope?: string }).scope === 'mfa_enrollment') {
    res.status(401).json({ error: 'Enrollment token is only valid for MFA setup and enable routes' });
    return;
  }

  req.user = claims;
  next();
}

/**
 * Standard auth middleware — rejects enrollment-scoped tokens.
 * Use on all routes except /mfa/setup and /mfa/enable.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  return verifyAndAttach(req, res, next, false);
}

/**
 * Auth middleware that also accepts enrollment-scoped tokens.
 * Use ONLY on /mfa/setup and /mfa/enable.
 */
export async function requireAuthAllowEnrollment(req: Request, res: Response, next: NextFunction): Promise<void> {
  return verifyAndAttach(req, res, next, true);
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

/**
 * Middleware that rejects tokens with scope:'mfa_enrollment'.
 * Apply to all authenticated routes EXCEPT /mfa/setup and /mfa/enable.
 * An enrollment-scoped token is only allowed to reach those two endpoints.
 */
export function rejectEnrollmentScope(req: Request, res: Response, next: NextFunction): void {
  if ((req.user as { scope?: string } | undefined)?.scope === 'mfa_enrollment') {
    res.status(401).json({ error: 'Enrollment token is only valid for MFA setup and enable routes' });
    return;
  }
  next();
}
