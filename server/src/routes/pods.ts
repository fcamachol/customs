import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import * as XLSX from 'xlsx';
import { query } from '../db/pool';
import { withTransaction } from '../db/tx';
import { isUniqueViolation } from '../db/errors';
import { requireAuth, requireRole } from '../auth/middleware';
import { recordAudit } from '../services/audit';
import { mirrorEstadoDeOperacion, mirrorEventoToAgora } from '../services/agoraMirror';
import { saveFile } from '../storage/files';
import { validate } from '../validation/middleware';
import {
  despachoParam,
  podEnviadoBody,
  podFirmadoBody,
  podGenerarBody,
  podListQuery,
  podParam,
  podRechazadoBody,
  type PodEnviadoBody,
  type PodFirmadoBody,
  type PodGenerarBody,
  type PodRechazadoBody,
} from '../validation/schemas';
import { canAdvanceEstadoDespacho, etiquetaTipoUnidad, type EstadoDespacho } from '../../../shared/operaciones/catalogos';
import { canAdvanceEtapa, type Etapa } from '../../../shared/operaciones/estados';
import { construirPod, filasPod, type PodPartidaEntrada, type PodSnapshot } from '../../../shared/operaciones/pod';
import { registrarEventoDespacho } from './despachos';

/**
 * POD — proof of delivery, the fact that closes the physical chain (PRD-02 R28, R39; Q6 pending).
 *
 * THE FILE IN ONE SENTENCE: this is where a client's signature, and nothing else, turns a trip that
 * arrived somewhere into a delivery that happened.
 *
 * WHY ARRIVAL DOES NOT DELIVER. `POST /api/despachos/:id/arribo` deliberately records `arribo_real`
 * and stops there (R36/D14). A unit can reach the gate and be turned away, or arrive with fewer
 * cartons than the plan said; both are arrivals and neither is a delivery. So `POD_FIRMADO` is what
 * advances the despacho to `entregado` and every caso riding on it to etapa `entregado` — and it is
 * the only event in this system produced by somebody outside this organisation. Everything
 * downstream leans on that: R43's invoice line may only be built from guías a client signed for.
 *
 * MONOTONICITY IS BORROWED, NOT REINVENTED. The trip advances through `canAdvanceEstadoDespacho`
 * and each caso through `canAdvanceEtapa`, both with the same ledger-reading discipline
 * despachos.ts already uses: when a trip is paused in `en_espera` the pause point is read back from
 * the last DESPACHO_ESTADO event, so resuming into delivery cannot silently rewind the trip. A caso
 * that cannot advance (already `entregado`, `cerrada` or `cancelada`) is REPORTED in the response
 * rather than forced — the POD is still signed, and pretending otherwise would be the ledger
 * stuttering.
 *
 * THE DOCUMENT IS REGENERABLE UNTIL IT IS SIGNED, AND NEVER AFTER. Luis asked for the despacho
 * screen to be editable because a guía whose pedimento is not ready gets swapped for another one,
 * and the POD is generated from that assignment. So regeneration bumps `pods.version`, writes its
 * own ledger event and replaces the rendered file — until `estado = 'firmado'`, at which point the
 * document stops being a rendering of a plan and becomes evidence of what a person signed. A system
 * that can quietly reprint evidence has no evidence.
 *
 * A REFUSAL IS AN OUTCOME, NOT A GAP. `POST /:id/rechazado` records that the client would not
 * receive the cargo, with their stated reason (R40). It does NOT deliver: the trip stays short of
 * `entregado` and the guías stay un-billable, which is the honest answer and the expensive one.
 */
export const podsRouter = Router();

/** POD generation hangs off the trip it is generated FROM (R28) — mounted on /api/despachos. */
export const despachoPodRouter = Router();

type Q = (text: string, params?: unknown[]) => Promise<any>;

/**
 * Evidence upload limits, identical to `routes/campo.ts` on purpose: the signed POD arrives the same
 * way the loading photo does — a phone camera in a warehouse doorway, over a bad connection.
 */
const uploadPod = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

const TIPOS_CONTENIDO_POD = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'application/pdf',
]);

