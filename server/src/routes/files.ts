import { Router } from 'express';
import { stat } from 'node:fs/promises';
import { query } from '../db/pool';
import { requireAuth } from '../auth/middleware';
import { recordAudit } from '../services/audit';

export const filesRouter = Router();

/** Machine-readable marker for "the row survived, the bytes did not" (backlog #39). */
const CODIGO_NO_DISPONIBLE = 'evidencia_no_disponible';

function esArchivoFaltante(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * Download an archived artifact.
 *
 * THREE ANSWERS, THREE DIFFERENT FACTS (backlog #39):
 *
 *   404  we never had this file — there is no row.
 *   410  the row is here, its sha256 is here, the BYTES are not. This is not a server fault to be
 *        retried: it is a permanent, honest statement that the evidence existed, that this is the
 *        hash it was archived under, and that the blob is gone. Returning the hash is the whole
 *        point — the caller can still prove what the artifact was, hand the hash to the recovery
 *        script (`npm --prefix server run recover:evidence`), or verify a copy recovered elsewhere.
 *        Until now a lost blob surfaced as a 500, which reads as "try again later" and hides a
 *        data-loss incident behind a transient-looking error.
 *   200  the bytes.
 *
 * WHY A 410 IS EVEN POSSIBLE: `FILE_STORAGE_DIR` had no persistent volume in production, so every
 * redeploy destroyed stored bytes while the `files` rows and their hashes survived (proven A/B on
 * 2026-08-07). The volume is the fix; this route is what the system says on the way there, and what
 * it will keep saying if a blob is ever lost again.
 *
 * AND THE AUDIT ROW IS WRITTEN AFTER THE FACT IT DESCRIBES. It used to be written before
 * `res.download()`, so a download that never happened was recorded as a completed one — the audit
 * chain asserting a delivery of bytes nobody received. Each request now writes EXACTLY ONE row
 * (house rule §5) naming what actually occurred: `DOWNLOAD_FILE` only once the response finished,
 * `DOWNLOAD_FILE_UNAVAILABLE` when the blob is missing, `DOWNLOAD_FILE_FAILED` when the transfer
 * broke mid-stream.
 */
filesRouter.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query<{
      storagePath: string;
      originalName: string;
      kind: string;
      contentHash: string | null;
      sizeBytes: number | null;
    }>(
      `SELECT storage_path AS "storagePath", original_name AS "originalName", kind,
              content_hash AS "contentHash", size_bytes::int AS "sizeBytes"
         FROM files WHERE id=$1`,
      [req.params.id],
    );
    if (!rows.length) { res.status(404).json({ error: 'Not found' }); return; }
    const file = rows[0];

    const responderNoDisponible = async (): Promise<void> => {
      await recordAudit({
        userId: req.user!.userId,
        action: 'DOWNLOAD_FILE_UNAVAILABLE',
        entity: 'file',
        entityId: req.params.id,
        // The storage path stays in the audit row and out of the response body: an operator needs
        // it to know which volume lost the blob, a client has no use for our filesystem layout.
        after: {
          kind: file.kind,
          originalName: file.originalName,
          contentHash: file.contentHash,
          sizeBytes: file.sizeBytes,
          storagePath: file.storagePath,
        },
        ip: req.ip,
      });
      res.status(410).json({
        error:
          'La evidencia ya no está disponible en el almacenamiento. El registro y su hash se ' +
          'conservan; los bytes deben recuperarse desde el origen y verificarse contra el hash.',
        codigo: CODIGO_NO_DISPONIBLE,
        fileId: req.params.id,
        kind: file.kind,
        originalName: file.originalName,
        contentHash: file.contentHash,
        sizeBytes: file.sizeBytes,
      });
    };

    try {
      await stat(file.storagePath);
    } catch (err) {
      if (!esArchivoFaltante(err)) throw err;
      await responderNoDisponible();
      return;
    }

    // Awaited so the audit row is written after the transfer resolves, one way or the other.
    // `res.download` is still called exactly once; its callback just settles this promise.
    const err = await new Promise<NodeJS.ErrnoException | undefined>((resolve) => {
      res.download(file.storagePath, file.originalName, (e) =>
        resolve(e as NodeJS.ErrnoException | undefined));
    });

    if (!err) {
      await recordAudit({
        userId: req.user!.userId, action: 'DOWNLOAD_FILE', entity: 'file', entityId: req.params.id, ip: req.ip,
      });
      return;
    }

    // The blob vanished between the stat and the read. Same fact as above, and still answerable as
    // long as nothing has been written to the socket yet.
    if (esArchivoFaltante(err) && !res.headersSent) { await responderNoDisponible(); return; }

    // A client that hung up, or an I/O error mid-stream: the download did NOT complete, so it is
    // not recorded as one. Once headers are out there is no response left to send — the fact lives
    // in the audit chain instead.
    await recordAudit({
      userId: req.user!.userId,
      action: 'DOWNLOAD_FILE_FAILED',
      entity: 'file',
      entityId: req.params.id,
      after: { contentHash: file.contentHash, error: err.message, headersSent: res.headersSent },
      ip: req.ip,
    });
    if (!res.headersSent) next(err);
  } catch (err) {
    // Once the response is on the wire the error handler has nothing left to write to; logging is
    // all that remains, and it beats an unhandled rejection taking the process with it.
    if (res.headersSent) { console.error(`[files] fallo posterior al envío de ${req.params.id}:`, err); return; }
    next(err);
  }
});
