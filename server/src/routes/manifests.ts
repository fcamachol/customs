import { Router } from 'express';
import multer from 'multer';
import { query } from '../db/pool';
import { requireAuth, requireRole } from '../auth/middleware';
import { recordAudit } from '../services/audit';
import { encryptConsignee } from '../crypto/fieldCrypto';
import { saveFile } from '../storage/files';
import { ingestWorkbook } from '../services/manifestIngest';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });
const MAX_ROWS = 5000; // synchronous ceiling (async deferred to Increment 2)

export const manifestsRouter = Router();

manifestsRouter.post('/', requireAuth, requireRole('admin', 'capturista'), upload.single('file'), async (req, res) => {
  const { mawbReference, clientName } = req.body ?? {};
  if (!req.file) { res.status(400).json({ error: 'file required' }); return; }
  if (!mawbReference) { res.status(400).json({ error: 'mawbReference required' }); return; }

  const result = ingestWorkbook(req.file.buffer, mawbReference);
  if (result.fileRejected) {
    res.status(422).json({ error: 'Encabezados duplicados', duplicateHeaders: result.duplicateHeaders });
    return;
  }
  if (result.counts.total > MAX_ROWS) {
    res.status(413).json({ error: `El manifiesto excede ${MAX_ROWS} filas` });
    return;
  }

  const file = await saveFile({ kind: 'manifest', originalName: req.file.originalname, bytes: req.file.buffer, uploadedBy: req.user!.userId });
  const m = await query(
    `INSERT INTO manifests (mawb_reference, client_name, created_by, ingestion_status, source_file_id, source_header, file_content_hash)
     VALUES ($1,$2,$3,'staged',$4,$5,$6) RETURNING id`,
    [mawbReference, clientName ?? null, req.user!.userId, file.id, JSON.stringify(result.rows.length ? Object.keys(result.rows[0].shipment) : []), file.contentHash],
  );
  const manifestId = m.rows[0].id;

  for (const row of result.rows) {
    const encrypted = { ...row.shipment, consignee: encryptConsignee(row.shipment.consignee) };
    await query(
      `INSERT INTO manifest_staging_rows (manifest_id, row_index, idempotency_key, data, status, errors, warnings)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [manifestId, row.rowIndex, row.idempotencyKey, JSON.stringify(encrypted), row.status, JSON.stringify(row.errors), JSON.stringify(row.warnings)],
    );
  }

  await recordAudit({ userId: req.user!.userId, action: 'INGEST_MANIFEST', entity: 'manifest', entityId: manifestId,
    after: { fileContentHash: file.contentHash, counts: result.counts }, ip: req.ip });

  res.status(201).json({
    manifestId, ingestionStatus: 'staged', counts: result.counts,
    rejected: result.rows.flatMap((r) => r.errors), warnings: result.rows.flatMap((r) => r.warnings),
    unmappedHeaders: result.unmappedHeaders, duplicateHeaders: result.duplicateHeaders,
  });
});

// POST /api/manifests/:id/client — associate a client to a manifest
manifestsRouter.post('/:id/client', requireAuth, requireRole('admin', 'capturista'), async (req, res) => {
  const { id } = req.params;
  const { clientId } = req.body ?? {};
  if (!clientId) { res.status(400).json({ error: 'clientId is required' }); return; }

  const existing = await query('SELECT id FROM manifests WHERE id=$1', [id]);
  if (existing.rows.length === 0) { res.status(404).json({ error: 'Manifest not found' }); return; }

  const clientCheck = await query('SELECT id FROM clients WHERE id=$1', [clientId]);
  if (clientCheck.rows.length === 0) { res.status(404).json({ error: 'Client not found' }); return; }

  // Bust the cached Reporte General: the client overlay (Remitente/Plataforma) feeds the report.
  await query('UPDATE manifests SET client_id=$1, report_file_id=NULL WHERE id=$2', [clientId, id]);
  await recordAudit({
    userId: req.user!.userId,
    action: 'LINK_CLIENT',
    entity: 'manifest',
    entityId: id,
    after: { clientId },
    ip: req.ip,
  });
  res.json({ ok: true });
});
