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
import { prealertasRouter } from './routes/prealertas';
import { operacionesRouter } from './routes/operaciones';
import { opsRouter } from './routes/ops';
import { holdsRouter } from './routes/holds';
import {
  operacionRequerimientosRouter,
  riesgoRequerimientosRouter,
} from './routes/riesgoRequerimientos';
import { replanRouter } from './routes/replan';
import { campoRouter } from './routes/campo';
import { despachosRouter } from './routes/despachos';
import { planeacionRouter } from './routes/planeacion';
import { transportistasRouter } from './routes/transportistas';
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
  // `verify` stashes the exact bytes we received. The AGORA prealerta webhook signs the raw body,
  // and re-serializing req.body would change key order/whitespace/unicode escaping, so the HMAC
  // could never match. Capturing it here (rather than mounting a separate raw parser on one path)
  // keeps a single JSON pipeline and leaves every existing route untouched.
  app.use(
    express.json({
      limit: '5mb',
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );
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
  app.use('/api/operaciones', operacionesRouter);
  // Blocking layer (PRD-02 §8.4/§8.5, CT-3…CT-6). Stacked on the SAME prefix as operacionesRouter —
  // same pattern as the three routers on /api/manifests. The global endpoints live at
  // /api/operaciones/holds/global, which cannot be shadowed by operacionesRouter's single-segment
  // `GET /:id`; holds.ts additionally registers its global routes before its parameterized ones and
  // validates every `:id` as a UUID, so the literal 'holds' can never be read as an operación id.
  app.use('/api/operaciones', holdsRouter);
  // Risk requirements with a hard deadline (PRD-02 R18/D13, CT-4). Same prefix-stacking rationale as
  // holdsRouter: its paths carry a second segment ('/:id/riesgo-requerimientos') that operacionesRouter's
  // single-segment `GET /:id` cannot shadow, and every `:id` here is validated as a UUID.
  app.use('/api/operaciones', operacionRequerimientosRouter);
  // The work queue the control tower reads: open requerimientos and the ones about to expire.
  app.use('/api/riesgo-requerimientos', riesgoRequerimientosRouter);
  // Contingency engine (PRD-02 §8.8, CT-1…CT-7). Same prefix again, same guarantee: every route it
  // owns is multi-segment (`/:id/replan…`, `/:id/guias/:guiaId/…`) with a UUID-validated `:id`, so it
  // neither shadows nor is shadowed by operacionesRouter's `GET /:id`.
  app.use('/api/operaciones', replanRouter);
  // Field capture (PRD-02 R11, R30–R35). Mounted separately from /api/operaciones so the tramitador
  // role can be granted exactly this prefix and nothing else (§13).
  app.use('/api/campo', campoRouter);
  // Despacho and transport (PRD-02 R21–R29, R36/D14). Three prefixes of their own rather than
  // sub-paths of /api/operaciones, because a despacho is NOT a property of one caso: one unit
  // carries several casos to one destination (R29), so hanging it off a single operación id would
  // make either the truck or the cargo invisible.
  app.use('/api/transportistas', transportistasRouter);
  app.use('/api/despachos', despachosRouter);
  app.use('/api/planeacion', planeacionRouter);
  // Machine-to-machine: authenticated by HMAC signature / shared secret rather than a JWT, because
  // the callers are AGORA and the scheduler, neither of which has a session.
  app.use('/api/prealertas', prealertasRouter);
  app.use('/api/ops', opsRouter);
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
