import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { z } from 'zod';
import { validate, ValidationError } from './middleware';
import { ZodError } from 'zod';

function makeApp(schema: Parameters<typeof validate>[0]) {
  const app = express();
  app.use(express.json());
  app.post('/test', validate(schema), (req, res) => {
    res.json({ body: req.body, params: req.params, query: req.query });
  });
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof ValidationError || err instanceof ZodError) {
      const details = err instanceof ValidationError ? err.details : (err as ZodError).flatten();
      res.status(400).json({ error: 'Validation failed', details });
      return;
    }
    res.status(500).json({ error: 'Internal error' });
  });
  return app;
}

describe('validate middleware', () => {
  it('passes valid body through with coercion', async () => {
    const schema = z.object({ name: z.string(), age: z.coerce.number() });
    const app = makeApp({ body: schema });
    const res = await request(app).post('/test').send({ name: 'Alice', age: '42' });
    expect(res.status).toBe(200);
    expect(res.body.body.name).toBe('Alice');
    expect(res.body.body.age).toBe(42);
  });

  it('returns 400 with details on invalid body', async () => {
    const schema = z.object({ name: z.string().min(1) });
    const app = makeApp({ body: schema });
    const res = await request(app).post('/test').send({ name: '' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
    expect(res.body.details).toBeDefined();
  });

  it('rejects invalid enum value', async () => {
    const roleEnum = z.enum(['capturista', 'admin', 'autoridad']);
    const schema = z.object({ role: roleEnum });
    const app = makeApp({ body: schema });
    const res = await request(app).post('/test').send({ role: 'super_admin' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
  });

  it('accepts valid enum value', async () => {
    const roleEnum = z.enum(['capturista', 'admin', 'autoridad']);
    const schema = z.object({ role: roleEnum });
    const app = makeApp({ body: schema });
    const res = await request(app).post('/test').send({ role: 'admin' });
    expect(res.status).toBe(200);
    expect(res.body.body.role).toBe('admin');
  });
});