const SELECT_POD = `
  p.id,
  p.despacho_id              AS "despachoId",
  p.folio,
  p.version,
  p.estado,
  p.file_id_generado         AS "fileIdGenerado",
  p.file_id_firmado          AS "fileIdFirmado",
  p.firma_evidencia_file_id  AS "firmaEvidenciaFileId",
  p.enviado_at               AS "enviadoAt",
  p.firmado_por              AS "firmadoPor",
  p.firmado_at               AS "firmadoAt",
  p.motivo_rechazo           AS "motivoRechazo",
  p.observaciones,
  p.created_at               AS "createdAt",
  d.folio                    AS "despachoFolio",
  d.fecha_operacion          AS "fechaOperacion",
  d.estado                   AS "despachoEstado",
  t.razon_social             AS "transportista",
  cd.alias                   AS "destino"`;

const FROM_POD = `
  FROM pods p
  JOIN despachos d ON d.id = p.despacho_id
  LEFT JOIN transportistas t ON t.id = d.transportista_id
  LEFT JOIN client_direcciones cd ON cd.id = d.direccion_entrega_id`;

function comoIso(v: Date | string | null | undefined): string | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Render the snapshot into the workbook the driver carries. One sheet: a POD is a form, not a dataset. */
function libroPod(snapshot: PodSnapshot): Buffer {
  const ws = XLSX.utils.aoa_to_sheet(filasPod(snapshot));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'POD');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

/**
 * Read the trip and its load, and build the snapshot the document is rendered from.
 *
 * Everything the sheet says is read in ONE place so the rendered file, the stored snapshot and the
 * ledger event can never describe three slightly different trips.
 */
async function snapshotDeDespacho(
  q: Q,
  args: { despachoId: string; folio: string; version: number; observaciones: string | null; generadoAt: Date },
): Promise<PodSnapshot | null> {
  const d = await q(
    `SELECT d.id, d.folio, d.fecha_operacion::text AS fecha, d.tipo_unidad, d.placas,
            d.operador_nombre, d.salida_at, d.eta_calculado, d.arribo_real, d.comentarios,
            t.razon_social AS transportista,
            cd.alias AS destino_alias, cd.direccion AS destino_direccion, cd.ciudad AS destino_ciudad
       FROM despachos d
       LEFT JOIN transportistas t ON t.id = d.transportista_id
       LEFT JOIN client_direcciones cd ON cd.id = d.direccion_entrega_id
      WHERE d.id = $1`,
    [args.despachoId],
  );
  if (!d.rows.length) return null;
  const row = d.rows[0] as Record<string, any>;

  const partidas = await q(
    `SELECT g.guia_norm AS guia, o.mawb, c.name AS cliente,
            ped.numero_pedimento AS pedimento,
            p.cartones_planeados, p.cartones_cargados, p.piezas, p.orden_carga
       FROM despacho_partidas p
       JOIN operaciones o ON o.id = p.operacion_id
       LEFT JOIN operacion_guias g ON g.id = p.operacion_guia_id
       LEFT JOIN clients c ON c.id = COALESCE(g.client_id, o.client_id)
       LEFT JOIN pedimentos ped ON ped.id = COALESCE(p.pedimento_id, g.pedimento_id)
      WHERE p.despacho_id = $1
      ORDER BY p.orden_carga NULLS LAST, p.created_at`,
    [args.despachoId],
  );

  const lineas: PodPartidaEntrada[] = partidas.rows.map((r: Record<string, any>) => ({
    guia: r.guia ?? null,
    mawb: String(r.mawb),
    cliente: r.cliente ?? null,
    pedimento: r.pedimento ?? null,
    cartonesPlaneados: r.cartones_planeados == null ? null : Number(r.cartones_planeados),
    cartonesCargados: r.cartones_cargados == null ? null : Number(r.cartones_cargados),
    piezas: r.piezas == null ? null : Number(r.piezas),
    ordenCarga: r.orden_carga == null ? null : Number(r.orden_carga),
  }));

  const direccion = [row.destino_direccion, row.destino_ciudad].filter(Boolean).join(', ') || null;

  return construirPod({
    folio: args.folio,
    despachoFolio: String(row.folio),
    fechaOperacion: String(row.fecha),
    tipoUnidad: String(row.tipo_unidad),
    tipoUnidadLabel: etiquetaTipoUnidad(String(row.tipo_unidad)),
    transportista: row.transportista ?? null,
    placas: row.placas ?? null,
    operadorNombre: row.operador_nombre ?? null,
    destinoAlias: row.destino_alias ?? null,
    destinoDireccion: direccion,
    salidaAt: comoIso(row.salida_at),
    etaCalculado: comoIso(row.eta_calculado),
    arriboReal: comoIso(row.arribo_real),
    observaciones: args.observaciones ?? row.comentarios ?? null,
    partidas: lineas,
    generadoAt: args.generadoAt.toISOString(),
    version: args.version,
  });
}

