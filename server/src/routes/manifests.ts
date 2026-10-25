import { Router } from 'express';
import multer from 'multer';
import { createHash } from 'node:crypto';
import { query } from '../db/pool';
import { isUniqueViolation } from '../db/errors';
import { requireAuth, requireRole } from '../auth/middleware';
import { recordAudit } from '../services/audit';
import { saveFile } from '../storage/files';
import { ingestWorkbook } from '../services/manifestIngest';
import { loadHeaderMappings } from '../services/headerMappings';
import { withTransaction } from '../db/tx';
import { validate } from '../validation/middleware';
import {
  manifestCreateBody,
  manifestClientBody,
  manifiestoStagingQuery,
  manifiestoVersionAplicarBody,
} from '../validation/schemas';
import { aplicarVersion, stageVersion, versionPendiente } from '../services/manifiestoVersiones';
import { decryptShipment } from '../crypto/fieldCrypto';
import type { Shipment } from '../../../shared/types/shipment';
import { evaluarRrna } from '../../../shared/rrna/evaluar';

/**
 * Catálogo de RRNA sustituible por configuración (`rrna_patrones`).
 *
 * Existe porque el de fábrica es por palabra clave y genera ruido conocido: `chaleco` cae en armas
 * y `flor` en agrícola. Sin esta puerta, quitar un término exigiría un despliegue. Devuelve `null`
 * —no un objeto vacío— cuando no hay override, para que el evaluador use su default en vez de
 * quedarse sin catálogo, que es la forma silenciosa de apagar la revisión entera.
 */
async function loadRrnaPatrones(): Promise<Record<string, string[]> | null> {
  const { rows } = await query<{ value: unknown }>(
    "SELECT value FROM config WHERE key='rrna_patrones'",
  );
  const v = rows[0]?.value;
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, string[]>) : null;
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });
const MAX_ROWS = 5000; // synchronous ceiling (async deferred to Increment 2)

export const manifestsRouter = Router();

