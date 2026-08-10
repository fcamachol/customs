import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { query } from '../db/pool';
import { requireAuth, requireRole } from '../auth/middleware';
import { recordAudit } from '../services/audit';
import { validate } from '../validation/middleware';
import { readFileById, saveFile } from '../storage/files';
import { cincelConfigurado, solicitarFirma, type CincelOutcome } from '../services/cincel';
import {
  convenioCreateBody,
  convenioFirmarBody,
  convenioIdParam,
  convenioListQuery,
  type ConvenioCreateBody,
  type ConvenioFirmarBody,
  type ConvenioListQuery,
} from '../validation/schemas';

/**
 * CONVENIOS — the client service agreement, signed digitally with NOM-151 conservation evidence via
 * Cincel (PRD-02 Excel item 8, `R25`/`D9`; see `migrations/1700005400000_convenios.ts` for why this
 * anchors to `clients` rather than the not-yet-built `transportistas` catalog, #29).
 *
 * THE SHAPE OF THIS FILE MIRRORS `routes/riesgoRequerimientos.ts` + `services/requerimientosService.ts`
 * on purpose: uploading a convenio is a human act, requesting a signature degrades honestly when
 * Cincel is unconfigured (`services/cincel.ts`, built like `services/mailer.ts` for #22), and the
 * clock (`estado_firma`) only ever advances on a CONFIRMED outcome — never on the attempt.
 *
 * Four endpoints:
 *   `POST   /api/convenios`                  upload the document (hash-and-store BEFORE the row, R-A)
 *   `GET    /api/convenios` / `/:id`          list / detail
 *   `POST   /api/convenios/:id/firmar`        dispatch (or retry) the Cincel signature request
 *   `POST   /api/convenios/cincel/webhook`    Cincel's signature-completion callback — HMAC-verified,
 *                                             no JWT, same posture as `routes/prealertas.ts`'s inbound
 *                                             webhook: identity is proved by the signature, not a
 *                                             session, and the endpoint fails CLOSED with no configured
 *                                             secret rather than accepting anything that can reach it.
 */
export const conveniosRouter = Router();

const rolesConsulta = ['admin', 'autoridad'] as const;

// -------------------------------------------------------------------------------------------------
// Upload
// -------------------------------------------------------------------------------------------------

/** 20 MB: a multi-page scanned contract is a few MB; well under the 100 MB manifest ceiling. */
const uploadConvenio = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

/** A contract is a document, not a photo — no HEIC/webp allowance here unlike `routes/campo.ts`. */
const TIPOS_CONTENIDO_CONVENIO = new Set(['application/pdf', 'image/jpeg', 'image/png']);

conveniosRouter.post(
  '/',
  requireAuth,
  requireRole('admin'),
  // multer first: without it req.body is empty for multipart and validate() would reject clientId.
  uploadConvenio.single('file'),
  validate({ body: convenioCreateBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { clientId, vigenciaDesde, vigenciaHasta } = req.body as ConvenioCreateBody;

      if (!req.file) {
        res.status(400).json({ error: 'Falta el archivo del convenio (campo `file`).' });
        return;
      }
      const contentType = (req.file.mimetype ?? '').toLowerCase();
      if (!TIPOS_CONTENIDO_CONVENIO.has(contentType)) {
        res.status(400).json({
          error: `Tipo de archivo no permitido ('${contentType || 'desconocido'}'). Se acepta PDF o imagen (jpeg, png).`,
        });
        return;
      }

      const client = await query<{ id: string }>('SELECT id FROM clients WHERE id = $1', [clientId]);
      if (!client.rows.length) {
        res.status(404).json({ error: 'Cliente no encontrado.' });
        return;
      }

      // Hash-and-store BEFORE the row exists (rule R-A), same order as campo.ts's evidencia upload.
      const file = await saveFile({
        kind: 'convenio',
        originalName: req.file.originalname,
        bytes: req.file.buffer,
        uploadedBy: req.user!.userId,
      });

      const ins = await query<{
        id: string;
        clientId: string;
        fileId: string;
        estadoFirma: string;
        createdAt: Date;
      }>(
        `INSERT INTO convenios (client_id, file_id, vigencia_desde, vigencia_hasta, created_by)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING id, client_id AS "clientId", file_id AS "fileId", estado_firma AS "estadoFirma",
                   created_at AS "createdAt"`,
        [clientId, file.id, vigenciaDesde ?? null, vigenciaHasta ?? null, req.user!.userId],
      );
      const convenio = ins.rows[0];

      await recordAudit({
        userId: req.user!.userId,
        action: 'CONVENIO_CARGADO',
        entity: 'convenio',
        entityId: convenio.id,
        after: {
          clientId,
          fileId: file.id,
          originalName: req.file.originalname,
          contentHash: file.contentHash,
          vigenciaDesde: vigenciaDesde ?? null,
          vigenciaHasta: vigenciaHasta ?? null,
        },
        ip: req.ip,
      });

      res.status(201).json(convenio);
    } catch (err) {
      next(err);
    }
  },
);

