import { Router } from 'express';
import multer from 'multer';
import { requireAuth } from '../auth/middleware';
import { saveFile } from '../storage/files';
import { query } from '../db/pool';
import { recordAudit } from '../services/audit';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });
export const pedimentoUploadRouter = Router();

pedimentoUploadRouter.post('/:id/pedimento-pdf', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) { res.status(400).json({ error: 'file required' }); return; }
  const meta = await saveFile({ kind: 'pedimento_pdf', originalName: req.file.originalname, bytes: req.file.buffer, uploadedBy: req.user!.userId });
  await query('UPDATE manifests SET file_id=$1 WHERE id=$2', [meta.id, req.params.id]);
  await recordAudit({ userId: req.user!.userId, action: 'ATTACH_PEDIMENTO_PDF', entity: 'manifest', entityId: req.params.id, after: { fileId: meta.id }, ip: req.ip });
  res.status(201).json({ fileId: meta.id });
});