// =================================================================================================
// Generación — R28 / R39
// =================================================================================================

/**
 * POST /api/despachos/:id/pod — generate (or regenerate) the delivery sheet.
 *
 * Refused for a trip that never had cargo: a POD with no lines is a piece of paper claiming a
 * delivery of nothing, and the client would be asked to sign it. Refused once signed, for the reason
 * in the file header.
 */
despachoPodRouter.post(
  '/:id/pod',
  requireAuth,
  requireRole('admin', 'capturista'),
  validate({ params: despachoParam, body: podGenerarBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const b = req.body as PodGenerarBody;
      const userId = req.user!.userId;
      const generadoAt = new Date();

      // The document is produced (and hashed into `files`) BEFORE the row is written, same order as
      // every other evidence path here: rule R-A, archive before you act.
      const preparado = await withTransaction(async (q: Q) => {
        const d = await q(
          'SELECT id, folio, estado FROM despachos WHERE id = $1 FOR UPDATE',
          [id],
        );
        if (!d.rows.length) return { kind: 'no_encontrado' as const };
        const despacho = d.rows[0] as { folio: string; estado: EstadoDespacho };
        if (despacho.estado === 'cancelado') return { kind: 'cancelado' as const };

        const n = await q('SELECT count(*)::int AS n FROM despacho_partidas WHERE despacho_id = $1', [id]);
        if ((n.rows[0].n as number) === 0) return { kind: 'sin_carga' as const };

        const existente = await q(
          'SELECT id, folio, version, estado FROM pods WHERE despacho_id = $1 FOR UPDATE',
          [id],
        );
        const prev = existente.rows[0] as { id: string; folio: string; version: number; estado: string } | undefined;
        if (prev && prev.estado === 'firmado') return { kind: 'ya_firmado' as const, folio: prev.folio };

        const folio = prev?.folio ?? `POD-${despacho.folio}`;
        const version = (prev?.version ?? 0) + 1;
        const snapshot = await snapshotDeDespacho(q, {
          despachoId: id,
          folio,
          version,
          observaciones: b.observaciones ?? null,
          generadoAt,
        });
        if (!snapshot) return { kind: 'no_encontrado' as const };
        return { kind: 'listo' as const, snapshot, prev, folio, version, despacho };
      });

      switch (preparado.kind) {
        case 'no_encontrado':
          res.status(404).json({ error: 'Despacho no encontrado' });
          return;
        case 'cancelado':
          res.status(409).json({ error: 'El despacho está cancelado: no se genera una prueba de entrega de un viaje que no salió.' });
          return;
        case 'sin_carga':
          res.status(409).json({
            error: 'El despacho no tiene guías asignadas: un POD sin partidas es un papel que declara la entrega de nada.',
          });
          return;
        case 'ya_firmado':
          res.status(409).json({
            error: `El POD ${preparado.folio} ya está firmado: un documento firmado es evidencia, no se vuelve a generar.`,
          });
          return;
        default:
          break;
      }

      const archivo = await saveFile({
        kind: 'pod',
        originalName: `${preparado.folio}-v${preparado.version}.xlsx`,
        bytes: libroPod(preparado.snapshot),
        uploadedBy: userId,
      });

      const resultado = await withTransaction(async (q: Q) => {
        const guardado = preparado.prev
          ? await q(
              // `motivo_rechazo = NULL` is required by `pods_rechazo_motivo_check` and is safe: the
              // client's stated reason lives permanently in the POD_RECHAZADO ledger event, which is
              // append-only. Regenerating after a refusal is the normal recovery — fix the load,
              // reprint, redeliver — so the column returns to describing the CURRENT document.
              `UPDATE pods
                  SET version = $2, estado = 'generado', file_id_generado = $3, snapshot = $4::jsonb,
                      observaciones = COALESCE($5, observaciones), enviado_at = NULL,
                      motivo_rechazo = NULL
                WHERE id = $1
                RETURNING id, folio, version, estado`,
              [preparado.prev.id, preparado.version, archivo.id, JSON.stringify(preparado.snapshot), b.observaciones ?? null],
            )
          : await q(
              `INSERT INTO pods (despacho_id, folio, version, file_id_generado, snapshot, observaciones, created_by)
               VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)
               RETURNING id, folio, version, estado`,
              [id, preparado.folio, preparado.version, archivo.id, JSON.stringify(preparado.snapshot), b.observaciones ?? null, userId],
            );
        const pod = guardado.rows[0];

        const { eventos, operacionIds } = await registrarEventoDespacho(q, {
          despachoId: id,
          tipo: 'POD_GENERADO',
          payload: {
            podId: pod.id,
            folio: pod.folio,
            version: pod.version,
            fileId: archivo.id,
            contentHash: archivo.contentHash,
            layoutVersion: preparado.snapshot.layoutVersion,
            totales: preparado.snapshot.totales,
            regenerado: Boolean(preparado.prev),
          },
          userId,
        });
        return { pod, eventos, operacionIds };
      });

      await recordAudit({
        userId,
        action: 'POD_GENERADO',
        entity: 'pod',
        entityId: resultado.pod.id,
        after: {
          despachoId: id,
          folio: resultado.pod.folio,
          version: resultado.pod.version,
          fileId: archivo.id,
          contentHash: archivo.contentHash,
          layoutVersion: preparado.snapshot.layoutVersion,
          totales: preparado.snapshot.totales,
        },
        ip: req.ip,
      });

      res.status(201).json({
        ok: true,
        ...resultado.pod,
        despachoId: id,
        fileId: archivo.id,
        contentHash: archivo.contentHash,
        layoutVersion: preparado.snapshot.layoutVersion,
        totales: preparado.snapshot.totales,
        snapshot: preparado.snapshot,
        eventosRegistrados: resultado.eventos,
        // The template is still pending from Luis (Q6). Said out loud rather than implied, so nobody
        // reads the generated layout as the agreed one.
        advertencia: 'Plantilla de POD pendiente de definición del cliente (Q6): el layout es el provisional del sistema.',
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        res.status(409).json({ error: 'Ya existe un POD para ese despacho.' });
        return;
      }
      next(err);
    }
  },
);

/** GET /api/despachos/:id/pod — the trip's delivery document, if it has one. */
despachoPodRouter.get(
  '/:id/pod',
  requireAuth,
  validate({ params: despachoParam }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { rows } = await query(
        `SELECT ${SELECT_POD}, p.snapshot ${FROM_POD} WHERE p.despacho_id = $1`,
        [req.params.id],
      );
      if (!rows.length) {
        res.status(404).json({ error: 'Este despacho todavía no tiene POD generado.' });
        return;
      }
      res.json(rows[0]);
    } catch (err) {
      next(err);
    }
  },
);

