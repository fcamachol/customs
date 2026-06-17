import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import { authRouter } from './routes/auth';
import { usersRouter } from './routes/users';
import { manifestsRouter } from './routes/manifests';
import { pedimentoUploadRouter } from './routes/pedimentoUpload';
import { riskRouter } from './routes/risk';
import { pedimentoRouter } from './routes/pedimento';
import { recordsRouter } from './routes/records';
import { exportsRouter } from './routes/exports';
import { dashboardRouter } from './routes/dashboard';
import { filesRouter } from './routes/files';
import { auditRouter } from './routes/audit';

export function createApp(): Express {
  const app = express();
  // Allow the browser client (different origin/port in dev) to call the API.
  // CORS_ORIGIN can be a comma-separated allowlist; defaults to permissive for dev.
  const origins = process.env.CORS_ORIGIN?.split(',').map((o) => o.trim());
  app.use(cors({ origin: origins && origins.length ? origins : true }));
  app.use(express.json({ limit: '5mb' }));
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api/auth', authRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/manifests', manifestsRouter);
  app.use('/api/manifests', pedimentoUploadRouter);
  app.use('/api/manifests', riskRouter);
  app.use('/api/manifests', pedimentoRouter);
  app.use('/api/records', recordsRouter);
  app.use('/api/records', exportsRouter);
  app.use('/api/dashboard', dashboardRouter);
  app.use('/api/files', filesRouter);
  app.use('/api/audit', auditRouter);
  // Global error handler: log server-side, never leak stack traces to clients.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal error' });
  });
  return app;
}
