import { Router } from 'express';
import { query } from '../db/pool';
import { requireAuth, requireRole } from '../auth/middleware';
import { recordAudit } from '../services/audit';

export const importDataRouter = Router();

const FIELDS = [
  'cveT1',
  'patente',
  'agenteAduanal',
  'tasaImportacion',
  'fechaEntrada',
  'claveAduanaEntrada',
  'claveAduanaDespacho',
] as const;

importDataRouter.post(
  '/:id/import-data',
  requireAuth,
  requireRole('admin', 'capturista'),
  async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const data = Object.fromEntries(FIELDS.map((f) => [f, body[f] ?? null]));
    const before = await query('SELECT import_data FROM manifests WHERE id=$1', [req.params.id]);
    if (!before.rows.length) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    await query('UPDATE manifests SET import_data=$1 WHERE id=$2', [JSON.stringify(data), req.params.id]);
    await recordAudit({
      userId: req.user!.userId,
      action: 'CAPTURE_IMPORT_DATA',
      entity: 'manifest',
      entityId: req.params.id,
      before: before.rows[0].import_data,
      after: data,
      ip: req.ip,
    });
    res.json({ ok: true, importData: data });
  },
);
