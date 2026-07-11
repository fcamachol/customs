import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import path from 'node:path';
import cors from 'cors';
import { ZodError } from 'zod';
import { authRouter } from './routes/auth';
import { usersRouter } from './routes/users';
import { manifestsRouter } from './routes/manifests';
import { pedimentoUploadRouter } from './routes/pedimentoUpload';
import { riskRouter } from './routes/risk';
import { pedimentoRouter } from './routes/pedimento';
import { recordsRouter } from './routes/records';
import { exportsRouter, pedimentoExportsRouter } from './routes/exports';
import { reportsRouter, pedimentoReportsRouter } from './routes/reports';
import { dashboardRouter } from './routes/dashboard';
import { filesRouter } from './routes/files';
import { auditRouter } from './routes/audit';
import { importDataRouter } from './routes/importData';
import { pedimentoLifecycleRouter } from './routes/pedimentoLifecycle';
import { catalogsRouter } from './routes/catalogs';
import { headerMappingsRouter } from './routes/headerMappings';
import { consolidatedRouter } from './routes/consolidated';
import { adminRouter } from './routes/admin';
import { globalLimiter } from './middleware/rateLimit';
import { rejectEnrollmentScope } from './auth/middleware';
import { ValidationError } from './validation/middleware';

export function createApp(): Express {
  const app = express();
  // SECURITY NOTE: `trust proxy: true` accepts any X-Forwarded-For value.
  // For production, tighten to the known proxy hop count (e.g. 1) to prevent
  // XFF spoofing of the rate-limit key.
  app.set('trust proxy', true);
  // Allow the browser client (different origin/port in dev) to call the API.
  // CORS_ORIGIN can be a comma-separated allowlist; defaults to permissive for dev.
  // In production with no CORS_ORIGIN set, deny cross-origin requests (closed allowlist).
  const origins = process.env.CORS_ORIGIN?.split(',').map((o) => o.trim()).filter(Boolean);
  let corsOrigin: string[] | boolean;
  if (origins && origins.length > 0) {
    corsOrigin = origins;
  } else if (process.env.NODE_ENV === 'production') {
    console.warn('[CORS] NODE_ENV=production but CORS_ORIGIN is not set — cross-origin requests will be denied.');
    corsOrigin = false;
  } else {
    corsOrigin = true;
  }
  app.use(cors({ origin: corsOrigin }));
  app.use(express.json({ limit: '5mb' }));
  // Global per-IP rate limiter applied to all /api/* routes (no-op in test env).
  app.use('/api', globalLimiter);
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api/auth', authRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/manifests', manifestsRouter);
  app.use('/api/manifests', pedimentoUploadRouter);
  app.use('/api/manifests', riskRouter);
  app.use('/api/pedimentos', pedimentoRouter);
  app.use('/api/pedimentos', pedimentoReportsRouter);
  app.use('/api/pedimentos', pedimentoExportsRouter);
  app.use('/api/records', recordsRouter);
  app.use('/api/records', exportsRouter);
  app.use('/api/records', reportsRouter);
  app.use('/api/dashboard', dashboardRouter);
  app.use('/api/files', filesRouter);
  app.use('/api/audit', auditRouter);
  app.use('/api/pedimentos', importDataRouter);
  app.use('/api/pedimentos', pedimentoLifecycleRouter);
  app.use('/api/catalogs', catalogsRouter);
  app.use('/api/header-mappings', headerMappingsRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api', consolidatedRouter);
  // Serve the built frontend when running as a combined single-container deploy.
  // SERVE_STATIC_DIR points at the Vite `dist` output; static assets are served
  // directly and any non-/api path falls back to index.html for client-side routing.
  const staticDir = process.env.SERVE_STATIC_DIR;
  if (staticDir) {
    app.use(express.static(staticDir));
    app.get(/^\/(?!api\/).*/, (_req: Request, res: Response) => {
      res.sendFile(path.join(staticDir, 'index.html'));
    });
  }
  // Global error handler: log server-side, never leak stack traces to clients.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: 'Validation failed', details: err.details });
      return;
    }
    if (err instanceof ZodError) {
      res.status(400).json({ error: 'Validation failed', details: err.flatten() });
      return;
    }
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal error' });
  });
  return app;
}