manifestsRouter.post('/', requireAuth, requireRole('admin', 'capturista'), upload.single('file'), validate({ body: manifestCreateBody }), async (req, res) => {
  const { mawbReference, clientName, clientId } = req.body;
  if (!req.file) { res.status(400).json({ error: 'Falta el archivo.' }); return; }

  // Apply the client's saved header mappings (client-specific + global) so its column naming ingests
  // without a code change. With no clientId only the global mappings apply.
  const extraMappings = await loadHeaderMappings(clientId ?? null);
  const result = ingestWorkbook(req.file.buffer, mawbReference, extraMappings);
  if (result.fileRejected) {
    res.status(422).json({ error: 'Encabezados duplicados', duplicateHeaders: result.duplicateHeaders });
    return;
  }
  if (result.counts.total > MAX_ROWS) {
    res.status(413).json({ error: `El manifiesto excede ${MAX_ROWS} filas` });
    return;
  }

  // Duplicate gates (409) — reject before persisting any file/manifest so a dup never leaves orphans.
  // Tier (a): exact same file already uploaded (most specific message). Hash the buffer the same way
  // storage/files.ts does.
  const contentHash = createHash('sha256').update(req.file.buffer).digest('hex');
  const hashDup = await query<{ id: string }>(
    'SELECT id FROM manifests WHERE file_content_hash=$1 LIMIT 1', [contentHash]);
  if (hashDup.rows.length) {
    res.status(409).json({ error: 'Este archivo ya fue cargado previamente (manifiesto duplicado).', manifestId: hashDup.rows[0].id });
    return;
  }
  // Tier (b): same MAWB already exists (different file content). MAWB is globally unique.
  //
  // Sigue siendo 409 y sigue siendo definitivo: crear una SEGUNDA fila `manifests` para el mismo MAWB
  // debe seguir siendo imposible — `operaciones.mawb` también es único y todo el modelo se apoya en
  // "un MAWB = un manifiesto = un caso". Lo que cambia es que ahora hay una salida: el archivo nuevo
  // puede SUSTITUIR el contenido del manifiesto existente vía POST /:id/versiones. `puedeSustituir`
  // se lo dice a la UI para que ofrezca el camino en un clic en vez de dejar un error muerto.
  //
  // Deliberadamente NO se marca en el tier (a): el archivo idéntico ya está cargado, y "sustituir"
  // algo por sí mismo no es una acción, es una forma de no entender lo que pasó.
  const mawbDup = await query<{ id: string }>(
    'SELECT id FROM manifests WHERE mawb_reference=$1 LIMIT 1', [mawbReference]);
  if (mawbDup.rows.length) {
    res.status(409).json({
      error: 'Ya existe un manifiesto para esta guía MAWB.',
      manifestId: mawbDup.rows[0].id,
      puedeSustituir: true,
    });
    return;
  }

  let file: Awaited<ReturnType<typeof saveFile>>;
  let manifestId: string;
  try {
    file = await saveFile({ kind: 'manifest', originalName: req.file.originalname, bytes: req.file.buffer, uploadedBy: req.user!.userId });

    manifestId = await withTransaction(async (q) => {
      const m = await q(
        `INSERT INTO manifests (mawb_reference, client_name, client_id, created_by, ingestion_status, source_file_id, source_header, file_content_hash)
         VALUES ($1,$2,$3,$4,'staged',$5,$6,$7) RETURNING id`,
        [mawbReference, clientName ?? null, clientId ?? null, req.user!.userId, file.id, JSON.stringify(result.headerRow), file.contentHash],
      );
      const id = m.rows[0].id as string;
      // La v1 se escribe por el MISMO camino que una sustitución. Un solo escritor de
      // `manifest_staging_rows` es lo que impide que la carga original y la corrección terminen
      // guardando cosas distintas — que es precisamente cómo se llegó al defecto que esta fase
      // arregla. `q` es la transacción de esta ruta: la fila `manifests` todavía no existe fuera.
      await stageVersion(
        {
          manifestId: id,
          parsed: result,
          origen: 'carga_manual',
          motivo: null, // la v1 no sustituye nada; el motivo se exige desde la v2
          sourceFileId: file.id,
          fileContentHash: file.contentHash,
          userId: req.user!.userId,
          ip: req.ip,
        },
        q,
      );
      return id;
    });
  } catch (err) {
    // Backstop the app-level checks against a concurrent insert hitting manifests_mawb_reference_uq.
    if (isUniqueViolation(err)) {
      res.status(409).json({ error: 'Ya existe un manifiesto para esta guía MAWB.' });
      return;
    }
    throw err;
  }

  await recordAudit({ userId: req.user!.userId, action: 'INGEST_MANIFEST', entity: 'manifest', entityId: manifestId,
    after: { fileContentHash: file.contentHash, counts: result.counts }, ip: req.ip });

  res.status(201).json({
    manifestId, ingestionStatus: 'staged', counts: result.counts,
    rejected: result.rows.flatMap((r) => r.errors), warnings: result.rows.flatMap((r) => r.warnings),
    unmappedHeaders: result.unmappedHeaders, duplicateHeaders: result.duplicateHeaders,
    sheetName: result.sheetName, skippedSheets: result.skippedSheets,
  });
});

/**
 * GET /api/manifests/:id/staging — filas de bronce con sus estados (PII redactada).
 *
 * Ahora acepta `?version=n`. Por defecto, la VIGENTE (`manifests.version_vigente`) y no la más alta:
 * lo que la pantalla de staging describe es lo que hay en el oro. Para revisar el diff de una versión
 * recién subida y todavía sin aplicar, el número lo devuelve `POST /:id/versiones`.
 */
