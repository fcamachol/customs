import type { Request, Response, NextFunction } from 'express';
import { ZodError, type ZodSchema } from 'zod';

export class ValidationError extends Error {
  readonly details: ReturnType<ZodError['flatten']>;
  readonly statusCode = 400;
  constructor(zodError: ZodError) {
    super('Validation failed');
    this.name = 'ValidationError';
    this.details = zodError.flatten();
  }
}

interface ValidateOptions {
  body?: ZodSchema;
  params?: ZodSchema;
  query?: ZodSchema;
}

export function validate(opts: ValidateOptions) {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (opts.body) {
        const result = opts.body.safeParse(req.body);
        if (!result.success) throw new ValidationError(result.error);
        req.body = result.data;
      }
      if (opts.params) {
        const result = opts.params.safeParse(req.params);
        if (!result.success) throw new ValidationError(result.error);
        req.params = result.data as Record<string, string>;
      }
      if (opts.query) {
        const result = opts.query.safeParse(req.query);
        if (!result.success) throw new ValidationError(result.error);
        req.query = result.data as Record<string, string>;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
