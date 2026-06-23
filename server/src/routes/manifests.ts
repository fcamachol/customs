import { Router } from 'express';
import multer from 'multer';
import { query } from '../db/pool';
import { requireAuth, requireRole } from '../auth/middleware';
import { recordAudit } from '../services/audit';
import { encryptConsignee } from '../crypto/fieldCrypto';
import { saveFile } from '../storage/files';
import { ingestWorkbook } from '../services/manifestIngest';
import { computeLock } from '../services/manifestLock';
import { withTransaction } from '../db/tx';

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

  const manifestId = await withTransaction(async (q) => {
    const m = await q(
      `INSERT INTO manifests (mawb_reference, client_name, created_by, ingestion_status, source_file_id, source_header, file_content_hash)
       VALUES ($1,$2,$3,'staged',$4,$5,$6) RETURNING id`,
      [mawbReference, clientName ?? null, req.user!.userId, file.id, JSON.stringify(result.headerRow), file.contentHash],
    );
    const id = m.rows[0].id;
    for (const row of result.rows) {
      const encrypted = { ...row.shipment, consignee: encryptConsignee(row.shipment.consignee) };
      await q(
        `INSERT INTO manifest_staging_rows (manifest_id, row_index, idempotency_key, data, status, errors, warnings)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, row.rowIndex, row.idempotencyKey, JSON.stringify(encrypted), row.status, JSON.stringify(row.errors), JSON.stringify(row.warnings)],
      );
    }
    return id;
  });

  await recordAudit({ userId: req.user!.userId, action: 'INGEST_MANIFEST', entity: 'manifest', entityId: manifestId,
    after: { fileContentHash: file.contentHash, counts: result.counts }, ip: req.ip });

  res.status(201).json({
    manifestId, ingestionStatus: 'staged', counts: result.counts,
    rejected: result.rows.flatMap((r) => r.errors), warnings: result.rows.flatMap((r) => r.warnings),
    unmappedHeaders: result.unmappedHeaders, duplicateHeaders: result.duplicateHeaders,
  });
});

// GET /api/manifests/:id/staging — return staging rows + statuses (PII-redacted)
manifestsRouter.get('/:id/staging', requireAuth, requireRole('admin', 'capturista'), async (req, res) => {
  const { rows } = await query<{ row_index: number; status: string; errors: unknown; warnings: unknown }>(
    'SELECT row_index, status, errors, warnings FROM manifest_staging_rows WHERE manifest_id=$1 ORDER BY row_index', [req.params.id]);
  const counts = { total: rows.length, valid: 0, warning: 0, error: 0 };
  for (const r of rows) (counts as Record<string, number>)[r.status]++;
  res.json({
    rows: rows.map((r) => ({ rowIndex: r.row_index, status: r.status, errors: r.errors, warnings: r.warnings })),
    counts,
  });
});

// POST /api/manifests/:id/promote — gold-layer promotion gate
manifestsRouter.post('/:id/promote', requireAuth, requireRole('admin', 'capturista'), async (req, res) => {
  const id = req.params.id;
  const man = await query<{ ingestion_status: string; file_id: string | null; prevalidation: { status?: string } | null }>(
    'SELECT ingestion_status, file_id, prevalidation FROM manifests WHERE id=$1', [id]);
  if (!man.rows.length) { res.status(404).json({ error: 'Manifest not found' }); return; }
  const m = man.rows[0];
  if (!computeLock({ prevalidation: m.prevalidation, file_id: m.file_id }).editable) { res.status(409).json({ error: 'Manifiesto bloqueado' }); return; }
  if (m.ingestion_status !== 'staged') { res.status(409).json({ error: `No se puede promover desde estado '${m.ingestion_status}'` }); return; }

  const staged = await query<{ row_index: number; idempotency_key: string; data: unknown; status: string }>(
    `SELECT row_index, idempotency_key, data, status FROM manifest_staging_rows WHERE manifest_id=$1`, [id]);
  if (staged.rows.some((r) => r.status === 'error')) { res.status(422).json({ error: 'Hay filas con errores; corríjalas antes de promover' }); return; }
  const promotable = staged.rows.filter((r) => r.status === 'valid' || r.status === 'warning');
  if (!promotable.length) { res.status(422).json({ error: 'No hay filas promovibles' }); return; }

  await withTransaction(async (q) => {
    for (const r of promotable) {
      await q(
        `INSERT INTO shipments (id, manifest_id, data, idempotency_key)
         VALUES (gen_random_uuid(), $1, $2, $3)
         ON CONFLICT (manifest_id, idempotency_key)
         DO UPDATE SET data = EXCLUDED.data, risk_score = NULL, risk_color = NULL, risk_incidences = NULL`,
        [id, JSON.stringify(r.data), r.idempotency_key]);
    }
    await q(`UPDATE manifest_staging_rows SET promoted_at = now() WHERE manifest_id=$1 AND status IN ('valid','warning')`, [id]);
    await q(`UPDATE manifests SET ingestion_status='promoted', risk_stale=true WHERE id=$1`, [id]);
  });
  await recordAudit({ userId: req.user!.userId, action: 'PROMOTE_MANIFEST', entity: 'manifest', entityId: id, after: { promoted: promotable.length }, ip: req.ip });

  res.json({ promoted: promotable.length });
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
