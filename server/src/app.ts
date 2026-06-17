import express, { type Express } from 'express';
import { authRouter } from './routes/auth';
import { usersRouter } from './routes/users';
import { manifestsRouter } from './routes/manifests';
import { pedimentoUploadRouter } from './routes/pedimentoUpload';
import { riskRouter } from './routes/risk';

export function createApp(): Express {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api/auth', authRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/manifests', manifestsRouter);
  app.use('/api/manifests', pedimentoUploadRouter);
  app.use('/api/manifests', riskRouter);
  return app;
}
