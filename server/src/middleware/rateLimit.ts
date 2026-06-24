/**
 * Shared rate-limit middleware factories.
 *
 * All production singleton limiters are a NO-OP when NODE_ENV === 'test' so
 * that the existing supertest suites remain stable. Real limiter behaviour is
 * exercised in the dedicated rateLimit.test.ts by calling the factory functions
 * with the `_forceEnable: true` option, which bypasses the test no-op and
 * returns a real express-rate-limit instance with a low threshold.
 *
 * NOTE (multi-instance): The default MemoryStore is per-process. In a
 * horizontally-scaled deployment replace it with a shared store such as
 * `rate-limit-redis` (npm i rate-limit-redis ioredis) and pass the store
 * option to each factory call.
 */

import rateLimit, { type Options, type RateLimitRequestHandler } from 'express-rate-limit';
import type { Request, Response, NextFunction } from 'express';

// Pass-through used when running under the test harness to prevent test flake.
const passThrough = (_req: Request, _res: Response, next: NextFunction): void => next();

/** Options for the global per-IP limiter. */
export interface GlobalLimiterOptions {
  windowMs?: number;
  max?: number;
  /** Set to true in test code to bypass the NODE_ENV=test no-op and get a real limiter. */
  _forceEnable?: boolean;
}

/**
 * Global per-IP limiter applied to all /api/* routes.
 * Default: 300 requests per 60-second window.
 *
 * SECURITY NOTE: `trust proxy: true` currently accepts any X-Forwarded-For value,
 * which allows IP spoofing of the rate-limit key. For production, tighten to the
 * known proxy hop count (e.g. app.set('trust proxy', 1)) to prevent clients from
 * forging IPs and bypassing this limiter.
 */
export function makeGlobalLimiter(opts: GlobalLimiterOptions = {}): RateLimitRequestHandler {
  if (process.env.NODE_ENV === 'test' && !opts._forceEnable) {
    return passThrough as RateLimitRequestHandler;
  }
  return rateLimit({
    windowMs: opts.windowMs ?? 60_000,
    max: opts.max ?? 300,
    standardHeaders: true,   // Return rate-limit info in the `RateLimit-*` headers
    legacyHeaders: false,     // Disable the `X-RateLimit-*` headers
    skip: (req) => req.path === '/health',
  } as Partial<Options> as Options);
}

/** Options for the login brute-force limiter. */
export interface LoginLimiterOptions {
  windowMs?: number;
  max?: number;
  /** Set to true in test code to bypass the NODE_ENV=test no-op and get a real limiter. */
  _forceEnable?: boolean;
}

/**
 * Tight per-(IP+username) limiter on POST /api/auth/login.
 * Default: 10 failed attempts per 15-minute window.
 * skipSuccessfulRequests:true means only 4xx/5xx responses count as failures;
 * a successful 200 does NOT decrement the counter.
 */
export function makeLoginLimiter(opts: LoginLimiterOptions = {}): RateLimitRequestHandler {
  if (process.env.NODE_ENV === 'test' && !opts._forceEnable) {
    return passThrough as RateLimitRequestHandler;
  }
  const windowMs = opts.windowMs ?? 15 * 60_000;
  return rateLimit({
    windowMs,
    max: opts.max ?? 10,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    keyGenerator: (req) => `${req.ip}:${String(req.body?.username ?? '').toLowerCase()}`,
    handler: (_req, res) => {
      // Retry-After is set by express-rate-limit as seconds in the header.
      const headerVal = (res as Response & { getHeader(h: string): string | number | string[] | undefined }).getHeader('Retry-After');
      const retryAfterSeconds = headerVal != null ? Number(headerVal) : Math.ceil(windowMs / 1000);
      res.status(429).json({
        error: 'Demasiados intentos fallidos. Por favor espere antes de intentar de nuevo.',
        retryAfterSeconds,
      });
    },
  } as Partial<Options> as Options);
}

/** Options for the PII reports limiter. */
export interface PiiReportLimiterOptions {
  windowMs?: number;
  max?: number;
  /** Set to true in test code to bypass the NODE_ENV=test no-op and get a real limiter. */
  _forceEnable?: boolean;
}

/**
 * Per-user (or per-IP when unauthenticated) limiter for PII report endpoints.
 * Default: 60 requests per 60-second window.
 */
export function makePiiReportLimiter(opts: PiiReportLimiterOptions = {}): RateLimitRequestHandler {
  if (process.env.NODE_ENV === 'test' && !opts._forceEnable) {
    return passThrough as RateLimitRequestHandler;
  }
  return rateLimit({
    windowMs: opts.windowMs ?? 60_000,
    max: opts.max ?? 60,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => (req as Request & { user?: { userId: string } }).user?.userId ?? req.ip ?? 'anon',
  } as Partial<Options> as Options);
}

// ---------------------------------------------------------------------------
// Pre-built production singletons — always no-op in test.
// ---------------------------------------------------------------------------
export const globalLimiter = makeGlobalLimiter();
export const loginLimiter = makeLoginLimiter();
export const piiReportLimiter = makePiiReportLimiter();
