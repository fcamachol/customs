import jwt from 'jsonwebtoken';
export type Role = 'capturista' | 'admin' | 'autoridad' | 'super_admin';
export interface Claims { userId: string; role: Role; }

// Default JWT secret to use ONLY in test/development environments (fail-closed pattern).
const DEV_JWT_SECRET = 'change-me-in-production';

// Lazy, memoized resolver: computed on first access to ensure tests can set NODE_ENV
// before importing this module.
let resolvedSecret: string | null = null;

export function getJWTSecret(): string {
  if (resolvedSecret !== null) return resolvedSecret;

  const envSecret = process.env.JWT_SECRET;
  const nodeEnv = process.env.NODE_ENV;

  // If JWT_SECRET is set and is NOT the insecure default, use it.
  if (envSecret && envSecret !== DEV_JWT_SECRET) {
    resolvedSecret = envSecret;
    return resolvedSecret;
  }

  // In test or development, allow the default secret.
  if (nodeEnv === 'test' || nodeEnv === 'development') {
    resolvedSecret = DEV_JWT_SECRET;
    return resolvedSecret;
  }

  // In production (or any other NODE_ENV), fail closed: do not allow the default.
  throw new Error('JWT_SECRET must be set to a non-default value');
}

export function signToken(claims: Claims): string {
  const SECRET = getJWTSecret();
  return jwt.sign(claims, SECRET, { expiresIn: '8h' });
}

export function verifyToken(token: string): Claims {
  const SECRET = getJWTSecret();
  return jwt.verify(token, SECRET) as Claims;
}