// =================================================================================================
// Lectura — /api/pods
// =================================================================================================

podsRouter.get(
  '/',
  requireAuth,
  validate({ query: podListQuery }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { estado, fecha, despachoId } = req.query as Record<string, string | undefined>;
      const { rows } = await query(
        `SELECT ${SELECT_POD} ${FROM_POD}
          WHERE ($1::text IS NULL OR p.estado = $1)
            AND ($2::date IS NULL OR d.fecha_operacion = $2::date)
            AND ($3::uuid IS NULL OR p.despacho_id = $3::uuid)
          ORDER BY d.fecha_operacion DESC, p.folio
          LIMIT 500`,
        [estado ?? null, fecha ?? null, despachoId ?? null],
      );
      res.json(rows);
    } catch (err) {
      next(err);
    }
  },
);

podsRouter.get(
  '/:id',
  requireAuth,
  validate({ params: podParam }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { rows } = await query(
        `SELECT ${SELECT_POD}, p.snapshot ${FROM_POD} WHERE p.id = $1`,
        [req.params.id],
      );
      if (!rows.length) {
        res.status(404).json({ error: 'POD no encontrado' });
        return;
      }
      const eventos = await query(
        `SELECT id, operacion_id AS "operacionId", operacion_mawb AS "mawb", tipo, origen,
                ocurrido_at AS "ocurridoAt", registrado_at AS "registradoAt", payload
           FROM operacion_eventos
          WHERE despacho_id = $1 AND tipo LIKE 'POD\\_%'
          ORDER BY ocurrido_at, id`,
        [rows[0].despachoId],
      );
      res.json({ ...rows[0], eventos: eventos.rows });
    } catch (err) {
      next(err);
    }
  },
);

