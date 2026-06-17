import { Router } from 'express';
import { query } from '../db/pool';
import { requireAuth } from '../auth/middleware';
import { recordAudit } from '../services/audit';

export const filesRouter = Router();

filesRouter.get('/:id', requireAuth, async (req, res) => {
  const { rows } = await query<{ storage_path: string; original_name: string }>(
    'SELECT storage_path, original_name FROM files WHERE id=$1', [req.params.id]);
  if (!rows.length) { res.status(404).json({ error: 'Not found' }); return; }
  const file = rows[0];
  await recordAudit({ userId: req.user!.userId, action: 'DOWNLOAD_FILE', entity: 'file', entityId: req.params.id });
  res.download(file.storage_path, file.original_name);
});
