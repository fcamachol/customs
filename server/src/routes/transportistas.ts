import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { query } from '../db/pool';
import { withTransaction } from '../db/tx';
import { isUniqueViolation } from '../db/errors';
import { requireAuth, requireRole } from '../auth/middleware';
import { recordAudit } from '../services/audit';
import { saveFile } from '../storage/files';
import { encryptField, decryptField } from '../crypto/fieldCrypto';
import { validate } from '../validation/middleware';
import {
  convenioBody,
  convenioFirmaBody,
  convenioRenovarBody,
  convenioUpdateBody,
  tarifaBody,
  tarifaUpdateBody,
  transportistaBody,
  transportistaConvenioParam,
  transportistaParam,
  transportistaPaquetesQuery,
  transportistaTarifaParam,
  transportistaUnidadParam,
  transportistaUpdateBody,
  unidadBody,
  unidadUpdateBody,
  type ConvenioBody,
  type ConvenioFirmaBody,
  type ConvenioRenovarBody,
  type ConvenioUpdateBody,
  type TarifaBody,
  type TarifaUpdateBody,
  type TransportistaBody,
  type TransportistaPaquetesQuery,
  type TransportistaUpdateBody,
  type UnidadBody,
  type UnidadUpdateBody,
} from '../validation/schemas';
import { TIPOS_UNIDAD, etiquetaTipoUnidad } from '../../../shared/operaciones/catalogos';

/**
 * Transport catalogs — carriers, their fleet, their agreements and the rates inside them
 * (PRD-02 R24, R25/D9).
 *
 * WHY THIS IS AN ADMIN-ONLY ROUTER, ALMOST ENTIRELY. Every write here decides who the operation may
 * spend money with and at what price. A capturista's job is cargo, not counterparties; the tramitador
 * never sees this at all. The single exception is reading: planning and the control tower both need
 * to display which carrier a trip went out with, so `GET` is open to any authenticated role.
 *
 * THE ORDER THE DATA IS SHAPED IN IS DECISION D7. Rates hang off the convenio and carry
 * `tipo_unidad`, so there is no way to ask what a carrier charges without having first said which
 * unit type — which is what makes `GET /api/despachos/opciones` able to refuse the question rather
 * than merely discourage it. See the migration header for the structural argument.
 *
 * A CONVENIO IS THE ONLY PLACE A RATE MAY LIVE (R25/D9). Fernando's commitment was digitally signed,
 * paperless agreements. There is no PSC integration yet, so `POST /:id/convenios/:cid/firmar`
 * records the provider, its reference and an evidence file — and NOTHING here lets a caller declare
 * a convenio `firmado` any other way. An unsigned agreement stays `borrador`/`enviado` and its rates
 * are visible but never resolved onto a despacho, because "we have a price" and "we have an agreement
 * that says that price" are different claims and only the second one is defensible.
 *
 * CONTACT DETAILS ARE ENCRYPTED AT REST via fieldCrypto (PRD-02 §8.5): a driver's or dispatcher's
 * phone number is personal data of someone who never contracted with us. `decryptField` passes
 * through anything without the `v1:` envelope, so hand-seeded rows still read.
 */
export const transportistasRouter = Router();

type Q = (text: string, params?: unknown[]) => Promise<any>;

/** Encrypt on the way in; '' and absent both mean "no value", never the ciphertext of an empty string. */
function cifrar(v: string | null | undefined): string | null {
  const s = (v ?? '').trim();
  return s ? encryptField(s) : null;
}

function descifrar(v: string | null | undefined): string | null {
  return v ? decryptField(v) : null;
}

/**
 * Today, as YYYY-MM-DD, for comparing against DATE columns.
 *
 * Deliberately computed in SQL (`current_date`) wherever the comparison drives a decision; this
 * helper exists only for the response payloads. Two clocks would eventually disagree about which day
 * a convenio expired, and the database's is the one the constraints see.
 */
const SELECT_TRANSPORTISTA = `
  t.id,
  t.razon_social      AS "razonSocial",
  t.rfc,
  t.contacto_nombre   AS "contactoNombre",
  t.contacto_telefono AS "contactoTelefono",
  t.contacto_email    AS "contactoEmail",
  t.estado,
  t.documentos_ok     AS "documentosOk",
  t.created_at        AS "createdAt",
  t.updated_at        AS "updatedAt"`;

interface FilaTransportista {
  id: string;
  razonSocial: string;
  rfc: string | null;
  contactoNombre: string | null;
  contactoTelefono: string | null;
  contactoEmail: string | null;
  estado: string;
  documentosOk: boolean;
  createdAt: Date;
  updatedAt: Date;
}

function desencriptarFila(t: FilaTransportista): FilaTransportista {
  return {
    ...t,
    contactoTelefono: descifrar(t.contactoTelefono),
    contactoEmail: descifrar(t.contactoEmail),
  };
}

// =================================================================================================
// Static catalog — registered BEFORE `/:id` so the literal 'tipos-unidad' is never read as a uuid.
// =================================================================================================

/**
 * GET /api/transportistas/tipos-unidad — the R23/D8 glossary.
 *
 * Open to every authenticated role and served from the shared catalog rather than from a table.
 * These six values are a decision, not data: they appear in three CHECK constraints, and a row
 * somebody could add would immediately be rejected by the database the first time it was used.
 */
transportistasRouter.get('/tipos-unidad', requireAuth, (_req: Request, res: Response) => {
  res.json(TIPOS_UNIDAD);
});

// =================================================================================================
// Transportistas
// =================================================================================================

/**
 * GET /api/transportistas — the carrier list with a live readiness summary.
 *
 * `unidadesActivas` and `convenioVigente` are computed rather than stored because both are questions
 * about TODAY: a convenio with `vigencia_hasta` in the past is not an agreement, and a fleet whose
 * units were all deactivated is not a carrier you can call. Storing either as a flag would answer
 * with whatever was true when somebody last edited the row.
 */
transportistasRouter.get('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { rows } = await query<FilaTransportista & { unidadesActivas: number; convenioVigente: boolean }>(
      `SELECT ${SELECT_TRANSPORTISTA},
              (SELECT count(*) FROM transportista_unidades u
                WHERE u.transportista_id = t.id AND u.activo)::int AS "unidadesActivas",
              EXISTS (SELECT 1 FROM transportista_convenios c
                       WHERE c.transportista_id = t.id
                         AND c.estado_firma = 'firmado'
                         AND (c.vigencia_desde IS NULL OR c.vigencia_desde <= current_date)
                         AND (c.vigencia_hasta IS NULL OR c.vigencia_hasta >= current_date)) AS "convenioVigente"
         FROM transportistas t
        ORDER BY t.razon_social`,
    );
    res.json(rows.map((r) => ({ ...desencriptarFila(r), unidadesActivas: r.unidadesActivas, convenioVigente: r.convenioVigente })));
  } catch (err) {
    next(err);
  }
});

