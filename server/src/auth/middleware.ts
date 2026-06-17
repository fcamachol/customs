import type { NextFunction, Request, Response } from 'express';
import { verifyToken, type Claims, type Role } from './token';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { user?: Claims; }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) { res.status(401).json({ error: 'Missing bearer token' }); return; }
  try { req.user = verifyToken(header.slice('Bearer '.length)); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user || !roles.includes(req.user.role)) { res.status(403).json({ error: 'Forbidden' }); return; }
    next();
  };
}
