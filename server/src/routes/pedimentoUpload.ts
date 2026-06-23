import { Router } from 'express';
import multer from 'multer';
import { requireAuth, requireRole } from '../auth/middleware';
import { saveFile } from '../storage/files';
import { query } from '../db/pool';
import { recordAudit } from '../services/audit';
import { loadScanPolicy, scanPedimentoPdf } from '../services/pdfScan';

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

  // RF-08/RF-10: scan for active content and QR trojans before persisting.
  const policy = await loadScanPolicy();
  const scan = await scanPedimentoPdf(req.file.buffer, policy);
  const scanSummary = { verdict: scan.verdict, motors: scan.motors, codes: scan.findings.map((f) => f.code) };

  if (scan.verdict === 'blocked') {
    await query(
      'INSERT INTO pedimento_scans (manifest_id, file_id, verdict, result, created_by) VALUES ($1,$2,$3,$4,$5)',
      [req.params.id, null, scan.verdict, JSON.stringify(scan), req.user!.userId],
    );
    await recordAudit({ userId: req.user!.userId, action: 'PEDIMENTO_SCAN_BLOCKED', entity: 'manifest', entityId: req.params.id, after: scanSummary, ip: req.ip });
    res.status(422).json({ error: 'El PDF contiene contenido activo no permitido', scan });
    return;
  }

  const meta = await saveFile({ kind: 'pedimento_pdf', originalName: req.file.originalname, bytes: req.file.buffer, uploadedBy: req.user!.userId });
  await query('UPDATE manifests SET file_id=$1, pedimento_scan=$2 WHERE id=$3', [meta.id, JSON.stringify(scan), req.params.id]);
  await query(
    'INSERT INTO pedimento_scans (manifest_id, file_id, verdict, result, created_by) VALUES ($1,$2,$3,$4,$5)',
    [req.params.id, meta.id, scan.verdict, JSON.stringify(scan), req.user!.userId],
  );
  await recordAudit({ userId: req.user!.userId, action: 'ATTACH_PEDIMENTO_PDF', entity: 'manifest', entityId: req.params.id, after: { fileId: meta.id }, ip: req.ip });
  const scanAction = scan.verdict === 'clean' ? 'PEDIMENTO_SCAN_CLEAN' : 'PEDIMENTO_SCAN_FLAGGED';
  await recordAudit({ userId: req.user!.userId, action: scanAction, entity: 'manifest', entityId: req.params.id, after: scanSummary, ip: req.ip });
  res.status(201).json({ fileId: meta.id, scan });
});
