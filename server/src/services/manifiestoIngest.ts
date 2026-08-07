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
      /** House guías materialized into `operacion_guias` — the unit PA-07 and planning work on. */
      guias: number;
      totales: ManifiestoTotales;
    };

const MAX_ROWS = 20_000;

/** Per-house-guía rollup of the manifest lines, the shape `operacion_guias` stores. */
export interface GuiaAgregada {
  guiaNorm: string;
  /** What the manifest actually wrote — the string a human reconciles against paper. */
  guiaRaw: string;
  /** Null, not 0, when no line declared one: an undeclared count must not read as a declared zero. */
  piezas: number | null;
  cartones: number | null;
  pesoKg: number | null;
}

/**
 * One pass over the GOLD layer (`shipments`) producing both the manifest totals and the per-guía
 * rollup. Read from `shipments` rather than from the parse so the figures describe what the system
 * actually holds, and so they are still right when a manifest was ATTACHED rather than freshly
 * ingested. Single scan because both consumers run on every prealerta and a manifest can carry 20 000
 * lines.
 */
async function scanManifestShipments(
  manifestId: string,
): Promise<{ totales: ManifiestoTotales; porGuia: GuiaAgregada[] }> {
  const { rows } = await query<{ data: Shipment }>(
    'SELECT data FROM shipments WHERE manifest_id = $1',
    [manifestId],
  );
  let piezas = 0;
  let pesoKg = 0;
  const guias = new Set<string>();
  const bultos = new Set<string>();
  // Accumulators kept per normalized guía. `piezas`/`pesoKg` stay null until a line actually declares
  // a finite value, so "not declared" and "declared as zero" stay distinguishable.
  const porGuia = new Map<
    string,
    { guiaRaw: string; piezas: number | null; pesoKg: number | null; bultos: Set<string> }
  >();

  for (const r of rows) {
    const s = r.data ?? ({} as Shipment);
    const qty = typeof s.quantity === 'number' && Number.isFinite(s.quantity) ? s.quantity : null;
    const wt = typeof s.weightKg === 'number' && Number.isFinite(s.weightKg) ? s.weightKg : null;
    if (qty !== null) piezas += qty;
    if (wt !== null) pesoKg += wt;

    // `bulto` identifies the carton a line sits in. Only when the manifest populates it can a carton
    // count be derived at all.
    const bulto =
      s.bulto !== undefined && s.bulto !== null && String(s.bulto).trim() !== ''
        ? String(s.bulto).trim()
        : null;
    if (bulto) bultos.add(bulto);

    const raw = s.guideId ? String(s.guideId) : '';
    const norm = normGuia(raw);
    if (!norm) continue;
    guias.add(norm);
    let acc = porGuia.get(norm);
    if (!acc) {
      acc = { guiaRaw: raw, piezas: null, pesoKg: null, bultos: new Set<string>() };
      porGuia.set(norm, acc);
    }
    if (qty !== null) acc.piezas = (acc.piezas ?? 0) + qty;
    if (wt !== null) acc.pesoKg = (acc.pesoKg ?? 0) + wt;
    if (bulto) acc.bultos.add(bulto);
  }

  return {
    totales: {
      piezas,
      pesoKg: Number(pesoKg.toFixed(3)),
      cartones: bultos.size > 0 ? bultos.size : null,
      guias: [...guias],
      lineas: rows.length,
    },
    porGuia: [...porGuia.entries()].map(([guiaNorm, a]) => ({
      guiaNorm,
      guiaRaw: a.guiaRaw,
      piezas: a.piezas,
      cartones: a.bultos.size > 0 ? a.bultos.size : null,
      pesoKg: a.pesoKg === null ? null : Number(a.pesoKg.toFixed(3)),
    })),
  };
}

/** Totals only — kept for callers that do not care about the per-guía breakdown. */
export async function manifestTotales(manifestId: string): Promise<ManifiestoTotales> {
  return (await scanManifestShipments(manifestId)).totales;
}

/**
 * Materialize the house guías of an operación (PRD-02 §8.5).
 *
 * The guía casa is the unit of planning, of partial retención and of pedimento coverage, so it needs a
 * row of its own rather than being re-derived from manifest lines on demand — and PA-07 ("this guía is
 * already on another open operación") is only answerable at all once the guías are queryable across
 * operaciones.
 *
 * Idempotent by `(operacion_id, guia_norm)`: a prealerta resend with a corrected manifiesto refreshes
 * the aggregates in place. `estado` is deliberately NOT part of the update — a guía already marked
 * `retenida` or `no_transmitida` must never be walked back to `declarada` by a re-ingest — and neither
 * is an already-attributed `client_id`, for the same reason. The client is seeded from the operación
 * because nothing in today's manifiesto distinguishes per-guía ownership; when a guía máster carries
 * cargo for several clients (R29) that attribution is a later, human or pedimento-driven, refinement.
 */
export async function syncOperacionGuias(input: {
  operacionId: string;
  clientId: string | null;
  guias: GuiaAgregada[];
}): Promise<number> {
  const { operacionId, clientId, guias } = input;
  if (!guias.length) return 0;

  const res = await query(
    `INSERT INTO operacion_guias
       (operacion_id, guia_norm, guia_raw, client_id, piezas, cartones, peso_kg)
     SELECT $1, g.guia_norm, g.guia_raw, $2, g.piezas, g.cartones, g.peso_kg
       FROM unnest($3::text[], $4::text[], $5::int[], $6::int[], $7::numeric[])
            AS g(guia_norm, guia_raw, piezas, cartones, peso_kg)
     ON CONFLICT (operacion_id, guia_norm) DO UPDATE
       SET guia_raw  = COALESCE(EXCLUDED.guia_raw, operacion_guias.guia_raw),
           client_id = COALESCE(operacion_guias.client_id, EXCLUDED.client_id),
           piezas    = EXCLUDED.piezas,
           cartones  = COALESCE(EXCLUDED.cartones, operacion_guias.cartones),
           peso_kg   = EXCLUDED.peso_kg`,
    [
      operacionId,
      clientId,
      guias.map((g) => g.guiaNorm),
      guias.map((g) => g.guiaRaw),
      guias.map((g) => g.piezas),
      guias.map((g) => g.cartones),
      guias.map((g) => g.pesoKg),
    ],
  );
  return res.rowCount ?? 0;
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

  // One scan of the gold layer feeds both the cotejo totals and the operación's house guías.
  const { totales, porGuia } = await scanManifestShipments(manifestId);
  const guias = await syncOperacionGuias({ operacionId, clientId, guias: porGuia });

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
      guias,
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
    guias,
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