/**
 * GET /api/manifests/:id/rrna — regulaciones y restricciones no arancelarias de un manifiesto.
 *
 * Endpoint NUEVO y de sólo lectura, a propósito: el catálogo de RRNA existía completo en el repo
 * (`shared/rrna/catalogo.ts`, diez categorías con su autoridad y su fundamento en la RGCE 3.7.5-E)
 * y no lo miraba ni una línea de código. Esto lo pone a la vista sin tocar nada de lo que ya
 * funciona.
 *
 * NO alimenta el semáforo, y la razón está medida: sobre el manifiesto golden de 501 filas el
 * catálogo marca 26 y cerca de la mitad son falsos positivos previsibles de una lista por palabra
 * clave — "Pistola de limpieza" cae en armas, "Flor de imitación de plástico" en agrícola. Meter
 * eso al score obligaría a recalibrar las bandas y convertiría una heurística de texto en una banda
 * roja. Se reporta aparte, con el término que disparó cada coincidencia, y quien revisa decide.
 */
manifestsRouter.get(
  '/:id/rrna',
  requireAuth,
  requireRole('admin', 'capturista', 'autoridad'),
  async (req, res) => {
    const man = await query<{ id: string }>('SELECT id FROM manifests WHERE id=$1', [req.params.id]);
    if (!man.rows.length) { res.status(404).json({ error: 'Manifiesto no encontrado.' }); return; }

    const { rows } = await query<{ id: string; data: Shipment }>(
      'SELECT id, data FROM shipments WHERE manifest_id=$1', [req.params.id]);

    // El catálogo admite sustitución por configuración para que el cliente pueda quitar los
    // términos que le generan ruido (`chaleco`, `flor`) sin tocar código. Ausente = el de fábrica.
    const patrones = await loadRrnaPatrones();

    const filas = rows
      .map((r) => {
        const s = decryptShipment(r.data);
        const coincidencias = evaluarRrna(
          { descripcion: s.description, valorDeclarado: s.customsValueUsd, rrnaNote: s.rrnaNote },
          patrones ?? undefined,
        );
        return {
          shipmentId: r.id,
          guia: s.guideId ?? null,
          descripcion: s.description ?? null,
          hsCode: s.hsCode ?? null,
          valorDeclarado: Number.isFinite(s.customsValueUsd) ? s.customsValueUsd : null,
          // Lo que el remitente escribió en la columna de RRNA del manifiesto. Se venía parseando
          // y nunca se mostraba; va tal cual, sin interpretarlo.
          rrnaNoteDeclarada: s.rrnaNote ?? null,
          coincidencias,
        };
      })
      .filter((f) => f.coincidencias.length > 0 || f.rrnaNoteDeclarada);

    const porCategoria: Record<string, number> = {};
    for (const f of filas) for (const c of f.coincidencias) {
      porCategoria[c.categoria] = (porCategoria[c.categoria] ?? 0) + 1;
    }

    res.json({
      manifestId: req.params.id,
      analizadas: rows.length,
      marcadas: filas.length,
      porCategoria,
      // El aviso viaja con el dato: una pantalla que muestre esto sin decir qué es lo convierte
      // en un veredicto, que es justo lo que no es.
      aviso: 'Coincidencias por palabra clave. Son indicios para revisar, no determinaciones: '
        + 'revise el término que disparó cada una antes de actuar.',
      filas,
    });
  },
);

manifestsRouter.get(
  '/:id/staging',
  requireAuth,
  requireRole('admin', 'capturista'),
  validate({ query: manifiestoStagingQuery }),
  async (req, res) => {
    const man = await query<{ version_vigente: number }>(
      'SELECT version_vigente FROM manifests WHERE id=$1', [req.params.id]);
    if (!man.rows.length) { res.status(404).json({ error: 'Manifiesto no encontrado.' }); return; }
    const version = Number(req.query.version ?? man.rows[0].version_vigente);

    const { rows } = await query<{ row_index: number; status: string; errors: unknown; warnings: unknown }>(
      `SELECT row_index, status, errors, warnings FROM manifest_staging_rows
        WHERE manifest_id=$1 AND version=$2 ORDER BY row_index`, [req.params.id, version]);
    const counts = { total: rows.length, valid: 0, warning: 0, error: 0 };
    for (const r of rows) (counts as Record<string, number>)[r.status]++;
    res.json({
      version,
      rows: rows.map((r) => ({ rowIndex: r.row_index, status: r.status, errors: r.errors, warnings: r.warnings })),
      counts,
    });
  },
);