// -------------------------------------------------------------------------------------------------
// List / detail
// -------------------------------------------------------------------------------------------------

conveniosRouter.get(
  '/',
  requireAuth,
  requireRole(...rolesConsulta),
  validate({ query: convenioListQuery }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { clientId } = req.query as unknown as ConvenioListQuery;
      const { rows } = await query(
        `SELECT co.id, co.client_id AS "clientId", cl.name AS "clientNombre",
                co.file_id AS "fileId", co.vigencia_desde AS "vigenciaDesde",
                co.vigencia_hasta AS "vigenciaHasta", co.estado_firma AS "estadoFirma",
                co.solicitud_firma_estado AS "solicitudFirmaEstado",
                co.solicitud_firma_detalle AS "solicitudFirmaDetalle", co.solicitado_at AS "solicitadoAt",
                co.firmado_at AS "firmadoAt", co.firma_evidencia_file_id AS "firmaEvidenciaFileId",
                co.created_at AS "createdAt"
           FROM convenios co
           JOIN clients cl ON cl.id = co.client_id
          WHERE ($1::uuid IS NULL OR co.client_id = $1)
          ORDER BY co.created_at DESC`,
        [clientId ?? null],
      );
      res.json(rows);
    } catch (err) {
      next(err);
    }
  },
);

conveniosRouter.get(
  '/:id',
  requireAuth,
  requireRole(...rolesConsulta),
  validate({ params: convenioIdParam }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { rows } = await query(
        `SELECT co.id, co.client_id AS "clientId", cl.name AS "clientNombre", cl.email AS "clientEmail",
                co.file_id AS "fileId", co.vigencia_desde AS "vigenciaDesde",
                co.vigencia_hasta AS "vigenciaHasta", co.estado_firma AS "estadoFirma",
                co.cincel_solicitud_id AS "cincelSolicitudId", co.firma_url AS "firmaUrl",
                co.solicitud_firma_estado AS "solicitudFirmaEstado",
                co.solicitud_firma_detalle AS "solicitudFirmaDetalle",
                co.solicitud_firma_intentos AS "solicitudFirmaIntentos", co.solicitado_at AS "solicitadoAt",
                co.firmado_at AS "firmadoAt", co.firma_referencia AS "firmaReferencia",
                co.firma_evidencia_file_id AS "firmaEvidenciaFileId", co.created_at AS "createdAt"
           FROM convenios co
           JOIN clients cl ON cl.id = co.client_id
          WHERE co.id = $1`,
        [req.params.id],
      );
      if (!rows.length) {
        res.status(404).json({ error: 'Convenio no encontrado.' });
        return;
      }
      res.json(rows[0]);
    } catch (err) {
      next(err);
    }
  },
);

// -------------------------------------------------------------------------------------------------
// Signature dispatch
// -------------------------------------------------------------------------------------------------

interface ConvenioParaFirma {
  id: string;
  file_id: string | null;
  estado_firma: string;
  solicitud_firma_intentos: number;
  client_nombre: string;
  client_email: string | null;
}

