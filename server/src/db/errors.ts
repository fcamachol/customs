// Postgres error-code helpers. Express 4 async route handlers do not forward rejections to the
// global error handler in app.ts, so unique-violation races are caught per-route and mapped to a
// friendly 409 instead of surfacing as a generic 500.
export function isUniqueViolation(err: unknown): err is { code: string; constraint?: string } {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}