/**
 * POST /api/manifests/:id/versiones — subir un manifiesto SUSTITUTIVO (multipart `file`).
 *
 * Paso 1 de dos: parsea, escribe bronce v(n) y calcula el diff. NO aplica. Existe separado del
 * `promote` porque un humano quiere ver qué cambia antes de reemplazar datos con los que ya se
 * calificó riesgo. La vía prealerta atraviesa los dos pasos en una sola llamada, desatendida.
 *
 * `capturista` entra igual que `admin`: es el rol que recibe los manifiestos corregidos de los
 * clientes, y un flujo de corrección que exige un admin es un flujo que no se usa a las 3 a.m.
 */
manifestsRouter.post(
  '/:id/versiones',
  requireAuth,
  requireRole('admin', 'capturista'),
  upload.single('file'),
  validate({ body: manifiestoVersionAplicarBody }),
  async (req, res) => {
    const id = req.params.id;
    if (!req.file) { res.status(400).json({ error: 'Falta el archivo.' }); return; }

    const man = await query<{ id: string; mawb_reference: string; client_id: string | null }>(
      'SELECT id, mawb_reference, client_id FROM manifests WHERE id=$1', [id]);
    if (!man.rows.length) { res.status(404).json({ error: 'Manifiesto no encontrado.' }); return; }

    // Toda versión subida por aquí sustituye algo, así que el motivo es obligatorio. Se comprueba
    // contra el número de versión y no "siempre", para que la regla sea la misma que la del CHECK.
    const previas = await query<{ n: number }>(
      'SELECT COALESCE(MAX(version),0)::int AS n FROM manifiesto_versiones WHERE manifest_id=$1', [id]);
    const motivo = (req.body.motivo as string | undefined) ?? null;
    if (previas.rows[0].n >= 1 && !motivo) {
      res.status(400).json({ error: 'El `motivo` es obligatorio al sustituir un manifiesto.' });
      return;
    }

    const extraMappings = await loadHeaderMappings(man.rows[0].client_id);
    const parsed = ingestWorkbook(req.file.buffer, man.rows[0].mawb_reference, extraMappings);
    if (parsed.fileRejected) {
      res.status(422).json({ error: 'Encabezados duplicados', duplicateHeaders: parsed.duplicateHeaders });
      return;
    }
    if (parsed.counts.total > MAX_ROWS) {
      res.status(413).json({ error: `El manifiesto excede ${MAX_ROWS} filas` });
      return;
    }
    if (parsed.counts.total === 0) {
      res.status(422).json({ error: 'El archivo no contiene filas de datos' });
      return;
    }

    // El archivo se guarda ANTES de decidir: incluso una versión rechazada queda archivada, con su
    // hash, apuntada desde la fila `rechazada`. Es la misma regla R-A de la prealerta — se conserva
    // lo que llegó, y sólo después se decide qué hacer con ello.
    const file = await saveFile({
      kind: 'manifest',
      originalName: req.file.originalname,
      bytes: req.file.buffer,
      uploadedBy: req.user!.userId,
    });

    const staged = await stageVersion({
      manifestId: id,
      parsed,
      origen: 'carga_manual',
      motivo,
      sourceFileId: file.id,
      fileContentHash: file.contentHash,
      userId: req.user!.userId,
      ip: req.ip,
    });

    if (staged.status === 'rechazada') {
      res.status(409).json({
        error: 'Manifiesto bloqueado: hay un pedimento ya cargado para este manifiesto.',
        version: staged.version,
        estadoVersion: 'rechazada',
        motivoRechazo: staged.motivoRechazo,
      });
      return;
    }
    if (staged.status === 'sin_cambios') {
      res.json({ status: 'sin_cambios', version: staged.version });
      return;
    }

    await recordAudit({
      userId: req.user!.userId,
      action: 'MANIFIESTO_VERSION_STAGED',
      entity: 'manifest',
      entityId: id,
      after: {
        version: staged.version,
        versionAnterior: staged.versionAnterior,
        motivo,
        counts: staged.counts,
        diff: staged.diff,
        lineSetHash: staged.lineSetHash,
        fileContentHash: file.contentHash,
      },
      ip: req.ip,
    });

    res.status(201).json({
      version: staged.version,
      estado: 'staged',
      counts: staged.counts,
      diff: staged.diff,
    });
  },
);

