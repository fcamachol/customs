import { withTransaction } from '../db/tx';
import { query } from '../db/pool';
import { isUniqueViolation } from '../db/errors';
import { recordAudit } from './audit';
import { ingestWorkbook } from './manifestIngest';
import { loadHeaderMappings } from './headerMappings';
import { encryptShipmentPii } from '../crypto/fieldCrypto';
import { normGuia } from '../../../shared/pedimento/guia';
import type { Shipment } from '../../../shared/types/shipment';

/**
 * Ingest the manifiesto that arrived attached to a prealerta (PRD-02 item 1 / R3).
 *
 * This is the join between the two systems. Until now the attachment was archived and nothing more,
 * which meant the risk engine still needed a human to upload the same file through the UI. Feeding it
 * straight into the existing pipeline is what makes risk scoring and the manifest cotejo rules fire on
 * arrival instead of on demand.
 *
 * It reuses `ingestWorkbook` → `manifests` → `manifest_staging_rows` → `shipments` exactly as the UI
 * route does, rather than writing a second parser. Two invariants of that pipeline shape the logic:
 *   - `manifests.mawb_reference` is GLOBALLY UNIQUE, so when a manifest already exists for this MAWB
 *     (a manual upload, or a prealerta resend) we ATTACH to it instead of trying to insert a second
 *     one, which would violate the constraint and fail the whole ingest.
 *   - the same file may legitimately arrive twice (resend), so the content hash is checked first.
 */

export interface ManifiestoTotales {
  piezas: number;
  pesoKg: number;
  /**
   * Null when the manifest gives no basis for a carton count. Deliberately not defaulted to a line
   * count: cartones and líneas are different things, and a wrong number here would produce a false
   * PA-01 red flag — worse than admitting the comparison cannot be made.
   */
  cartones: number | null;
  guias: string[];
  lineas: number;
}

export type ManifiestoIngestResult =
  | { status: 'rechazado'; motivo: string; detalle?: unknown }
  | { status: 'sin_filas'; manifestId: string }
  | {
      status: 'ingestado' | 'adjuntado';
      manifestId: string;
      counts: { total: number; valid: number; warning: number; error: number };
      promovidas: number;
      totales: ManifiestoTotales;
    };

const MAX_ROWS = 20_000;

/**
 * Totals from the GOLD layer (`shipments`), not from the parse, so they describe what the system
 * actually holds and will still be right when a manifest was attached rather than freshly ingested.
 */
export async function manifestTotales(manifestId: string): Promise<ManifiestoTotales> {
  const { rows } = await query<{ data: Shipment }>(
    'SELECT data FROM shipments WHERE manifest_id = $1',
    [manifestId],
  );
  let piezas = 0;
  let pesoKg = 0;
  const guias = new Set<string>();
  const bultos = new Set<string>();
  for (const r of rows) {
    const s = r.data ?? ({} as Shipment);
    if (typeof s.quantity === 'number' && Number.isFinite(s.quantity)) piezas += s.quantity;
    if (typeof s.weightKg === 'number' && Number.isFinite(s.weightKg)) pesoKg += s.weightKg;
    if (s.guideId) guias.add(normGuia(String(s.guideId)));
    // `bulto` identifies the carton a line sits in. Only when the manifest populates it can a carton
    // count be derived at all.
    if (s.bulto !== undefined && s.bulto !== null && String(s.bulto).trim() !== '') {
      bultos.add(String(s.bulto).trim());
    }
  }
  return {
    piezas,
    pesoKg: Number(pesoKg.toFixed(3)),
    cartones: bultos.size > 0 ? bultos.size : null,
    guias: [...guias],
    lineas: rows.length,
  };
}