/** GET /api/transportistas/:id — the carrier with its fleet, its agreements and their rates. */
transportistasRouter.get(
  '/:id',
  requireAuth,
  validate({ params: transportistaParam }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const t = await query<FilaTransportista>(
        `SELECT ${SELECT_TRANSPORTISTA} FROM transportistas t WHERE t.id = $1`,
        [id],
      );
      if (!t.rows.length) {
        res.status(404).json({ error: 'Transportista no encontrado' });
        return;
      }

      const unidades = await query(
        `SELECT id,
                placas,
                tipo_unidad           AS "tipoUnidad",
                numero_economico      AS "numeroEconomico",
                vigencia_seguro       AS "vigenciaSeguro",
                vigencia_verificacion AS "vigenciaVerificacion",
                activo,
                -- Asked of the database, not of a stored flag: "is the paperwork current TODAY?"
                (vigencia_seguro IS NOT NULL AND vigencia_seguro < current_date) AS "seguroVencido",
                (vigencia_verificacion IS NOT NULL AND vigencia_verificacion < current_date) AS "verificacionVencida"
           FROM transportista_unidades
          WHERE transportista_id = $1
          ORDER BY activo DESC, tipo_unidad, placas`,
        [id],
      );

      /**
       * The rates come back WITH THEIR DESTINATION'S LABEL, not only its uuid.
       *
       * `direccion_entrega_id` is a pointer into another client's catalog, so a caller holding a
       * carrier had no way to name it: the screen either printed a uuid or asked every client for its
       * address list and searched the union — one request per client, on every open, to resolve one
       * string. The join is two LEFT JOINs here and none anywhere else, and it makes the response
       * self-describing: `destinoAlias` + `clienteNombre` say what the price is for.
       *
       * `renovadoPorConvenioId` is the successor side of the renewal chain (the predecessor side is
       * the stored column). It is what lets a signed, expired convenio show "already renewed" instead
       * of inviting somebody to edit its vigencia — which is exactly what must never happen.
       */
      const convenios = await query(
        `SELECT c.id,
                c.file_id                 AS "fileId",
                c.vigencia_desde          AS "vigenciaDesde",
                c.vigencia_hasta          AS "vigenciaHasta",
                c.estado_firma            AS "estadoFirma",
                c.firmado_at              AS "firmadoAt",
                c.firma_proveedor         AS "firmaProveedor",
                c.firma_referencia        AS "firmaReferencia",
                c.firma_evidencia_file_id AS "firmaEvidenciaFileId",
                c.notas,
                c.renovado_de_convenio_id AS "renovadoDeConvenioId",
                (SELECT s.id FROM transportista_convenios s
                  WHERE s.renovado_de_convenio_id = c.id
                  ORDER BY s.created_at LIMIT 1) AS "renovadoPorConvenioId",
                c.created_at              AS "createdAt",
                (c.estado_firma = 'firmado'
                  AND (c.vigencia_desde IS NULL OR c.vigencia_desde <= current_date)
                  AND (c.vigencia_hasta IS NULL OR c.vigencia_hasta >= current_date)) AS "vigente",
                COALESCE(
                  json_agg(
                    json_build_object(
                      'id', tf.id,
                      'tipoUnidad', tf.tipo_unidad,
                      'direccionEntregaId', tf.direccion_entrega_id,
                      'destinoAlias', cd.alias,
                      'clienteNombre', cl.name,
                      'tarifa', tf.tarifa,
                      'moneda', tf.moneda,
                      'vigenciaDesde', tf.vigencia_desde,
                      'vigenciaHasta', tf.vigencia_hasta,
                      'activo', tf.activo
                    ) ORDER BY tf.activo DESC, tf.tipo_unidad, tf.created_at
                  ) FILTER (WHERE tf.id IS NOT NULL),
                  '[]'
                ) AS tarifas
           FROM transportista_convenios c
           LEFT JOIN transportista_tarifas tf ON tf.convenio_id = c.id
           LEFT JOIN client_direcciones cd ON cd.id = tf.direccion_entrega_id
           LEFT JOIN clients cl ON cl.id = cd.client_id
          WHERE c.transportista_id = $1
          GROUP BY c.id
          ORDER BY c.created_at DESC`,
        [id],
      );

      res.json({
        ...desencriptarFila(t.rows[0]),
        unidades: unidades.rows,
        convenios: convenios.rows,
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /api/transportistas/:id/paquetes — TRAZABILIDAD, the carrier→cargo direction.
 *
 * THE QUESTION IT ANSWERS is the one the meeting kept coming back to and the spreadsheet could never
 * answer without a phone call: "what did we send with this line, and on which trip did each guía
 * travel?" Until now the only path was `GET /api/despachos?transportistaId=…` — which returns a
 * COUNT of partidas per trip — and then one `GET /api/despachos/:id` per row. That N+1 is why the
 * question was asked of a person instead of the system.
 *
 * ONE ROW PER PARTIDA, not per trip. The unit of the answer is a package: a guía that rode on a
 * plate on a day. A trip-shaped answer would force the reader back into the same expansion, and the
 * multi-client truck (R29 — N guías, N clientes, one address) would be a single line hiding three
 * clients.
 *
 * ONE AGGREGATE QUERY, and the totals are folded over the rows it already returned rather than asked
 * for a second time: a second SUM query against the same filter is a second answer able to disagree
 * with the first. `despachos` counts DISTINCT trips, so a truck carrying four guías is one trip and
 * four packages, which is exactly how it is invoiced and exactly how it is explained.
 *
 * Cancelled trips are INCLUDED unless filtered out. A trip that was contracted and then cancelled is
 * part of the carrier's history — it is where the *flete en falso* argument (CT-7/D10) lives — and
 * dropping it would make the record flatter than the money.
 */
transportistasRouter.get(
  '/:id/paquetes',
  requireAuth,
  validate({ params: transportistaParam, query: transportistaPaquetesQuery }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const { desde, hasta, estado } = req.query as unknown as TransportistaPaquetesQuery;

      const t = await query<{ razonSocial: string }>(
        `SELECT razon_social AS "razonSocial" FROM transportistas WHERE id = $1`,
        [id],
      );
      if (!t.rows.length) {
        res.status(404).json({ error: 'Transportista no encontrado' });
        return;
      }

      const { rows } = await query<{
        despachoId: string;
        piezas: number | null;
        cartonesPlaneados: number | null;
        cartonesCargados: number | null;
        tipoUnidad: string;
      }>(
        `SELECT p.id                 AS "partidaId",
                d.id                 AS "despachoId",
                d.folio,
                d.fecha_operacion    AS "fechaOperacion",
                d.estado,
                d.tipo_unidad        AS "tipoUnidad",
                d.placas,
                d.operador_nombre    AS "operadorNombre",
                d.unidad_id          AS "unidadId",
                cd.alias             AS "destino",
                d.cita_at            AS "citaAt",
                d.salida_at          AS "salidaAt",
                d.eta_calculado      AS "etaCalculado",
                d.arribo_real        AS "arriboReal",
                p.operacion_id       AS "operacionId",
                o.mawb,
                p.operacion_guia_id  AS "operacionGuiaId",
                g.guia_norm          AS "guia",
                g.estado             AS "guiaEstado",
                c.name               AS "cliente",
                p.pedimento_id       AS "pedimentoId",
                p.piezas,
                p.cartones_planeados AS "cartonesPlaneados",
                p.cartones_cargados  AS "cartonesCargados",
                p.orden_carga        AS "ordenCarga"
           FROM despachos d
           JOIN despacho_partidas p ON p.despacho_id = d.id
           JOIN operaciones o ON o.id = p.operacion_id
           LEFT JOIN operacion_guias g ON g.id = p.operacion_guia_id
           LEFT JOIN clients c ON c.id = COALESCE(g.client_id, o.client_id)
           LEFT JOIN client_direcciones cd ON cd.id = d.direccion_entrega_id
          WHERE d.transportista_id = $1
            AND ($2::date IS NULL OR d.fecha_operacion >= $2::date)
            AND ($3::date IS NULL OR d.fecha_operacion <= $3::date)
            AND ($4::text IS NULL OR d.estado = $4)
          ORDER BY d.fecha_operacion DESC, d.folio, p.orden_carga NULLS LAST, p.created_at
          LIMIT 2000`,
        [id, desde ?? null, hasta ?? null, estado ?? null],
      );

      const despachos = new Set(rows.map((r) => r.despachoId));
      const suma = (f: (r: (typeof rows)[number]) => number | null): number =>
        rows.reduce((acc, r) => acc + (Number(f(r)) || 0), 0);

      res.json({
        transportistaId: id,
        transportista: t.rows[0].razonSocial,
        filtros: { desde: desde ?? null, hasta: hasta ?? null, estado: estado ?? null },
        totales: {
          despachos: despachos.size,
          paquetes: rows.length,
          piezas: suma((r) => r.piezas),
          cartonesPlaneados: suma((r) => r.cartonesPlaneados),
          cartonesCargados: suma((r) => r.cartonesCargados),
        },
        paquetes: rows.map((r) => ({ ...r, tipoUnidadLabel: etiquetaTipoUnidad(r.tipoUnidad) })),
      });
    } catch (err) {
      next(err);
    }
  },
);

transportistasRouter.post(
  '/',
  requireAuth,
  requireRole('admin'),
  validate({ body: transportistaBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const b = req.body as TransportistaBody;
      const { rows } = await query<FilaTransportista>(
        `INSERT INTO transportistas
           (razon_social, rfc, contacto_nombre, contacto_telefono, contacto_email,
            estado, documentos_ok, created_by)
         VALUES ($1,$2,$3,$4,$5,COALESCE($6,'activo'),COALESCE($7,false),$8)
         RETURNING id, razon_social AS "razonSocial", rfc,
                   contacto_nombre AS "contactoNombre", contacto_telefono AS "contactoTelefono",
                   contacto_email AS "contactoEmail", estado, documentos_ok AS "documentosOk",
                   created_at AS "createdAt", updated_at AS "updatedAt"`,
        [
          b.razonSocial,
          b.rfc ?? null,
          b.contactoNombre ?? null,
          cifrar(b.contactoTelefono),
          cifrar(b.contactoEmail),
          b.estado ?? null,
          b.documentosOk ?? null,
          req.user!.userId,
        ],
      );
      const creado = desencriptarFila(rows[0]);

      await recordAudit({
        userId: req.user!.userId,
        action: 'TRANSPORTISTA_CREADO',
        entity: 'transportista',
        entityId: creado.id,
        // The contact details are NOT echoed into the audit row: it is a permanent, hash-chained
        // record, and copying personal data into it would defeat encrypting it in the first place.
        after: { razonSocial: creado.razonSocial, rfc: creado.rfc, estado: creado.estado },
        ip: req.ip,
      });

      res.status(201).json(creado);
    } catch (err) {
      if (isUniqueViolation(err)) {
        res.status(409).json({
          error: 'Ya existe un transportista con ese RFC. Dos filas para la misma persona fiscal parten en dos el historial de un mismo transportista.',
        });
        return;
      }
      next(err);
    }
  },
);

transportistasRouter.put(
  '/:id',
  requireAuth,
  requireRole('admin'),
  validate({ params: transportistaParam, body: transportistaUpdateBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const b = req.body as TransportistaUpdateBody;

      const sets: string[] = [];
      const params: unknown[] = [id];
      const set = (col: string, val: unknown): void => {
        params.push(val);
        sets.push(`${col} = $${params.length}`);
      };
      if (b.razonSocial !== undefined) set('razon_social', b.razonSocial);
      if (b.rfc !== undefined) set('rfc', b.rfc);
      if (b.contactoNombre !== undefined) set('contacto_nombre', b.contactoNombre);
      if (b.contactoTelefono !== undefined) set('contacto_telefono', cifrar(b.contactoTelefono));
      if (b.contactoEmail !== undefined) set('contacto_email', cifrar(b.contactoEmail));
      if (b.estado !== undefined) set('estado', b.estado);
      if (b.documentosOk !== undefined) set('documentos_ok', b.documentosOk);
      if (!sets.length) {
        res.status(400).json({ error: 'No hay nada que actualizar.' });
        return;
      }
      sets.push('updated_at = now()');

      const { rows } = await query<FilaTransportista>(
        `UPDATE transportistas SET ${sets.join(', ')} WHERE id = $1
         RETURNING id, razon_social AS "razonSocial", rfc,
                   contacto_nombre AS "contactoNombre", contacto_telefono AS "contactoTelefono",
                   contacto_email AS "contactoEmail", estado, documentos_ok AS "documentosOk",
                   created_at AS "createdAt", updated_at AS "updatedAt"`,
        params,
      );
      if (!rows.length) {
        res.status(404).json({ error: 'Transportista no encontrado' });
        return;
      }
      const actualizado = desencriptarFila(rows[0]);

      await recordAudit({
        userId: req.user!.userId,
        action: 'TRANSPORTISTA_ACTUALIZADO',
        entity: 'transportista',
        entityId: id,
        after: { razonSocial: actualizado.razonSocial, rfc: actualizado.rfc, estado: actualizado.estado, documentosOk: actualizado.documentosOk },
        ip: req.ip,
      });

      res.json(actualizado);
    } catch (err) {
      if (isUniqueViolation(err)) {
        res.status(409).json({ error: 'Ya existe un transportista con ese RFC.' });
        return;
      }
      next(err);
    }
  },
);

// =================================================================================================
// Unidades — the fleet
// =================================================================================================

/**
 * POST /api/transportistas/:id/unidades.
 *
 * The unit's `tipo_unidad` is what makes the D7 question answerable: the options endpoint asks
 * "which carriers have an ACTIVE unit of this type AND a rate for it", and a fleet with no typed
 * units means a carrier that cannot be offered for anything.
 */
transportistasRouter.post(
  '/:id/unidades',
  requireAuth,
  requireRole('admin'),
  validate({ params: transportistaParam, body: unidadBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const b = req.body as UnidadBody;

      const t = await query('SELECT id FROM transportistas WHERE id = $1', [id]);
      if (!t.rows.length) {
        res.status(404).json({ error: 'Transportista no encontrado' });
        return;
      }

      const { rows } = await query(
        `INSERT INTO transportista_unidades
           (transportista_id, placas, tipo_unidad, numero_economico,
            vigencia_seguro, vigencia_verificacion, activo)
         VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,true))
         RETURNING id, placas, tipo_unidad AS "tipoUnidad", numero_economico AS "numeroEconomico",
                   vigencia_seguro AS "vigenciaSeguro", vigencia_verificacion AS "vigenciaVerificacion",
                   activo`,
        [
          id,
          b.placas,
          b.tipoUnidad,
          b.numeroEconomico ?? null,
          b.vigenciaSeguro ?? null,
          b.vigenciaVerificacion ?? null,
          b.activo ?? null,
        ],
      );

      await recordAudit({
        userId: req.user!.userId,
        action: 'UNIDAD_REGISTRADA',
        entity: 'transportista_unidad',
        entityId: rows[0].id,
        after: { transportistaId: id, ...rows[0] },
        ip: req.ip,
      });

      res.status(201).json(rows[0]);
    } catch (err) {
      if (isUniqueViolation(err)) {
        res.status(409).json({ error: 'Ese transportista ya tiene registradas esas placas.' });
        return;
      }
      next(err);
    }
  },
);

transportistasRouter.put(
  '/:id/unidades/:uid',
  requireAuth,
  requireRole('admin'),
  validate({ params: transportistaUnidadParam, body: unidadUpdateBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id, uid } = req.params;
      const b = req.body as UnidadUpdateBody;

      const sets: string[] = [];
      const params: unknown[] = [uid, id];
      const set = (col: string, val: unknown): void => {
        params.push(val);
        sets.push(`${col} = $${params.length}`);
      };
      if (b.placas !== undefined) set('placas', b.placas);
      if (b.tipoUnidad !== undefined) set('tipo_unidad', b.tipoUnidad);
      if (b.numeroEconomico !== undefined) set('numero_economico', b.numeroEconomico);
      if (b.vigenciaSeguro !== undefined) set('vigencia_seguro', b.vigenciaSeguro);
      if (b.vigenciaVerificacion !== undefined) set('vigencia_verificacion', b.vigenciaVerificacion);
      if (b.activo !== undefined) set('activo', b.activo);
      if (!sets.length) {
        res.status(400).json({ error: 'No hay nada que actualizar.' });
        return;
      }

      const { rows } = await query(
        `UPDATE transportista_unidades SET ${sets.join(', ')}
          WHERE id = $1 AND transportista_id = $2
          RETURNING id, placas, tipo_unidad AS "tipoUnidad", numero_economico AS "numeroEconomico",
                    vigencia_seguro AS "vigenciaSeguro", vigencia_verificacion AS "vigenciaVerificacion",
                    activo`,
        params,
      );
      if (!rows.length) {
        res.status(404).json({ error: 'Unidad no encontrada para este transportista' });
        return;
      }

      await recordAudit({
        userId: req.user!.userId,
        action: 'UNIDAD_ACTUALIZADA',
        entity: 'transportista_unidad',
        entityId: uid,
        after: { transportistaId: id, ...rows[0] },
        ip: req.ip,
      });

      res.json(rows[0]);
    } catch (err) {
      if (isUniqueViolation(err)) {
        res.status(409).json({ error: 'Ese transportista ya tiene registradas esas placas.' });
        return;
      }
      next(err);
    }
  },
);

/**
 * DELETE /api/transportistas/:id/unidades/:uid — retire a unit.
 *
 * Deactivates, never deletes, and returns 200 either way. A unit that has carried cargo is named in
 * `despachos.unidad_id` and in published plans; removing the row would make old trips point at
 * nothing, and the question "which vehicle carried this?" has to stay answerable after the vehicle
 * leaves the fleet. `activo = false` is exactly as effective for planning, since every lookup
 * filters on it.
 */
transportistasRouter.delete(
  '/:id/unidades/:uid',
  requireAuth,
  requireRole('admin'),
  validate({ params: transportistaUnidadParam }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id, uid } = req.params;
      const { rows } = await query(
        `UPDATE transportista_unidades SET activo = false
          WHERE id = $1 AND transportista_id = $2
          RETURNING id, placas, activo`,
        [uid, id],
      );
      if (!rows.length) {
        res.status(404).json({ error: 'Unidad no encontrada para este transportista' });
        return;
      }

      await recordAudit({
        userId: req.user!.userId,
        action: 'UNIDAD_DESACTIVADA',
        entity: 'transportista_unidad',
        entityId: uid,
        after: { transportistaId: id, ...rows[0] },
        ip: req.ip,
      });

      res.json({ ok: true, ...rows[0] });
    } catch (err) {
      next(err);
    }
  },
);