/**
 * GET /api/manifests/:id/versiones — la pantalla del auditor.
 *
 * `autoridad` lee aquí, y es el único endpoint de manifiestos donde entra. El diseño la trata como
 * TESTIGO y no como actor: puede ver qué documento llegó, cuándo, de quién, con qué motivo y qué
 * cambió — y no puede subir ni aplicar nada. `tramitador` queda fuera con la misma frase que usa
 * `riesgoRequerimientos.ts`: el rol de campo reporta hechos, no revisa expedientes documentales.
 */
manifestsRouter.get(
  '/:id/versiones',
  requireAuth,
  requireRole('admin', 'capturista', 'autoridad'),
  async (req, res) => {
    const man = await query<{ version_vigente: number }>(
      'SELECT version_vigente FROM manifests WHERE id=$1', [req.params.id]);
    if (!man.rows.length) { res.status(404).json({ error: 'Manifiesto no encontrado.' }); return; }

    // `created_by_usuario` es ADITIVO (fase 4): `created_by` sigue saliendo igual y nada que ya
    // existiera cambia. Se añade porque la pantalla del auditor tiene que contestar «¿quién mandó
    // esta versión?», y un uuid en una columna no contesta esa pregunta a nadie.
    const { rows } = await query(
      `SELECT v.version, v.estado, v.origen, v.motivo, v.motivo_rechazo, v.counts, v.diff,
              v.source_file_id, v.created_by, u.username AS created_by_usuario,
              v.created_at, v.aplicada_at
         FROM manifiesto_versiones v
         LEFT JOIN users u ON u.id = v.created_by
        WHERE v.manifest_id=$1 ORDER BY v.version DESC`,
      [req.params.id],
    );
    res.json({
      vigente: man.rows[0].version_vigente,
      versiones: rows.map((r: Record<string, unknown>) => ({
        version: r.version,
        estado: r.estado,
        origen: r.origen,
        motivo: r.motivo,
        motivoRechazo: r.motivo_rechazo,
        counts: r.counts,
        diff: r.diff,
        sourceFileId: r.source_file_id,
        createdBy: r.created_by,
        createdByUsuario: r.created_by_usuario ?? null,
        createdAt: r.created_at,
        aplicadaAt: r.aplicada_at,
      })),
    });
  },
);

/**
 * POST /api/manifests/:id/promote — la compuerta de promoción al oro, ahora consciente de versiones.
 *
 * Hace exactamente lo que hacía para la v1 (`RegistroView` no cambia). Desde la v2 exige `motivo`,
 * porque a partir de ahí lo que se promueve REEMPLAZA datos que ya se usaron para calificar riesgo.
 * Las dos compuertas interactivas —"hay filas con errores" y "no hay filas promovibles"— siguen
 * viviendo aquí y no en el servicio: son de este flujo, con un humano mirando, y la vía prealerta
 * NO las quiere (rechazar todo un manifiesto por una fila mala dejaría al caso sin análisis de
 * riesgo, que es peor que analizar lo que sí se pudo leer).
 */