conveniosRouter.post(
  '/:id/firmar',
  requireAuth,
  requireRole('admin'),
  validate({ params: convenioIdParam, body: convenioFirmarBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const { signerNombre, signerEmail } = req.body as ConvenioFirmarBody;

      const { rows } = await query<ConvenioParaFirma>(
        `SELECT co.id, co.file_id, co.estado_firma, co.solicitud_firma_intentos,
                cl.name AS client_nombre, cl.email AS client_email
           FROM convenios co
           JOIN clients cl ON cl.id = co.client_id
          WHERE co.id = $1`,
        [id],
      );
      if (!rows.length) {
        res.status(404).json({ error: 'Convenio no encontrado.' });
        return;
      }
      const convenio = rows[0];

      if (convenio.estado_firma === 'firmada') {
        res.status(409).json({ error: 'El convenio ya está firmado; no se puede volver a solicitar.' });
        return;
      }
      if (!convenio.file_id) {
        res.status(400).json({ error: 'El convenio no tiene un documento cargado.' });
        return;
      }
      const archivo = await readFileById(convenio.file_id);
      if (!archivo) {
        // Known limitation (#39): stored blobs can be lost across a redeploy. Honest 410, not a 500.
        res.status(410).json({ error: 'El documento del convenio ya no está disponible en el almacenamiento.' });
        return;
      }

      const nombre = (signerNombre ?? convenio.client_nombre ?? '').trim() || convenio.client_nombre;
      const email = (signerEmail ?? convenio.client_email ?? '').trim();

      const outcome: CincelOutcome = await solicitarFirma({
        convenioId: convenio.id,
        fileBytes: archivo.bytes,
        fileName: archivo.originalName,
        signerName: nombre,
        signerEmail: email,
      });

      const detalle =
        outcome.status === 'enviado'
          ? `enviado (cincel id ${outcome.solicitudId})`
          : outcome.status === 'omitido'
            ? `omitido: ${outcome.motivo}`
            : `error: ${outcome.error}`;

      let estadoFirma = convenio.estado_firma;
      if (outcome.status === 'enviado') {
        estadoFirma = 'solicitada';
        await query(
          `UPDATE convenios
              SET estado_firma = 'solicitada',
                  cincel_solicitud_id = $2,
                  firma_url = $3,
                  solicitud_firma_estado = 'enviada',
                  solicitud_firma_detalle = $4,
                  solicitud_firma_intentos = solicitud_firma_intentos + 1,
                  solicitado_at = COALESCE(solicitado_at, now())
            WHERE id = $1`,
          [id, outcome.solicitudId, outcome.firmaUrl, detalle],
        );
      } else {
        await query(
          `UPDATE convenios
              SET solicitud_firma_estado = $2,
                  solicitud_firma_detalle = $3,
                  solicitud_firma_intentos = solicitud_firma_intentos + 1
            WHERE id = $1`,
          [id, outcome.status === 'omitido' ? 'omitida' : 'error', detalle],
        );
        console.warn(
          `[convenios] la solicitud de firma del convenio ${id} NO fue enviada a CINCEL — ${detalle}.`,
        );
      }

      await recordAudit({
        userId: req.user!.userId,
        action: 'FIRMA_SOLICITADA',
        entity: 'convenio',
        entityId: id,
        after: { estado: outcome.status, detalle, signerEmail: email || null },
        ip: req.ip,
      });

      res.json({ ok: true, estadoFirma, cincel: outcome });
    } catch (err) {
      next(err);
    }
  },
);

// -------------------------------------------------------------------------------------------------
// Cincel signature-completion webhook — HMAC-verified, no JWT (same posture as prealertas.ts)
// -------------------------------------------------------------------------------------------------

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

export interface SignatureVerdict {
  ok: boolean;
  reason?: string;
}

/**
 * `X-Cincel-Signature: t=<unix seconds>,v1=<hex hmac_sha256(secret, "<t>.<raw body>")>` — identical
 * scheme to `routes/prealertas.ts`'s `verifyAgoraSignature`, duplicated rather than shared because the
 * two webhooks answer to different secrets/env vars and neither file should import the other's
 * internals for what is, on purpose, a small pure function.
 */
export function verifyCincelSignature(
  header: string | undefined,
  rawBody: Buffer | undefined,
  secret: string,
  toleranceSec: number,
  nowMs: number = Date.now(),
): SignatureVerdict {
  if (!header) return { ok: false, reason: 'firma_ausente' };
  if (!rawBody) return { ok: false, reason: 'cuerpo_crudo_ausente' };

  const parts = new Map<string, string>();
  for (const kv of header.split(',')) {
    const idx = kv.indexOf('=');
    if (idx > 0) parts.set(kv.slice(0, idx).trim(), kv.slice(idx + 1).trim());
  }
  const t = Number(parts.get('t'));
  const v1 = parts.get('v1');
  if (!Number.isFinite(t) || !v1) return { ok: false, reason: 'firma_malformada' };

  if (Math.abs(nowMs / 1000 - t) > toleranceSec) return { ok: false, reason: 'firma_expirada' };

  const expected = createHmac('sha256', secret).update(`${t}.${rawBody.toString('utf8')}`).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(v1, 'hex');
  } catch {
    return { ok: false, reason: 'firma_malformada' };
  }
  if (provided.length !== expected.length) return { ok: false, reason: 'firma_invalida' };
  if (!timingSafeEqual(provided, expected)) return { ok: false, reason: 'firma_invalida' };
  return { ok: true };
}