export async function ingestManifiestoFromPrealerta(input: {
  operacionId: string;
  mawb: string;
  mawbRaw: string | null;
  clientId: string | null;
  bytes: Buffer;
  fileId: string;
  contentHash: string;
}): Promise<ManifiestoIngestResult> {
  const { operacionId, mawb, clientId, bytes, fileId, contentHash } = input;

  // Per-client header mappings let a client's own column naming ingest without a code change; with no
  // resolved client only the global mappings apply.
  const extraMappings = await loadHeaderMappings(clientId);
  const parsed = ingestWorkbook(bytes, input.mawbRaw ?? mawb, extraMappings);

  if (parsed.fileRejected) {
    return {
      status: 'rechazado',
      motivo: 'encabezados_duplicados',
      detalle: { duplicateHeaders: parsed.duplicateHeaders },
    };
  }
  if (parsed.counts.total > MAX_ROWS) {
    return { status: 'rechazado', motivo: 'excede_filas', detalle: { total: parsed.counts.total, max: MAX_ROWS } };
  }
  if (parsed.counts.total === 0) {
    return { status: 'rechazado', motivo: 'sin_filas_de_datos' };
  }

  // Attach rather than duplicate. Same file (resend) or same MAWB (manual upload) both mean the
  // manifest already exists; inserting again would hit manifests_mawb_reference_uq and abort.
  const existing = await query<{ id: string; ingestion_status: string }>(
    `SELECT id, ingestion_status FROM manifests
      WHERE file_content_hash = $1 OR mawb_reference = $2
      ORDER BY (file_content_hash = $1) DESC
      LIMIT 1`,
    [contentHash, mawb],
  );

  let manifestId: string;
  let attached = false;

  if (existing.rows.length) {
    manifestId = existing.rows[0].id;
    attached = true;
  } else {
    try {
      manifestId = await withTransaction(async (q) => {
        const m = await q(
          `INSERT INTO manifests
             (mawb_reference, client_id, created_by, ingestion_status, source_file_id,
              source_header, file_content_hash)
           VALUES ($1,$2,NULL,'staged',$3,$4,$5) RETURNING id`,
          [mawb, clientId, fileId, JSON.stringify(parsed.headerRow), contentHash],
        );
        const id = m.rows[0].id as string;
        for (const row of parsed.rows) {
          // PII is encrypted before it is written, exactly as the UI path does.
          const encrypted = encryptShipmentPii(row.shipment);
          await q(
            `INSERT INTO manifest_staging_rows
               (manifest_id, row_index, idempotency_key, data, status, errors, warnings)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [
              id,
              row.rowIndex,
              row.idempotencyKey,
              JSON.stringify(encrypted),
              row.status,
              JSON.stringify(row.errors),
              JSON.stringify(row.warnings),
            ],
          );
        }
        return id;
      });
    } catch (err) {
      // Backstop for a concurrent insert winning the race on the unique MAWB.
      if (isUniqueViolation(err)) {
        const again = await query<{ id: string }>(
          'SELECT id FROM manifests WHERE mawb_reference = $1 LIMIT 1',
          [mawb],
        );
        if (!again.rows.length) throw err;
        manifestId = again.rows[0].id;
        attached = true;
      } else {
        throw err;
      }
    }
  }

  // Promote to the gold layer. Rows with hard errors are NOT promoted — the UI route refuses the
  // whole promotion in that case, but here refusing would leave an operación with no shipments and
  // therefore no risk analysis at all, so we promote what is valid and let the row errors surface as
  // warnings on the prealerta. The distinction is recorded in the event payload.
  const promovidas = await promoteStagedRows(manifestId);

  await query('UPDATE operaciones SET manifest_id = $2 WHERE id = $1 AND manifest_id IS NULL', [
    operacionId,
    manifestId,
  ]);

  const totales = await manifestTotales(manifestId);

  await recordAudit({
    userId: null,
    action: attached ? 'MANIFIESTO_ADJUNTADO' : 'MANIFIESTO_INGESTADO',
    entity: 'manifest',
    entityId: manifestId,
    after: {
      operacionId,
      mawb,
      counts: parsed.counts,
      promovidas,
      totales,
      sheetName: parsed.sheetName,
      unmappedHeaders: parsed.unmappedHeaders,
    },
    ip: null,
  });

  return {
    status: attached ? 'adjuntado' : 'ingestado',
    manifestId,
    counts: parsed.counts,
    promovidas,
    totales,
  };
}

/**
 * Promote valid/warning staging rows into `shipments`, idempotently.
 *
 * Mirrors POST /api/manifests/:id/promote, minus its interactive gates (finalized-pedimento lock and
 * the all-or-nothing error check) which belong to a human-driven flow. Re-running is safe: the
 * ON CONFLICT clause refreshes the row and clears its stale risk scores, which is what makes a
 * prealerta resend with a corrected manifest do the right thing.
 */
async function promoteStagedRows(manifestId: string): Promise<number> {
  const staged = await query<{ idempotency_key: string; data: unknown }>(
    `SELECT idempotency_key, data FROM manifest_staging_rows
      WHERE manifest_id = $1 AND status IN ('valid','warning')`,
    [manifestId],
  );
  if (!staged.rows.length) return 0;

  await withTransaction(async (q) => {
    for (const r of staged.rows) {
      await q(
        `INSERT INTO shipments (id, manifest_id, data, idempotency_key)
         VALUES (gen_random_uuid(), $1, $2, $3)
         ON CONFLICT (manifest_id, idempotency_key)
         DO UPDATE SET data = EXCLUDED.data,
                       risk_score = NULL, risk_color = NULL, risk_incidences = NULL`,
        [manifestId, JSON.stringify(r.data), r.idempotency_key],
      );
    }
    await q(
      `UPDATE manifest_staging_rows SET promoted_at = now()
        WHERE manifest_id = $1 AND status IN ('valid','warning')`,
      [manifestId],
    );
    await q(`UPDATE manifests SET ingestion_status='promoted', risk_stale=true WHERE id=$1`, [
      manifestId,
    ]);
  });
  return staged.rows.length;
}