manifestsRouter.post(
  '/:id/promote',
  requireAuth,
  requireRole('admin', 'capturista'),
  validate({ body: manifiestoVersionAplicarBody }),
  async (req, res) => {
    const id = req.params.id;
    const man = await query<{ ingestion_status: string }>(
      'SELECT ingestion_status FROM manifests WHERE id=$1', [id]);
    if (!man.rows.length) { res.status(404).json({ error: 'Manifiesto no encontrado.' }); return; }

    const pendiente = await versionPendiente(id);
    if (!pendiente) {
      res.status(409).json({
        error: `No se puede promover desde estado '${man.rows[0].ingestion_status}'`,
      });
      return;
    }
    const motivo = (req.body.motivo as string | undefined) ?? null;
    if (pendiente.version >= 2 && !motivo) {
      res.status(400).json({ error: 'El `motivo` es obligatorio al sustituir un manifiesto.' });
      return;
    }
    if (motivo) {
      await query('UPDATE manifiesto_versiones SET motivo=$2 WHERE id=$1', [pendiente.id, motivo]);
    }

    const staged = await query<{ status: string }>(
      `SELECT status FROM manifest_staging_rows WHERE manifest_id=$1 AND version=$2`,
      [id, pendiente.version]);
    if (staged.rows.some((r) => r.status === 'error')) {
      res.status(422).json({ error: 'Hay filas con errores; corríjalas antes de promover' });
      return;
    }
    if (!staged.rows.some((r) => r.status === 'valid' || r.status === 'warning')) {
      res.status(422).json({ error: 'No hay filas promovibles' });
      return;
    }

    const out = await aplicarVersion({
      manifestId: id,
      version: pendiente.version,
      userId: req.user!.userId,
      ip: req.ip,
    });

    if (out.status === 'rechazada') {
      // El mensaje conserva la palabra "bloqueado" que la UI ya reconoce; lo nuevo es que el archivo
      // y el rechazo quedaron registrados en vez de evaporarse.
      res.status(409).json({
        error: 'Manifiesto bloqueado: hay un pedimento ya cargado para este manifiesto.',
        version: out.version,
        estadoVersion: 'rechazada',
        motivoRechazo: out.motivoRechazo,
      });
      return;
    }
    if (out.status !== 'aplicada') {
      res.status(422).json({ error: 'No hay filas promovibles' });
      return;
    }

    // `PROMOTE_MANIFEST` se conserva como acción de auditoría —es la que existe en el historial y en
    // los tableros— junto al `MANIFIESTO_VERSIONADO` que el servicio escribe con su `before`.
    await recordAudit({
      userId: req.user!.userId,
      action: 'PROMOTE_MANIFEST',
      entity: 'manifest',
      entityId: id,
      after: { version: out.version, promoted: out.promovidas, bajas: out.bajas.length },
      ip: req.ip,
    });

    res.json({
      version: out.version,
      promoted: out.promovidas,
      bajas: out.bajas,
      guiasRetiradas: out.guiasRetiradas,
      requerimientosSinHallazgoVigente: out.requerimientosSinHallazgoVigente,
      // Los dos resúmenes: el del motor y el que queda tras las disposiciones humanas vigentes. La
      // fase 1 sólo pudo mandar el crudo porque el efectivo no existía todavía; la pantalla necesita
      // los dos para que la palabra del motor nunca desaparezca de la vista.
      summary: out.summary,
      summaryEfectivo: out.summaryEfectivo,
    });
  },
);

// POST /api/manifests/:id/client — associate a client (and optionally one of its platforms)
manifestsRouter.post('/:id/client', requireAuth, requireRole('admin', 'capturista'), validate({ body: manifestClientBody }), async (req, res) => {
  const { id } = req.params;
  const { clientId, platformId } = req.body;

  const existing = await query('SELECT id FROM manifests WHERE id=$1', [id]);
  if (existing.rows.length === 0) { res.status(404).json({ error: 'Manifiesto no encontrado.' }); return; }

  const clientCheck = await query('SELECT id FROM clients WHERE id=$1', [clientId]);
  if (clientCheck.rows.length === 0) { res.status(404).json({ error: 'Cliente no encontrado.' }); return; }

  if (platformId) {
    const pc = await query('SELECT id FROM client_platforms WHERE id=$1 AND client_id=$2', [platformId, clientId]);
    if (pc.rows.length === 0) { res.status(400).json({ error: 'Platform does not belong to client' }); return; }
  }

  // Bind the client/platform overlay (feeds every pedimento's Reporte General).
  await query('UPDATE manifests SET client_id=$1, platform_id=$2 WHERE id=$3',
    [clientId, platformId ?? null, id]);
  // Bust the cached Reporte General for ALL of this manifest's pedimentos — the overlay changed, so
  // each subdivisión's report must regenerate. (The report cache is per-pedimento as of Task 10.)
  await query('UPDATE pedimentos SET report_file_id=NULL WHERE manifest_id=$1', [id]);
  await recordAudit({
    userId: req.user!.userId,
    action: 'LINK_CLIENT',
    entity: 'manifest',
    entityId: id,
    after: { clientId, platformId: platformId ?? null },
    ip: req.ip,
  });
  res.json({ ok: true });
});