// =================================================================================================
// Convenios y tarifas — R25 / D9
// =================================================================================================

transportistasRouter.post(
  '/:id/convenios',
  requireAuth,
  requireRole('admin'),
  validate({ params: transportistaParam, body: convenioBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const b = req.body as ConvenioBody;

      const t = await query('SELECT id FROM transportistas WHERE id = $1', [id]);
      if (!t.rows.length) {
        res.status(404).json({ error: 'Transportista no encontrado' });
        return;
      }

      const { rows } = await query(
        `INSERT INTO transportista_convenios
           (transportista_id, file_id, vigencia_desde, vigencia_hasta, estado_firma, notas, created_by)
         VALUES ($1,$2,$3,$4,COALESCE($5,'borrador'),$6,$7)
         RETURNING id, file_id AS "fileId", vigencia_desde AS "vigenciaDesde",
                   vigencia_hasta AS "vigenciaHasta", estado_firma AS "estadoFirma",
                   firmado_at AS "firmadoAt", notas,
                   renovado_de_convenio_id AS "renovadoDeConvenioId", created_at AS "createdAt"`,
        [
          id,
          b.fileId ?? null,
          b.vigenciaDesde ?? null,
          b.vigenciaHasta ?? null,
          b.estadoFirma ?? null,
          b.notas ? b.notas : null,
          req.user!.userId,
        ],
      );

      await recordAudit({
        userId: req.user!.userId,
        action: 'CONVENIO_CREADO',
        entity: 'transportista_convenio',
        entityId: rows[0].id,
        after: { transportistaId: id, ...rows[0] },
        ip: req.ip,
      });

      res.status(201).json(rows[0]);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * PUT /api/transportistas/:id/convenios/:cid — edit the TERMS, and only before signature.
 *
 * THE RULE THIS ENDPOINT EXISTS TO STATE. A convenio in `borrador`/`enviado` is a draft: its dates
 * and its notes are somebody's working copy, and correcting a typo in them costs nothing. A convenio
 * in `firmado` is a DOCUMENT — the row is the claim that these terms were signed on that date — and
 * moving its `vigencia_hasta` afterwards would make the system assert something was signed that was
 * not. That is the same argument that makes a POD non-reprintable once it carries a signature: the
 * artifact stops being ours to edit the moment somebody else's name is on it.
 *
 * So the refusal is a 409 that names the alternative rather than a 403 that just says no: extending
 * a signed agreement means a SUCCESSOR (`POST .../renovar`), which carries the terms forward, gets
 * its own vigencia and its own signature, and leaves the signed one intact and readable.
 *
 * `vencido` is refused too, and for the same reason — it is a signed convenio whose window closed.
 */
transportistasRouter.put(
  '/:id/convenios/:cid',
  requireAuth,
  requireRole('admin'),
  validate({ params: transportistaConvenioParam, body: convenioUpdateBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id, cid } = req.params;
      const b = req.body as ConvenioUpdateBody;

      const sets: string[] = [];
      const params: unknown[] = [cid, id];
      const set = (col: string, val: unknown): void => {
        params.push(val);
        sets.push(`${col} = $${params.length}`);
      };
      if (b.vigenciaDesde !== undefined) set('vigencia_desde', b.vigenciaDesde);
      if (b.vigenciaHasta !== undefined) set('vigencia_hasta', b.vigenciaHasta);
      if (b.fileId !== undefined) set('file_id', b.fileId);
      // '' clears the note; `undefined` never reaches here, so "leave it alone" stays distinguishable.
      if (b.notas !== undefined) set('notas', b.notas ? b.notas : null);
      if (b.estadoFirma !== undefined) set('estado_firma', b.estadoFirma);
      if (!sets.length) {
        res.status(400).json({ error: 'No hay nada que actualizar.' });
        return;
      }

      const resultado = await withTransaction(async (q: Q) => {
        const c = await q(
          `SELECT id, estado_firma, vigencia_desde, vigencia_hasta, notas
             FROM transportista_convenios
            WHERE id = $1 AND transportista_id = $2 FOR UPDATE`,
          [cid, id],
        );
        if (!c.rows.length) return { kind: 'no_encontrado' as const };
        const estadoActual = String(c.rows[0].estado_firma);
        if (estadoActual === 'firmado' || estadoActual === 'vencido') {
          return { kind: 'firmado' as const, estado: estadoActual };
        }

        const upd = await q(
          `UPDATE transportista_convenios SET ${sets.join(', ')}
            WHERE id = $1 AND transportista_id = $2
            RETURNING id, file_id AS "fileId", vigencia_desde AS "vigenciaDesde",
                      vigencia_hasta AS "vigenciaHasta", estado_firma AS "estadoFirma",
                      firmado_at AS "firmadoAt", notas,
                      renovado_de_convenio_id AS "renovadoDeConvenioId", created_at AS "createdAt"`,
          params,
        );
        return { kind: 'ok' as const, antes: c.rows[0], convenio: upd.rows[0] };
      });

      if (resultado.kind === 'no_encontrado') {
        res.status(404).json({ error: 'Convenio no encontrado para este transportista' });
        return;
      }
      if (resultado.kind === 'firmado') {
        res.status(409).json({
          error:
            `El convenio está '${resultado.estado}': sus términos son lo que se firmó y no pueden editarse. ` +
            'Editar la vigencia de un convenio firmado haría que el sistema afirmara algo distinto de lo que se firmó. ' +
            'Para extenderlo, renuévalo (POST .../convenios/:cid/renovar): se crea un convenio sucesor con las mismas ' +
            'tarifas y una vigencia nueva, y el firmado queda intacto.',
          estadoFirma: resultado.estado,
        });
        return;
      }

      await recordAudit({
        userId: req.user!.userId,
        action: 'CONVENIO_ACTUALIZADO',
        entity: 'transportista_convenio',
        entityId: cid,
        before: {
          vigenciaDesde: resultado.antes.vigencia_desde,
          vigenciaHasta: resultado.antes.vigencia_hasta,
          estadoFirma: resultado.antes.estado_firma,
        },
        after: { transportistaId: id, ...resultado.convenio },
        ip: req.ip,
      });

      res.json(resultado.convenio);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /api/transportistas/:id/convenios/:cid/renovar — extend a signed agreement the only honest way.
 *
 * WHAT IT CREATES: a NEW convenio in `borrador`, pointing back at its predecessor through
 * `renovado_de_convenio_id`, carrying the predecessor's notes and (by default) its ACTIVE rates. The
 * predecessor is not touched: not its vigencia, not its `firmado_at`, not its rates. Two rows, two
 * documents, one chain — which is what actually happened, and what a signed record has to say.
 *
 * ONLY FROM A SIGNED (or expired-signed) CONVENIO. Renewing a draft would be theatre: a draft can
 * simply be edited (PUT above), and producing a second draft for the same lane would leave two
 * unsigned candidate agreements with nothing to distinguish them.
 *
 * THE SUCCESSOR STARTS UNSIGNED, and there is no way to make it otherwise here — `estado_firma`
 * follows the D9 path through `/firmar`, exactly like any other convenio. Until it is signed, its
 * rates are visible and never resolve, so a renewal cannot quietly reprice a trip.
 *
 * COPIED RATES LOSE THEIR OWN VIGENCIA WINDOW. A rate's window was scoped to the agreement it lived
 * in; carrying `2026-01-01 → 2026-12-31` into an agreement that runs through 2027 would produce a
 * price that can never resolve — dead on arrival and invisible about it. The successor's rates
 * inherit the successor's window, which is the same thing the predecessor's unwindowed rates did.
 * DEACTIVATED rates are NOT copied: a rate somebody switched off is a rate that was wrong, and a
 * renewal must not resurrect it.
 *
 * COMPATIBILITY WITH THE PLANNED CINCEL UNIFICATION (services/cincel.ts, lines ~30–91): renewal is
 * deliberately orthogonal to signing. It creates a row in `borrador` and stops; whichever signature
 * path that row later takes — today's "record an external signature", or the `/firmar/cincel`
 * sibling the design note reserves — is unchanged by how the row came into being. No signature state,
 * no dispatch-tracking column and no vocabulary is touched here.
 */
transportistasRouter.post(
  '/:id/convenios/:cid/renovar',
  requireAuth,
  requireRole('admin'),
  validate({ params: transportistaConvenioParam, body: convenioRenovarBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id, cid } = req.params;
      const b = req.body as ConvenioRenovarBody;

      const resultado = await withTransaction(async (q: Q) => {
        const c = await q(
          `SELECT id, estado_firma, vigencia_desde, vigencia_hasta, notas, file_id
             FROM transportista_convenios
            WHERE id = $1 AND transportista_id = $2 FOR UPDATE`,
          [cid, id],
        );
        if (!c.rows.length) return { kind: 'no_encontrado' as const };
        const origen = c.rows[0];
        const estadoActual = String(origen.estado_firma);
        if (estadoActual !== 'firmado' && estadoActual !== 'vencido') {
          return { kind: 'no_firmado' as const, estado: estadoActual };
        }

        const ins = await q(
          `INSERT INTO transportista_convenios
             (transportista_id, vigencia_desde, vigencia_hasta, estado_firma, notas,
              renovado_de_convenio_id, created_by)
           VALUES ($1,$2,$3,'borrador',$4,$5,$6)
           RETURNING id, file_id AS "fileId", vigencia_desde AS "vigenciaDesde",
                     vigencia_hasta AS "vigenciaHasta", estado_firma AS "estadoFirma",
                     firmado_at AS "firmadoAt", notas,
                     renovado_de_convenio_id AS "renovadoDeConvenioId", created_at AS "createdAt"`,
          [
            id,
            b.vigenciaDesde,
            b.vigenciaHasta ?? null,
            // The successor's own note wins; absent, it inherits what the predecessor said.
            b.notas !== undefined ? (b.notas ? b.notas : null) : (origen.notas ?? null),
            cid,
            req.user!.userId,
          ],
        );
        const nuevo = ins.rows[0];

        let tarifasCopiadas = 0;
        if (b.copiarTarifas !== false) {
          const cop = await q(
            `INSERT INTO transportista_tarifas
               (convenio_id, tipo_unidad, direccion_entrega_id, tarifa, moneda)
             SELECT $1, tipo_unidad, direccion_entrega_id, tarifa, moneda
               FROM transportista_tarifas
              WHERE convenio_id = $2 AND activo`,
            [nuevo.id, cid],
          );
          tarifasCopiadas = cop.rowCount ?? 0;
        }

        return { kind: 'ok' as const, convenio: nuevo, tarifasCopiadas, origen };
      });

      if (resultado.kind === 'no_encontrado') {
        res.status(404).json({ error: 'Convenio no encontrado para este transportista' });
        return;
      }
      if (resultado.kind === 'no_firmado') {
        res.status(409).json({
          error:
            `El convenio está en '${resultado.estado}': todavía no hay nada firmado que renovar. ` +
            'Un convenio sin firmar se edita directamente (PUT .../convenios/:cid); la renovación existe ' +
            'sólo para no tocar los términos de un convenio ya firmado.',
          estadoFirma: resultado.estado,
        });
        return;
      }

      await recordAudit({
        userId: req.user!.userId,
        action: 'CONVENIO_RENOVADO',
        entity: 'transportista_convenio',
        // The audited entity is the NEW row: it is the one that came into existence. The predecessor
        // is named in `before`, unchanged, so the chain reads in both directions.
        entityId: resultado.convenio.id as string,
        before: {
          convenioOrigenId: cid,
          estadoFirma: resultado.origen.estado_firma,
          vigenciaDesde: resultado.origen.vigencia_desde,
          vigenciaHasta: resultado.origen.vigencia_hasta,
        },
        after: {
          transportistaId: id,
          ...resultado.convenio,
          tarifasCopiadas: resultado.tarifasCopiadas,
        },
        ip: req.ip,
      });

      res.status(201).json({ ...resultado.convenio, tarifasCopiadas: resultado.tarifasCopiadas });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * Contract upload. 20 MB: a scanned multi-page agreement with annexes, and nothing larger has any
 * business being a contract.
 */
const uploadConvenio = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

const TIPOS_CONTENIDO_CONVENIO = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
]);

/**
 * POST /api/transportistas/:id/convenios/:cid/archivo — attach the agreement itself.
 *
 * Hashed and stored through `saveFile` like every other artifact, so the contract the rates claim to
 * come from is content-addressable and lands in the same evidence chain. Kept separate from the
 * convenio's creation because the row exists the moment terms are agreed and the signed PDF arrives
 * days later; blocking one on the other would push the rates back into somebody's inbox.
 */
transportistasRouter.post(
  '/:id/convenios/:cid/archivo',
  requireAuth,
  requireRole('admin'),
  uploadConvenio.single('file'),
  validate({ params: transportistaConvenioParam }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id, cid } = req.params;
      if (!req.file) {
        res.status(400).json({ error: 'Falta el archivo del convenio (campo `file`).' });
        return;
      }
      const contentType = (req.file.mimetype ?? '').toLowerCase();
      if (!TIPOS_CONTENIDO_CONVENIO.has(contentType)) {
        res.status(400).json({
          error: `Tipo de archivo no permitido ('${contentType || 'desconocido'}'). Se acepta PDF o imagen escaneada.`,
        });
        return;
      }

      const c = await query('SELECT id FROM transportista_convenios WHERE id = $1 AND transportista_id = $2', [cid, id]);
      if (!c.rows.length) {
        res.status(404).json({ error: 'Convenio no encontrado para este transportista' });
        return;
      }

      const file = await saveFile({
        kind: 'convenio',
        originalName: req.file.originalname,
        bytes: req.file.buffer,
        uploadedBy: req.user!.userId,
      });

      const { rows } = await query(
        `UPDATE transportista_convenios SET file_id = $2 WHERE id = $1
         RETURNING id, file_id AS "fileId", estado_firma AS "estadoFirma"`,
        [cid, file.id],
      );

      await recordAudit({
        userId: req.user!.userId,
        action: 'CONVENIO_ARCHIVO_ADJUNTADO',
        entity: 'transportista_convenio',
        entityId: cid,
        after: {
          transportistaId: id,
          fileId: file.id,
          contentHash: file.contentHash,
          originalName: req.file.originalname,
          sizeBytes: file.sizeBytes,
        },
        ip: req.ip,
      });

      res.status(201).json({ ok: true, ...rows[0], contentHash: file.contentHash });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /api/transportistas/:id/convenios/:cid/firmar — D9, the only path to `firmado`.
 *
 * `firmaProveedor` and `firmaReferencia` are both required. Without a provider and a reference the
 * word "signed" means only that somebody pressed a button, and every rate in the agreement would
 * then rest on that button. There is no Mexican PSC integration yet (§17): what this endpoint does
 * is record a signature performed elsewhere, in a form that can be checked against the provider —
 * which is a smaller claim than "we signed it", and the true one.
 *
 * 409 on a convenio that is already `firmado` or `vencido`: re-signing would move `firmado_at` and
 * erase when the agreement actually took effect.
 */
transportistasRouter.post(
  '/:id/convenios/:cid/firmar',
  requireAuth,
  requireRole('admin'),
  validate({ params: transportistaConvenioParam, body: convenioFirmaBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id, cid } = req.params;
      const b = req.body as ConvenioFirmaBody;
      const firmadoAt = b.firmadoAt ? new Date(b.firmadoAt) : new Date();

      const resultado = await withTransaction(async (q: Q) => {
        const c = await q(
          `SELECT id, estado_firma FROM transportista_convenios
            WHERE id = $1 AND transportista_id = $2 FOR UPDATE`,
          [cid, id],
        );
        if (!c.rows.length) return { kind: 'no_encontrado' as const };
        const estadoActual = String(c.rows[0].estado_firma);
        if (estadoActual === 'firmado' || estadoActual === 'vencido') {
          return { kind: 'estado_invalido' as const, estado: estadoActual };
        }

        const upd = await q(
          `UPDATE transportista_convenios
              SET estado_firma = 'firmado',
                  firmado_at = $2,
                  firma_proveedor = $3,
                  firma_referencia = $4,
                  firma_evidencia_file_id = COALESCE($5, firma_evidencia_file_id)
            WHERE id = $1
            RETURNING id, estado_firma AS "estadoFirma", firmado_at AS "firmadoAt",
                      firma_proveedor AS "firmaProveedor", firma_referencia AS "firmaReferencia",
                      firma_evidencia_file_id AS "firmaEvidenciaFileId",
                      vigencia_desde AS "vigenciaDesde", vigencia_hasta AS "vigenciaHasta"`,
          [cid, firmadoAt, b.firmaProveedor, b.firmaReferencia, b.firmaEvidenciaFileId ?? null],
        );
        return { kind: 'ok' as const, convenio: upd.rows[0] };
      });

      if (resultado.kind === 'no_encontrado') {
        res.status(404).json({ error: 'Convenio no encontrado para este transportista' });
        return;
      }
      if (resultado.kind === 'estado_invalido') {
        res.status(409).json({
          error: `El convenio está en estado '${resultado.estado}'; sólo se puede firmar un convenio en 'borrador' o 'enviado'.`,
          estadoFirma: resultado.estado,
        });
        return;
      }

      await recordAudit({
        userId: req.user!.userId,
        action: 'CONVENIO_FIRMADO',
        entity: 'transportista_convenio',
        entityId: cid,
        after: { transportistaId: id, ...resultado.convenio },
        ip: req.ip,
      });

      res.json({ ok: true, ...resultado.convenio });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /api/transportistas/:id/convenios/:cid/tarifas — a rate inside an agreement.
 *
 * `tipoUnidad` is required by the schema, which is D7 again: a rate that did not name a unit type
 * could not be found by the options query, so it would be a price nobody can act on.
 *
 * A rate may be added to an unsigned convenio on purpose — that is what a negotiation looks like —
 * but `GET /api/despachos/opciones` only resolves rates from convenios that are `firmado` and in
 * force, so a draft price can never quietly become the one a truck is contracted against.
 */
transportistasRouter.post(
  '/:id/convenios/:cid/tarifas',
  requireAuth,
  requireRole('admin'),
  validate({ params: transportistaConvenioParam, body: tarifaBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id, cid } = req.params;
      const b = req.body as TarifaBody;

      const c = await query('SELECT id FROM transportista_convenios WHERE id = $1 AND transportista_id = $2', [cid, id]);
      if (!c.rows.length) {
        res.status(404).json({ error: 'Convenio no encontrado para este transportista' });
        return;
      }
      if (b.direccionEntregaId) {
        const d = await query('SELECT id FROM client_direcciones WHERE id = $1', [b.direccionEntregaId]);
        if (!d.rows.length) {
          res.status(400).json({ error: 'La `direccionEntregaId` indicada no existe.' });
          return;
        }
      }

      const { rows } = await query(
        `INSERT INTO transportista_tarifas
           (convenio_id, tipo_unidad, direccion_entrega_id, tarifa, moneda, vigencia_desde, vigencia_hasta)
         VALUES ($1,$2,$3,$4,COALESCE($5,'MXN'),$6,$7)
         RETURNING id, tipo_unidad AS "tipoUnidad", direccion_entrega_id AS "direccionEntregaId",
                   tarifa, moneda, vigencia_desde AS "vigenciaDesde", vigencia_hasta AS "vigenciaHasta"`,
        [
          cid,
          b.tipoUnidad,
          b.direccionEntregaId ?? null,
          b.tarifa,
          b.moneda ?? null,
          b.vigenciaDesde ?? null,
          b.vigenciaHasta ?? null,
        ],
      );

      await recordAudit({
        userId: req.user!.userId,
        action: 'TARIFA_REGISTRADA',
        entity: 'transportista_tarifa',
        entityId: rows[0].id,
        after: { transportistaId: id, convenioId: cid, ...rows[0] },
        ip: req.ip,
      });

      res.status(201).json(rows[0]);
    } catch (err) {
      next(err);
    }
  },
);

const TARIFA_RETURNING = `id, tipo_unidad AS "tipoUnidad", direccion_entrega_id AS "direccionEntregaId",
                          tarifa, moneda, vigencia_desde AS "vigenciaDesde",
                          vigencia_hasta AS "vigenciaHasta", activo`;

/**
 * PUT /api/transportistas/:id/convenios/:cid/tarifas/:tid — correct a rate.
 *
 * WHY THIS IS NOT "JUST" AN UPDATE. Until now a mispriced rate could only be SUPERSEDED by adding a
 * second row, and the resolver breaks ties by the lowest price (`resolverTarifa`, routes/despachos.ts
 * — deliberately: a cheaper truck is unambiguously better for us, and the reasoning is spelled out in
 * shared/operaciones/facturacion.ts, which takes the opposite tiebreak for revenue). So a correction
 * UPWARDS could never take effect: the wrong, cheaper row kept winning. Correcting the row is the
 * only remedy that reaches the resolver, and deactivating (below) is the only one that removes a rate
 * from it without deleting history.
 *
 * WHAT IT CANNOT REACH: despachos already contracted. `despachos` stores `tarifa_monto` beside
 * `tarifa_id` precisely so a later correction cannot restate what a past trip was priced at (see the
 * comment above the insert in routes/despachos.ts). A trip keeps the number that was agreed on its
 * day; only future resolutions see the corrected one.
 *
 * `before` IS AUDITED, not just `after`. "The rate changed" is not a useful record; "it went from
 * 8,500 to 9,200 on the 3rd, by this user" is. This is money.
 */
transportistasRouter.put(
  '/:id/convenios/:cid/tarifas/:tid',
  requireAuth,
  requireRole('admin'),
  validate({ params: transportistaTarifaParam, body: tarifaUpdateBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id, cid, tid } = req.params;
      const b = req.body as TarifaUpdateBody;

      const sets: string[] = [];
      const params: unknown[] = [tid, cid];
      const set = (col: string, val: unknown): void => {
        params.push(val);
        sets.push(`${col} = $${params.length}`);
      };
      if (b.tipoUnidad !== undefined) set('tipo_unidad', b.tipoUnidad);
      // null is meaningful here: "this rate stops being destination-specific".
      if (b.direccionEntregaId !== undefined) set('direccion_entrega_id', b.direccionEntregaId);
      if (b.tarifa !== undefined) set('tarifa', b.tarifa);
      if (b.moneda !== undefined) set('moneda', b.moneda);
      if (b.vigenciaDesde !== undefined) set('vigencia_desde', b.vigenciaDesde);
      if (b.vigenciaHasta !== undefined) set('vigencia_hasta', b.vigenciaHasta);
      if (b.activo !== undefined) set('activo', b.activo);
      if (!sets.length) {
        res.status(400).json({ error: 'No hay nada que actualizar.' });
        return;
      }

      const c = await query(
        'SELECT id FROM transportista_convenios WHERE id = $1 AND transportista_id = $2',
        [cid, id],
      );
      if (!c.rows.length) {
        res.status(404).json({ error: 'Convenio no encontrado para este transportista' });
        return;
      }
      if (b.direccionEntregaId) {
        const d = await query('SELECT id FROM client_direcciones WHERE id = $1', [b.direccionEntregaId]);
        if (!d.rows.length) {
          res.status(400).json({ error: 'La `direccionEntregaId` indicada no existe.' });
          return;
        }
      }

      const resultado = await withTransaction(async (q: Q) => {
        const antes = await q(
          `SELECT ${TARIFA_RETURNING} FROM transportista_tarifas
            WHERE id = $1 AND convenio_id = $2 FOR UPDATE`,
          [tid, cid],
        );
        if (!antes.rows.length) return { kind: 'no_encontrada' as const };
        const upd = await q(
          `UPDATE transportista_tarifas SET ${sets.join(', ')}
            WHERE id = $1 AND convenio_id = $2
            RETURNING ${TARIFA_RETURNING}`,
          params,
        );
        return { kind: 'ok' as const, antes: antes.rows[0], tarifa: upd.rows[0] };
      });

      if (resultado.kind === 'no_encontrada') {
        res.status(404).json({ error: 'Tarifa no encontrada en este convenio' });
        return;
      }

      await recordAudit({
        userId: req.user!.userId,
        action: 'TARIFA_ACTUALIZADA',
        entity: 'transportista_tarifa',
        entityId: tid,
        before: resultado.antes,
        after: { transportistaId: id, convenioId: cid, ...resultado.tarifa },
        ip: req.ip,
      });

      res.json(resultado.tarifa);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * DELETE /api/transportistas/:id/convenios/:cid/tarifas/:tid — retire a rate.
 *
 * Deactivates, never deletes, exactly like a unit and a delivery address: `despachos.tarifa_id`
 * points at this row, and "at what agreed price was this trip contracted?" has to stay answerable
 * after the price stops being offered. A deactivated rate NEVER resolves again — both the D7 options
 * query and `resolverTarifa` filter on `activo` — which is what makes this the honest remedy for a
 * mispriced row, as opposed to burying it under a cheaper one and hoping.
 *
 * Idempotent-ish by design: retiring an already-retired rate answers 200 with `activo: false`, the
 * same posture the unit endpoint takes. Reactivating is `PUT { activo: true }`.
 */
transportistasRouter.delete(
  '/:id/convenios/:cid/tarifas/:tid',
  requireAuth,
  requireRole('admin'),
  validate({ params: transportistaTarifaParam }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id, cid, tid } = req.params;
      const { rows } = await query(
        `UPDATE transportista_tarifas tf SET activo = false
           FROM transportista_convenios c
          WHERE tf.id = $1 AND tf.convenio_id = $2 AND c.id = tf.convenio_id AND c.transportista_id = $3
          RETURNING tf.id, tf.tipo_unidad AS "tipoUnidad", tf.tarifa, tf.moneda, tf.activo`,
        [tid, cid, id],
      );
      if (!rows.length) {
        res.status(404).json({ error: 'Tarifa no encontrada en este convenio' });
        return;
      }

      await recordAudit({
        userId: req.user!.userId,
        action: 'TARIFA_DESACTIVADA',
        entity: 'transportista_tarifa',
        entityId: tid,
        after: { transportistaId: id, convenioId: cid, ...rows[0] },
        ip: req.ip,
      });

      res.json({ ok: true, ...rows[0] });
    } catch (err) {
      next(err);
    }
  },
);
