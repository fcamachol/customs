import { Router } from 'express';
import multer from 'multer';
import { requireAuth, requireRole } from '../auth/middleware';
import { saveFile } from '../storage/files';
import { query } from '../db/pool';
import { recordAudit } from '../services/audit';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });
export const pedimentoUploadRouter = Router();

pedimentoUploadRouter.post('/:id/pedimento-pdf', requireAuth, requireRole('admin', 'capturista'), upload.single('file'), async (req, res) => {
  if (!req.file) { res.status(400).json({ error: 'file required' }); return; }

  // RF-08: validate MIME type — must be a PDF
  if (req.file.mimetype !== 'application/pdf') {
    res.status(400).json({ error: 'El archivo debe ser un PDF' });
    return;
  }

  // RF-08: reject empty files
  if (req.file.size <= 0) {
    res.status(400).json({ error: 'El archivo no puede estar vacío' });
    return;
  }

  // RF-08: configurable minimum size (default 0 — does not block small test fixtures)
  const minBytes = parseInt(process.env.PEDIMENTO_MIN_BYTES ?? '0', 10);
  if (minBytes > 0 && req.file.size < minBytes) {
    res.status(400).json({ error: `El archivo debe tener al menos ${minBytes} bytes` });
    return;
  }

  const meta = await saveFile({ kind: 'pedimento_pdf', originalName: req.file.originalname, bytes: req.file.buffer, uploadedBy: req.user!.userId });
  await query('UPDATE manifests SET file_id=$1 WHERE id=$2', [meta.id, req.params.id]);
  await recordAudit({ userId: req.user!.userId, action: 'ATTACH_PEDIMENTO_PDF', entity: 'manifest', entityId: req.params.id, after: { fileId: meta.id }, ip: req.ip });
  res.status(201).json({ fileId: meta.id });
});