/**
 * DELETE /:id — borra un manifiesto completo para poder recargarlo.
 *
 * Petición explícita del cliente (correo 10-ago, punto 2): "borrar registro por registro de
 * manifiestos, para volverlos a cargar o actualizar en caso de incidencias". Sin esto, un
 * manifiesto mal cargado se queda para siempre y contamina el seguimiento.
 *
 * DOS GUARDAS, y las dos son sobre cosas que NO se pueden deshacer:
 *
 * 1. Un pedimento finalizado es una declaración ya hecha a la autoridad. Borrar el manifiesto
 *    que le dio origen dejaría esa declaración sin respaldo documental, así que se exige
 *    reabrirlo primero — el mismo criterio que ya aplica `DELETE /pedimentos/:id`.
 * 2. Un caso de operaciones con bitácora es append-only por diseño. El FK es SET NULL, así que
 *    el borrado no lo destruiría, pero lo dejaría huérfano: un caso que afirma cotejar contra un
 *    manifiesto que ya no existe. Preferimos negarnos a producir esa inconsistencia.
 *
 * Todo lo demás (guías, staging, versiones, disposiciones, scans) cae por CASCADE.
 */
manifestsRouter.delete('/:id', requireAuth, requireRole('admin', 'capturista'), async (req, res, next) => {
  try {
    const { id } = req.params;

    const info = await query<{
      mawb_reference: string | null;
      guias: string;
      pedimentos_finalizados: string;
      operaciones_ligadas: string;
    }>(
      `SELECT m.mawb_reference,
              (SELECT count(*) FROM shipments s WHERE s.manifest_id = m.id)::text AS guias,
              (SELECT count(*) FROM pedimentos p
                WHERE p.manifest_id = m.id AND p.sub_status = 'cargado')::text     AS pedimentos_finalizados,
              (SELECT count(*) FROM operaciones o WHERE o.manifest_id = m.id)::text AS operaciones_ligadas
         FROM manifests m
        WHERE m.id = $1`,
      [id],
    );
    if (!info.rows.length) {
      res.status(404).json({ error: 'Manifiesto no encontrado' });
      return;
    }
    const row = info.rows[0];

    if (Number(row.pedimentos_finalizados) > 0) {
      res.status(409).json({
        error: `No se puede borrar: tiene ${row.pedimentos_finalizados} pedimento(s) finalizado(s). Reábralos primero.`,
      });
      return;
    }
    if (Number(row.operaciones_ligadas) > 0) {
      res.status(409).json({
        error: `No se puede borrar: hay ${row.operaciones_ligadas} caso(s) de operaciones ligados a este manifiesto.`,
      });
      return;
    }

    await query('DELETE FROM manifests WHERE id = $1', [id]);

    // recordAudit corre DESPUÉS del commit (regla de la casa: la cadena de hash toma su propio
    // advisory lock). El `before` conserva lo borrado, que es lo único que queda como rastro.
    await recordAudit({
      userId: req.user!.userId,
      action: 'DELETE_MANIFEST',
      entity: 'manifest',
      entityId: id,
      before: { mawbReference: row.mawb_reference, guias: Number(row.guias) },
      ip: req.ip,
    });

    res.json({ deleted: true, mawbReference: row.mawb_reference, guias: Number(row.guias) });
  } catch (err) {
    next(err);
  }
});
