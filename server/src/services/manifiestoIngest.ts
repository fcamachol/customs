import { query } from '../db/pool';
import { isUniqueViolation } from '../db/errors';
import { recordAudit } from './audit';
import { ingestWorkbook } from './manifestIngest';
import { loadHeaderMappings } from './headerMappings';
import { aplicarVersion, stageVersion } from './manifiestoVersiones';
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
 *
 * DÓNDE ESTABA EL DEFECTO, porque este módulo afirmaba lo contrario. La rama de attach hacía
 * `manifestId = existing.rows[0].id; attached = true;` y NADA MÁS: `parsed.rows` sólo se usaba dentro
 * de la rama de inserción. En un reenvío con el manifiesto corregido, el sistema archivaba el
 * adjunto, volvía a promover las filas VIEJAS de staging, marcaba `risk_stale`, recorría el riesgo
 * sobre los datos viejos y devolvía `adjuntado` con los `counts` del archivo que acababa de tirar.
 * Tampoco actualizaba `file_content_hash` ni `source_file_id`, así que la cabecera seguía describiendo
 * el primer envío. El comentario de arriba decía que un resend corregido "hace lo correcto"; no lo
 * hacía, y nada lo probaba: el test que cubría este camino sembraba un manifiesto VACÍO y sólo
 * afirmaba que existía una fila, así que cero líneas ingestadas lo pasaban igual de bien.
 *
 * CÓMO MUERE. Las dos ramas ahora convergen en `services/manifiestoVersiones.ts`: se resuelve (o se
 * crea) la fila `manifests`, y el parse nuevo entra SIEMPRE por `stageVersion` + `aplicarVersion`.
 * La corrección deja de depender de que alguien recuerde escribirla en dos sitios — que es la única
 * forma en que un defecto así no vuelve.
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
      /**
       * La corrección llegó y NO se aplicó porque ya hay un pedimento `cargado`.
       *
       * No es un fallo de la ingesta y por eso no es un `status` propio: el correo se archivó, el
       * caso existe y el manifiesto vigente sigue siendo válido. Lo que cambió es que el documento
       * nuevo quedó registrado como versión `rechazada` —con su archivo, su hash y su motivo— y eso
       * viaja aquí para que el cotejo lo cuente y el humano lo vea. Ausente en el caso normal.
       */
      bloqueado?: { version: number; motivoRechazo: string };
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
      // Sólo la CABECERA. Las filas de bronce las escribe `stageVersion`, que es también quien las
      // escribe en una sustitución — un solo escritor, que es lo que impide que las dos ramas vuelvan
      // a divergir.
      const m = await query<{ id: string }>(
        `INSERT INTO manifests
           (mawb_reference, client_id, created_by, ingestion_status, source_file_id,
            source_header, file_content_hash)
         VALUES ($1,$2,NULL,'staged',$3,$4,$5) RETURNING id`,
        [mawb, clientId, fileId, JSON.stringify(parsed.headerRow), contentHash],
      );
      manifestId = m.rows[0].id;
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

  // ANTES de aplicar la versión, no después. `aplicarVersion` escribe el evento
  // `MANIFIESTO_VERSIONADO` en la línea de tiempo del caso, y el ledger exige un caso: si el enlace
  // se hiciera después, la PRIMERA ingesta de cada manifiesto perdería su evento en silencio.
  await query('UPDATE operaciones SET manifest_id = $2 WHERE id = $1 AND manifest_id IS NULL', [
    operacionId,
    manifestId,
  ]);

  /**
   * El parse nuevo entra SIEMPRE, venga de una primera ingesta o de un reenvío corregido.
   *
   * El motivo lo genera el sistema y dice de dónde vino. La versión de la prealerta va dentro porque
   * es lo que permite empatar esta corrección con el correo que la trajo; un motivo vacío pasaría el
   * CHECK y no le serviría a nadie.
   */
  const pre = await query<{ version: number; message_id: string | null }>(
    `SELECT version, message_id FROM prealertas
      WHERE operacion_id = $1 ORDER BY version DESC LIMIT 1`,
    [operacionId],
  );
  const staged = await stageVersion({
    manifestId,
    parsed,
    origen: 'prealerta',
    motivo: `Reenvío de prealerta v${pre.rows[0]?.version ?? 1} (${pre.rows[0]?.message_id ?? 'sin Message-ID'})`,
    sourceFileId: fileId,
    fileContentHash: contentHash,
    userId: null,
  });

  // Reentrega de webhook o reenvío byte-idéntico: la huella del conjunto de líneas coincide con la de
  // la versión vigente, así que no hay versión nueva y el oro ya dice lo correcto. Se sigue adelante
  // con los totales y las guías —el cotejo del correo puede haber cambiado aunque el manifiesto no—,
  // pero no se reescribe nada.
  let promovidas = 0;
  let bloqueado: { version: number; motivoRechazo: string } | null = null;
  if (staged.status === 'staged') {
    /**
     * Las filas con error NO se promueven, pero tampoco abortan la promoción entera. La ruta de UI sí
     * la aborta, y hace bien: ahí hay un humano que puede corregir el archivo. Aquí, negarse dejaría
     * a la operación sin ningún `shipments` y por tanto sin análisis de riesgo — peor que analizar lo
     * que sí se pudo leer. La distinción queda en los `counts` del evento y de la respuesta.
     *
     * `correrRiesgo: false` porque `prealertaIngest` corre el riesgo inmediatamente después y es la
     * dueña del evento `RIESGO_EVALUADO` y de su espejo en AGORA. Correrlo dos veces sobre un
     * manifiesto de 20 000 líneas sería pagar el doble por el mismo número.
     */
    const aplicada = await aplicarVersion({
      manifestId,
      version: staged.version,
      userId: null,
      correrRiesgo: false,
    });
    if (aplicada.status === 'aplicada') promovidas = aplicada.promovidas;
    else if (aplicada.status === 'rechazada') {
      bloqueado = { version: aplicada.version, motivoRechazo: aplicada.motivoRechazo };
    }
  } else if (staged.status === 'rechazada') {
    bloqueado = { version: staged.version, motivoRechazo: staged.motivoRechazo };
  }

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
      version: staged.version,
      versionEstado: staged.status,
      bloqueado,
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
    ...(bloqueado ? { bloqueado } : {}),
  };
}