/** Event types this webhook actually acts on. Anything else is acknowledged and ignored. */
const EVENTOS_COMPLETADO = new Set(['document.completed', 'document.signed']);

interface CincelWebhookPayload {
  event?: string;
  document?: { id?: string; status?: string };
  evidence?: { filename?: string; contentBase64?: string };
}

conveniosRouter.post(
  '/cincel/webhook',
  async (req: RawBodyRequest, res: Response, next: NextFunction) => {
    try {
      const secret = process.env.CINCEL_WEBHOOK_SECRET;
      if (!secret) {
        // Fail closed, same rationale as prealertas.ts: unconfigured must never mean "accept anything".
        console.error('[convenios] CINCEL_WEBHOOK_SECRET no está configurado');
        res.status(503).json({ error: 'Webhook no configurado' });
        return;
      }
      const tolerance = Number(process.env.CINCEL_SIGNATURE_TOLERANCE_SEC ?? 300);
      const verdict = verifyCincelSignature(
        req.header('x-cincel-signature'),
        req.rawBody,
        secret,
        tolerance,
      );
      if (!verdict.ok) {
        console.warn(`[convenios] firma de webhook CINCEL rechazada: ${verdict.reason}`);
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const body = req.body as CincelWebhookPayload;
      const documentId = body?.document?.id;
      if (!documentId) {
        res.status(400).json({ error: 'document.id es requerido' });
        return;
      }

      // A redelivery or an event we do not act on is a SUCCESS from Cincel's point of view — a 4xx
      // would make it retry forever on something we have deliberately decided not to handle.
      if (!body.event || !EVENTOS_COMPLETADO.has(body.event)) {
        res.status(202).json({ ok: true, ignorado: true, motivo: 'evento_no_manejado' });
        return;
      }

      const { rows } = await query<{ id: string; estado_firma: string }>(
        'SELECT id, estado_firma FROM convenios WHERE cincel_solicitud_id = $1',
        [documentId],
      );
      if (!rows.length) {
        console.warn(`[convenios] webhook CINCEL para un document.id desconocido: ${documentId}`);
        res.status(202).json({ ok: true, ignorado: true, motivo: 'convenio_no_encontrado' });
        return;
      }
      const convenio = rows[0];

      // Idempotent: operacion_eventos-style "same fact twice is a noop", not a duplicate write.
      if (convenio.estado_firma === 'firmada') {
        res.status(202).json({ ok: true, noop: true });
        return;
      }

      const contentBase64 = body.evidence?.contentBase64;
      if (!contentBase64) {
        res.status(400).json({ error: 'evidence.contentBase64 es requerido' });
        return;
      }
      const bytes = Buffer.from(contentBase64, 'base64');

      // Evidence before the fact it backs (rule R-A): hash-and-store BEFORE the row says `firmada`.
      const file = await saveFile({
        kind: 'convenio',
        originalName: body.evidence?.filename || `constancia-${convenio.id}.pdf`,
        bytes,
        uploadedBy: null,
      });

      await query(
        `UPDATE convenios
            SET estado_firma = 'firmada',
                firmado_at = now(),
                firma_referencia = $2,
                firma_evidencia_file_id = $3
          WHERE id = $1`,
        [convenio.id, documentId, file.id],
      );

      await recordAudit({
        userId: null,
        action: 'FIRMA_COMPLETADA',
        entity: 'convenio',
        entityId: convenio.id,
        after: { fileId: file.id, contentHash: file.contentHash, cincelDocumentId: documentId },
      });

      res.json({ ok: true, convenioId: convenio.id, evidenciaFileId: file.id });
    } catch (err) {
      next(err);
    }
  },
);