// =================================================================================================
// Ciclo de vida — enviado / firmado / rechazado
// =================================================================================================

/** POST /api/pods/:id/enviado — the sheet went out for signature. */
podsRouter.post(
  '/:id/enviado',
  requireAuth,
  requireRole('admin', 'capturista'),
  validate({ params: podParam, body: podEnviadoBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const b = req.body as PodEnviadoBody;
      const userId = req.user!.userId;
      const enviado = b.enviadoAt ? new Date(b.enviadoAt) : new Date();

      const resultado = await withTransaction(async (q: Q) => {
        const p = await q('SELECT id, despacho_id, folio, estado FROM pods WHERE id = $1 FOR UPDATE', [id]);
        if (!p.rows.length) return { kind: 'no_encontrado' as const };
        const pod = p.rows[0] as { despacho_id: string; folio: string; estado: string };
        if (pod.estado === 'enviado') return { kind: 'noop' as const, estado: pod.estado };
        if (pod.estado !== 'generado') return { kind: 'estado_invalido' as const, estado: pod.estado };

        await q(`UPDATE pods SET estado = 'enviado', enviado_at = $2 WHERE id = $1`, [id, enviado]);
        const { eventos } = await registrarEventoDespacho(q, {
          despachoId: pod.despacho_id,
          tipo: 'POD_ENVIADO',
          payload: {
            podId: id,
            folio: pod.folio,
            enviadoAt: enviado.toISOString(),
            destinatario: b.destinatario ?? null,
          },
          userId,
          ocurridoAt: enviado,
        });
        return { kind: 'ok' as const, pod, eventos };
      });

      switch (resultado.kind) {
        case 'no_encontrado':
          res.status(404).json({ error: 'POD no encontrado' });
          return;
        case 'noop':
          res.json({ ok: true, noop: true, estado: resultado.estado });
          return;
        case 'estado_invalido':
          res.status(409).json({
            error: `El POD está en estado '${resultado.estado}' y ya no puede marcarse como enviado.`,
          });
          return;
        default:
          break;
      }

      await recordAudit({
        userId,
        action: 'POD_ENVIADO',
        entity: 'pod',
        entityId: id,
        after: { folio: resultado.pod.folio, enviadoAt: enviado.toISOString(), destinatario: b.destinatario ?? null },
        ip: req.ip,
      });

      res.status(201).json({ ok: true, podId: id, estado: 'enviado', enviadoAt: enviado.toISOString(), eventosRegistrados: resultado.eventos });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /api/pods/:id/firmado — the signature comes back, and the delivery completes (R39).
 *
 * Multipart: the signed sheet is a photo or a scan, uploaded exactly like the field evidence
 * (`routes/campo.ts`), hashed by `saveFile` before anything is written. A signature nobody archived
 * is a claim; a signature archived with its sha256 is a record.
 *
 * The optional second file (`firma`) is a separate capture — a signature image, a photo at the dock
 * — kept in its own column because "we have the signed sheet" and "we photographed the signing" are
 * different claims and only one of them is the document.
 *
 * `tramitador` is allowed: the person holding the paper at the client's warehouse is the field role,
 * and routing this through an office phone call is how the delivery time stops being real.
 */
podsRouter.post(
  '/:id/firmado',
  requireAuth,
  requireRole('admin', 'capturista', 'tramitador'),
  uploadPod.fields([{ name: 'file', maxCount: 1 }, { name: 'firma', maxCount: 1 }]),
  validate({ params: podParam, body: podFirmadoBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const b = req.body as PodFirmadoBody;
      const userId = req.user!.userId;
      const firmado = b.firmadoAt ? new Date(b.firmadoAt) : new Date();

      const archivos = (req.files ?? {}) as Record<string, Express.Multer.File[] | undefined>;
      const firmadoFile = archivos.file?.[0];
      const firmaFile = archivos.firma?.[0];
      if (!firmadoFile) {
        res.status(400).json({
          error: 'Falta el archivo del POD firmado (campo `file`): una firma sin documento archivado es un dicho, no un registro.',
        });
        return;
      }
      for (const f of [firmadoFile, firmaFile]) {
        if (!f) continue;
        const ct = (f.mimetype ?? '').toLowerCase();
        if (!TIPOS_CONTENIDO_POD.has(ct)) {
          res.status(400).json({
            error: `Tipo de archivo no permitido ('${ct || 'desconocido'}'). Se aceptan imágenes (jpeg, png, webp, heic) o PDF.`,
          });
          return;
        }
      }

      // Fail fast before archiving bytes for a POD that cannot be signed.
      const previo = await query<{ estado: string; folio: string }>(
        'SELECT estado, folio FROM pods WHERE id = $1',
        [id],
      );
      if (!previo.rows.length) {
        res.status(404).json({ error: 'POD no encontrado' });
        return;
      }
      if (previo.rows[0].estado === 'firmado') {
        res.status(409).json({
          error: `El POD ${previo.rows[0].folio} ya está firmado: sobrescribirlo borraría la firma original.`,
        });
        return;
      }
      if (previo.rows[0].estado === 'rechazado') {
        res.status(409).json({
          error: `El POD ${previo.rows[0].folio} está rechazado por el cliente: primero se regenera, no se firma encima del rechazo.`,
        });
        return;
      }

      const archivoFirmado = await saveFile({
        kind: 'pod',
        originalName: firmadoFile.originalname,
        bytes: firmadoFile.buffer,
        uploadedBy: userId,
      });
      const archivoFirma = firmaFile
        ? await saveFile({
            kind: 'evidencia',
            originalName: firmaFile.originalname,
            bytes: firmaFile.buffer,
            uploadedBy: userId,
          })
        : null;

      const resultado = await withTransaction(async (q: Q) => {
        const p = await q(
          'SELECT id, despacho_id, folio, estado FROM pods WHERE id = $1 FOR UPDATE',
          [id],
        );
        if (!p.rows.length) return { kind: 'no_encontrado' as const };
        const pod = p.rows[0] as { despacho_id: string; folio: string; estado: string };
        if (pod.estado === 'firmado' || pod.estado === 'rechazado') {
          return { kind: 'estado_invalido' as const, estado: pod.estado, folio: pod.folio };
        }

        await q(
          `UPDATE pods
              SET estado = 'firmado', firmado_por = $2, firmado_at = $3,
                  file_id_firmado = $4, firma_evidencia_file_id = $5,
                  observaciones = COALESCE($6, observaciones)
            WHERE id = $1`,
          [id, b.firmadoPor, firmado, archivoFirmado.id, archivoFirma?.id ?? null, b.observaciones ?? null],
        );

        // ---- the trip reaches `entregado`, with the same ledger-reading pause resolution as
        // `POST /api/despachos/:id/estado`. A paused trip must not rewind by being delivered.
        const d = await q('SELECT id, folio, estado FROM despachos WHERE id = $1 FOR UPDATE', [pod.despacho_id]);
        const despacho = d.rows[0] as { folio: string; estado: EstadoDespacho };
        let base: EstadoDespacho = despacho.estado;
        let reanudando = false;
        if (despacho.estado === 'en_espera') {
          reanudando = true;
          const prev = await q(
            `SELECT payload->>'estado' AS estado
               FROM operacion_eventos
              WHERE despacho_id = $1 AND tipo = 'DESPACHO_ESTADO'
                AND payload->>'estado' IS DISTINCT FROM 'en_espera'
              ORDER BY id DESC LIMIT 1`,
            [pod.despacho_id],
          );
          base = (prev.rows[0]?.estado as EstadoDespacho) ?? 'planeado';
        }
        const despachoAvanza =
          despacho.estado !== 'entregado' &&
          canAdvanceEstadoDespacho(base, 'entregado', { reanudandoDesdeEspera: reanudando });
        if (despachoAvanza) {
          await q(`UPDATE despachos SET estado = 'entregado' WHERE id = $1`, [pod.despacho_id]);
        }

        // ---- every caso riding on the unit reaches etapa `entregado`, monotonically. One that
        // cannot (already delivered, closed or cancelled) is reported, never forced.
        const casos = await q(
          // `IN (...)` rather than a DISTINCT join: Postgres refuses FOR UPDATE with DISTINCT, and
          // the row lock is the point — two writers must not both read the same etapa and both
          // decide they are advancing it.
          `SELECT o.id, o.mawb, o.etapa, o.agora_conversation_id
             FROM operaciones o
            WHERE o.id IN (SELECT operacion_id FROM despacho_partidas WHERE despacho_id = $1)
            FOR UPDATE`,
          [pod.despacho_id],
        );
        const avanzadas: string[] = [];
        const sinAvanzar: Array<{ mawb: string; etapa: string }> = [];
        for (const caso of casos.rows as Array<{ id: string; mawb: string; etapa: Etapa; agora_conversation_id: string | null }>) {
          if (canAdvanceEtapa(caso.etapa, 'entregado')) {
            await q(`UPDATE operaciones SET etapa = 'entregado' WHERE id = $1`, [caso.id]);
            avanzadas.push(caso.mawb);
          } else if (caso.etapa !== 'entregado') {
            sinAvanzar.push({ mawb: caso.mawb, etapa: caso.etapa });
          }
        }

        const payload: Record<string, unknown> = {
          podId: id,
          folio: pod.folio,
          despachoFolio: despacho.folio,
          firmadoPor: b.firmadoPor,
          firmadoAt: firmado.toISOString(),
          fileId: archivoFirmado.id,
          contentHash: archivoFirmado.contentHash,
          firmaEvidenciaFileId: archivoFirma?.id ?? null,
          firmaEvidenciaContentHash: archivoFirma?.contentHash ?? null,
          etapa: 'entregado',
          despachoEntregado: despachoAvanza,
        };

        const { eventos } = await registrarEventoDespacho(q, {
          despachoId: pod.despacho_id,
          tipo: 'POD_FIRMADO',
          payload,
          userId,
          origen: req.user!.role === 'tramitador' ? 'tramitador' : 'coordinador',
          ocurridoAt: firmado,
        });

        return {
          kind: 'ok' as const,
          pod,
          despacho,
          despachoAvanza,
          avanzadas,
          sinAvanzar,
          payload,
          eventos,
          casos: casos.rows as Array<{ id: string; agora_conversation_id: string | null }>,
        };
      });

      switch (resultado.kind) {
        case 'no_encontrado':
          res.status(404).json({ error: 'POD no encontrado' });
          return;
        case 'estado_invalido':
          res.status(409).json({ error: `El POD ${resultado.folio} está en estado '${resultado.estado}'.` });
          return;
        default:
          break;
      }

      await recordAudit({
        userId,
        action: 'POD_FIRMADO',
        entity: 'pod',
        entityId: id,
        after: {
          ...resultado.payload,
          operacionesEntregadas: resultado.avanzadas,
          operacionesSinAvanzar: resultado.sinAvanzar,
        },
        ip: req.ip,
      });

      // Best-effort mirror, guarded and swallowed: the client's thread is where the coordinator will
      // look for "did it arrive?", and a mirror failure must never 500 a delivery already committed.
      try {
        for (const caso of resultado.casos) {
          if (!caso.agora_conversation_id) continue;
          await mirrorEventoToAgora({
            operacionId: caso.id,
            agoraConversationId: caso.agora_conversation_id,
            tipo: 'POD_FIRMADO',
            payloadResumen: resultado.payload,
          });
          await mirrorEstadoDeOperacion(caso.id);
        }
      } catch (err) {
        console.warn('[pods] no se pudo espejar el POD firmado en AGORA:', err);
      }

      res.status(201).json({
        ok: true,
        estado: 'firmado',
        ...resultado.payload,
        operacionesEntregadas: resultado.avanzadas,
        operacionesSinAvanzar: resultado.sinAvanzar,
        eventosRegistrados: resultado.eventos,
        // A delivery signed without an arrival ever recorded is not refused — the signature is the
        // fact, and blocking it because a button went unpressed would be the system arguing with the
        // client. It is reported, so the gap gets closed instead of disappearing (D14).
        advertencia: resultado.despachoAvanza ? null : 'El despacho no avanzó a entregado: revisa su estado actual.',
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /api/pods/:id/rechazado — the client would not receive the cargo (R40).
 *
 * Deliberately NOT a delivery: no etapa moves, the trip stays short of `entregado`, and the guías
 * stay outside R43's invoice. The reason is mandatory because a refusal with no stated cause is the
 * single most expensive event in the process and the one most worth arguing about later.
 */
podsRouter.post(
  '/:id/rechazado',
  requireAuth,
  requireRole('admin', 'capturista', 'tramitador'),
  validate({ params: podParam, body: podRechazadoBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const b = req.body as PodRechazadoBody;
      const userId = req.user!.userId;
      const ocurrido = b.ocurridoAt ? new Date(b.ocurridoAt) : new Date();

      const resultado = await withTransaction(async (q: Q) => {
        const p = await q('SELECT id, despacho_id, folio, estado FROM pods WHERE id = $1 FOR UPDATE', [id]);
        if (!p.rows.length) return { kind: 'no_encontrado' as const };
        const pod = p.rows[0] as { despacho_id: string; folio: string; estado: string };
        if (pod.estado === 'firmado') return { kind: 'ya_firmado' as const, folio: pod.folio };
        if (pod.estado === 'rechazado') return { kind: 'noop' as const, estado: pod.estado };

        await q(`UPDATE pods SET estado = 'rechazado', motivo_rechazo = $2 WHERE id = $1`, [id, b.motivo]);

        const payload = {
          podId: id,
          folio: pod.folio,
          motivo: b.motivo,
          ocurridoAt: ocurrido.toISOString(),
          efecto: 'La entrega NO se completó: el despacho no avanza a entregado y las guías no son facturables.',
        };
        const { eventos, operacionIds } = await registrarEventoDespacho(q, {
          despachoId: pod.despacho_id,
          tipo: 'POD_RECHAZADO',
          payload,
          userId,
          origen: req.user!.role === 'tramitador' ? 'tramitador' : 'coordinador',
          ocurridoAt: ocurrido,
          motivo: b.motivo,
        });
        return { kind: 'ok' as const, pod, payload, eventos, operacionIds };
      });

      switch (resultado.kind) {
        case 'no_encontrado':
          res.status(404).json({ error: 'POD no encontrado' });
          return;
        case 'ya_firmado':
          res.status(409).json({
            error: `El POD ${resultado.folio} ya está firmado: no se puede rechazar una entrega que el cliente ya aceptó.`,
          });
          return;
        case 'noop':
          res.json({ ok: true, noop: true, estado: resultado.estado });
          return;
        default:
          break;
      }

      await recordAudit({
        userId,
        action: 'POD_RECHAZADO',
        entity: 'pod',
        entityId: id,
        after: { ...resultado.payload, operacionesAfectadas: resultado.operacionIds.length },
        ip: req.ip,
      });

      res.status(201).json({ ok: true, estado: 'rechazado', ...resultado.payload, eventosRegistrados: resultado.eventos });
    } catch (err) {
      next(err);
    }
  },
);
