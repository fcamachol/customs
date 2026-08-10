import { Router, type Request, type Response, type NextFunction } from 'express';
import { query } from '../db/pool';
import { withTransaction } from '../db/tx';
import { isUniqueViolation } from '../db/errors';
import { requireAuth, requireRole } from '../auth/middleware';
import { recordAudit } from '../services/audit';
import { validate } from '../validation/middleware';
import {
  despachoActualizarBody,
  despachoArriboBody,
  despachoCrearBody,
  despachoEstadoBody,
  despachoEtaBody,
  despachoListQuery,
  despachoOpcionesQuery,
  despachoParam,
  despachoPartidaBody,
  despachoPartidaCargaBody,
  despachoPartidaParam,
  despachoReasignarBody,
  operacionIdParam,
  type DespachoActualizarBody,
  type DespachoArriboBody,
  type DespachoCrearBody,
  type DespachoEstadoBody,
  type DespachoEtaBody,
  type DespachoOpcionesQuery,
  type DespachoPartidaBody,
  type DespachoReasignarBody,
} from '../validation/schemas';
import {
  aduanaOrigen,
  canAdvanceEstadoDespacho,
  etiquetaTipoUnidad,
  GUIA_ESTADOS_DESPACHABLES,
  GUIA_ESTADOS_NO_DESPACHABLES,
  type EstadoDespacho,
  type GuiaEstadoNoDespachable,
} from '../../../shared/operaciones/catalogos';
import { desviacionArriboMin, estimarArribo, fechaLocalMexico } from '../../../shared/operaciones/eta';

/**
 * DESPACHOS — one unit, one trip (PRD-02 R21–R29, R36/D14, CT-7/D10).
 *
 * THE FILE IN ONE SENTENCE: a despacho is the object that lets a single truck carry several
 * clients' cargo to one address without either the truck or the cargo becoming invisible.
 *
 * DECISION D7 IS ENFORCED MECHANICALLY HERE, NOT SUGGESTED. Luis argued the order of "unit type" and
 * "carrier" was irrelevant because the carrier implies the type; Fernando argued for type first so
 * nobody phones a carrier who cannot serve the load, and Alfonso settled it in Fernando's favour.
 * A wizard step would have made that a habit. Instead: `GET /opciones` — the only endpoint that
 * answers "which carriers can I call?" — REFUSES without `tipoUnidad`, because the rate that makes a
 * carrier answerable is indexed by type and there is literally nothing to return. `POST /` requires
 * `tipoUnidad` and accepts the carrier as optional. The database agrees: `despachos.tipo_unidad` is
 * notNull with no default, `transportista_id` is nullable.
 *
 * R21 IS THE STATE MACHINE, NOT A FORMULA. Luis asked to port the Excel status formula; the answer
 * was that there is no Excel. `canAdvanceEstadoDespacho` (shared/operaciones/catalogos.ts) is the
 * replacement: monotonic along the happy path, `cancelado` from anywhere, `en_espera` only before
 * loading starts. Every transition also stamps its own timestamp column, because the operationally
 * interesting number is never the state — it is `cita_at` against `ingreso_patio_at` (R30, "cité
 * 10:00, entró 10:05"), or `inicio_carga_at` against `fin_carga_at`. A state column holds the latest
 * value; only timestamps hold deltas.
 *
 * WHY A HOLD BLOCKS LOADING A GUÍA ONTO A TRUCK, AND NOTHING ELSE DOES. `POST /:id/partidas` is the
 * one place in this module that consults `operaciones.hold_activo`, and it refuses. This is the
 * junction the freeze layer exists for: a hold never changes the physical etapa (routes/holds.ts),
 * it inhibits PLANNING, and planning cargo onto a contracted unit is the planning act that costs
 * money. A guía that is `retenida`, `no_transmitida`, `cancelada` or `csa_pendiente` is refused for
 * the same reason and with its own message — CT-2 and CT-5 are about cargo that must not be declared
 * as leaving when it is not leaving.
 *
 * MONEY-TOUCHING ACTIONS ARE OVERRIDES (§8.8 / D6 / R20). `POST /:id/reasignar` is CT-7/D10 — moving
 * an already-contracted unit onto other cargo instead of cancelling and eating a *flete en falso*.
 * It requires a `motivo`, writes its ledger events with `override = true`, and is the only endpoint
 * here that does. The contingency engine (#26) may PROPOSE this; a human confirms it, and this is
 * where the confirmation is recorded.
 *
 * LEDGER EVENTS LAND ON EVERY CASO RIDING ON THE UNIT, not on a trip-level log. Same reasoning as
 * the global hold: six weeks later the question comes one shipment at a time, and each timeline has
 * to answer it without the reader already knowing which trip to look up. `operacion_eventos` gained
 * a `despacho_id` column so the trip's own timeline is still one query.
 */
export const despachosRouter = Router();

type Q = (text: string, params?: unknown[]) => Promise<any>;

/** Serializes folio minting per operating day; see `siguienteFolio`. */
const LOCK_FOLIO_DESPACHO = 5000001;

/**
 * Guías that may be loaded onto a unit, and why the others may not.
 *
 * Both halves come from `shared/operaciones/catalogos.ts` rather than being retyped here: the refusal
 * set and `REPLAN_RULESET.guiaNoDespachable` are ONE product rule, and while they were two hand-synced
 * literals a divergence would have meant the plan showing a guía as excluded while this endpoint let
 * it onto a truck. The `Record<GuiaEstadoNoDespachable, string>` annotation is the enforcement: adding
 * a state to the shared list fails to compile here until somebody writes the sentence the coordinator
 * will read when the load is refused.
 */
const ESTADOS_GUIA_CARGABLES = new Set<string>(GUIA_ESTADOS_DESPACHABLES);
const MOTIVO_GUIA_NO_CARGABLE: Record<GuiaEstadoNoDespachable, string> = {
  retenida: 'La guía está retenida por la autoridad (CT-5): el pedimento debe declarar la carga que realmente sale.',
  no_transmitida: 'La guía no está transmitida (CT-2): se excluye del plan hasta que se transmita.',
  csa_pendiente: 'La guía está consignada a otra agencia y falta la carta de cesión (CT-3).',
  cancelada: 'La guía está cancelada.',
};

/**
 * Estados in which the load is already closed. Adding or removing cargo after `cargado` would mean
 * the record no longer describes what physically left, which is the one thing the pedimento depends
 * on it for.
 */
const ESTADOS_CARGA_CERRADA = new Set<EstadoDespacho>([
  'cargado',
  'modulado',
  'en_transito',
  'entregado',
  'cancelado',
]);

/**
 * Next folio for an operating day: `D-YYYYMMDD-001`.
 *
 * Derived from the date rather than from a global sequence because the folio is read aloud between
 * three organisations that do not share a database ("la D-20260814-003 ya salió"), and a number that
 * encodes its own day is checkable by a human. The advisory lock is transaction-scoped and keyed by
 * the date, so two coordinators programming the same morning cannot both mint `-003`; the UNIQUE
 * constraint on `folio` is the backstop if anyone writes one by another path.
 */
async function siguienteFolio(q: Q, fechaOperacion: string): Promise<string> {
  const compacta = fechaOperacion.replace(/-/g, '');
  await q('SELECT pg_advisory_xact_lock($1, $2)', [LOCK_FOLIO_DESPACHO, Number(compacta.slice(2))]);
  const { rows } = await q(
    `SELECT count(*)::int AS n FROM despachos WHERE fecha_operacion = $1::date`,
    [fechaOperacion],
  );
  const n = (rows[0].n as number) + 1;
  return `D-${compacta}-${String(n).padStart(3, '0')}`;
}

/**
 * One ledger row per caso currently riding on this unit.
 *
 * Exported for `routes/pods.ts`: a signed POD is a fact about the same trip and has to land on the
 * same set of timelines, and a second implementation of "write one event per caso on this truck"
 * would eventually disagree with this one about which casos those are.
 *
 * Returns the affected operación ids so the caller can report the blast radius. A despacho with no
 * partidas produces NO events, and that is correct rather than a gap: an empty trip has not touched
 * anybody's cargo, and the `audit_log` row (which every action writes regardless) is where its
 * existence is recorded.
 */
export async function registrarEventoDespacho(
  q: Q,
  args: {
    despachoId: string;
    tipo: string;
    payload: Record<string, unknown>;
    userId: string;
    origen?: string;
    ocurridoAt?: Date;
    override?: boolean;
    motivo?: string | null;
    /** Override the set of casos to write onto — used when the load is about to change. */
    operacionIds?: string[];
  },
): Promise<{ eventos: number; operacionIds: string[] }> {
  let ids: string[];
  if (args.operacionIds) {
    ids = args.operacionIds;
  } else {
    const { rows } = await q(
      'SELECT DISTINCT operacion_id FROM despacho_partidas WHERE despacho_id = $1',
      [args.despachoId],
    );
    ids = rows.map((r: { operacion_id: string }) => r.operacion_id);
  }
  if (!ids.length) return { eventos: 0, operacionIds: [] };

  const { rowCount } = await q(
    `INSERT INTO operacion_eventos
       (operacion_id, operacion_mawb, despacho_id, tipo, origen, ocurrido_at, payload, override, motivo, created_by)
     SELECT o.id, o.mawb, $1, $2, $3, $4, $5::jsonb, $6, $7, $8
       FROM operaciones o
      WHERE o.id = ANY($9::uuid[])`,
    [
      args.despachoId,
      args.tipo,
      args.origen ?? 'coordinador',
      args.ocurridoAt ?? new Date(),
      JSON.stringify(args.payload),
      args.override ?? false,
      args.motivo ?? null,
      args.userId,
      ids,
    ],
  );
  return { eventos: rowCount ?? 0, operacionIds: ids };
}

/**
 * Resolve the agreed rate for a carrier, unit type and destination on a given day.
 *
 * Three rules, all of them about defensibility rather than arithmetic:
 *  - only convenios that are `firmado` AND in force on that date are considered. A draft price is a
 *    negotiation, not a rate, and a truck must never be contracted against one (R25/D9).
 *  - a destination-specific rate beats the general one for the same unit type. That is what a
 *    destination-specific rate MEANS; falling back to the general one would silently overcharge or
 *    undercharge the exact lane somebody negotiated.
 *  - among equals, the cheapest. A deterministic tiebreak, so the same inputs always resolve to the
 *    same row and the choice can be re-derived later.
 */
async function resolverTarifa(
  q: Q,
  args: {
    transportistaId: string;
    tipoUnidad: string;
    direccionEntregaId: string | null;
    fecha: string;
  },
): Promise<{ id: string; tarifa: string; moneda: string; convenioId: string } | null> {
  const { rows } = await q(
    `SELECT tf.id, tf.tarifa, tf.moneda, c.id AS "convenioId"
       FROM transportista_tarifas tf
       JOIN transportista_convenios c ON c.id = tf.convenio_id
      WHERE c.transportista_id = $1
        AND c.estado_firma = 'firmado'
        AND (c.vigencia_desde IS NULL OR c.vigencia_desde <= $4::date)
        AND (c.vigencia_hasta IS NULL OR c.vigencia_hasta >= $4::date)
        AND tf.tipo_unidad = $2
        AND (tf.direccion_entrega_id IS NULL OR tf.direccion_entrega_id = $3::uuid)
        AND (tf.vigencia_desde IS NULL OR tf.vigencia_desde <= $4::date)
        AND (tf.vigencia_hasta IS NULL OR tf.vigencia_hasta >= $4::date)
      ORDER BY (tf.direccion_entrega_id IS NOT NULL) DESC, tf.tarifa ASC
      LIMIT 1`,
    [args.transportistaId, args.tipoUnidad, args.direccionEntregaId, args.fecha],
  );
  return rows[0] ?? null;
}

const SELECT_DESPACHO = `
  d.id,
  d.folio,
  d.fecha_operacion            AS "fechaOperacion",
  d.tipo_unidad                AS "tipoUnidad",
  d.transportista_id           AS "transportistaId",
  t.razon_social               AS "transportista",
  d.unidad_id                  AS "unidadId",
  d.placas,
  d.operador_nombre            AS "operadorNombre",
  d.direccion_entrega_id       AS "direccionEntregaId",
  cd.alias                     AS "destino",
  d.estado,
  d.cita_at                    AS "citaAt",
  d.ingreso_patio_at           AS "ingresoPatioAt",
  d.ingreso_aduana_at          AS "ingresoAduanaAt",
  d.inicio_carga_at            AS "inicioCargaAt",
  d.fin_carga_at               AS "finCargaAt",
  d.modulacion_at              AS "modulacionAt",
  d.salida_at                  AS "salidaAt",
  d.eta_calculado              AS "etaCalculado",
  d.arribo_real                AS "arriboReal",
  d.eta_calculo                AS "etaCalculo",
  d.tarifa_id                  AS "tarifaId",
  d.tarifa_monto               AS "tarifaMonto",
  d.moneda,
  d.reasignado_de_despacho_id  AS "reasignadoDeDespachoId",
  d.comentarios,
  d.created_at                 AS "createdAt"`;

const FROM_DESPACHO = `
  FROM despachos d
  LEFT JOIN transportistas t ON t.id = d.transportista_id
  LEFT JOIN client_direcciones cd ON cd.id = d.direccion_entrega_id`;

// =================================================================================================
// D7 — registered FIRST so the literal 'opciones' can never be captured as a despacho id.
// =================================================================================================

/**
 * GET /api/despachos/opciones?tipoUnidad=…&direccionEntregaId=…&fecha=… — decision D7, as an endpoint.
 *
 * `tipoUnidad` is required by the schema, so a request that has not decided the unit type gets a 400
 * and not a list. That refusal IS the feature: it is what stops the round of phone calls to carriers
 * who cannot serve the load, which is the cost Fernando's argument was about.
 *
 * A carrier is offered only when all four things are true on the requested date: it is `activo`, it
 * has at least one ACTIVE unit of that type, it has a `firmado` convenio in force, and that convenio
 * prices that unit type. Anything less and the "option" would be an invitation to call somebody who
 * either cannot carry it or has no agreed price — and a trip contracted with no rate is how a
 * surprise invoice arrives a month later.
 *
 * Carriers that fail only the rate test are still returned, flagged `tarifa: null` with an explicit
 * `advertencia`, rather than being dropped. Discipline 6: a carrier with no current agreement is a
 * fact the coordinator needs to see and act on, not one to hide.
 */
despachosRouter.get(
  '/opciones',
  requireAuth,
  requireRole('admin', 'capturista'),
  validate({ query: despachoOpcionesQuery }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tipoUnidad, direccionEntregaId, fecha } = req.query as unknown as DespachoOpcionesQuery;
      // CDMX, not UTC. The date decides which convenios and tarifas are IN FORCE, so a UTC default
      // would, every evening from 18:00 local, price the trip against tomorrow's vigencias — and a
      // convenio expiring today would stop being offered half a day early.
      const dia = fecha ?? fechaLocalMexico(new Date()) ?? new Date().toISOString().slice(0, 10);

      const { rows } = await query(
        `SELECT t.id                AS "transportistaId",
                t.razon_social      AS "transportista",
                t.documentos_ok     AS "documentosOk",
                u.unidades,
                tf.id               AS "tarifaId",
                tf.tarifa,
                tf.moneda,
                tf."convenioId",
                tf."especificaDestino"
           FROM transportistas t
           JOIN LATERAL (
             SELECT count(*)::int AS unidades
               FROM transportista_unidades tu
              WHERE tu.transportista_id = t.id AND tu.activo AND tu.tipo_unidad = $1
           ) u ON u.unidades > 0
           LEFT JOIN LATERAL (
             SELECT x.id, x.tarifa, x.moneda, c.id AS "convenioId",
                    (x.direccion_entrega_id IS NOT NULL) AS "especificaDestino"
               FROM transportista_tarifas x
               JOIN transportista_convenios c ON c.id = x.convenio_id
              WHERE c.transportista_id = t.id
                AND c.estado_firma = 'firmado'
                AND (c.vigencia_desde IS NULL OR c.vigencia_desde <= $3::date)
                AND (c.vigencia_hasta IS NULL OR c.vigencia_hasta >= $3::date)
                AND x.tipo_unidad = $1
                AND (x.direccion_entrega_id IS NULL OR x.direccion_entrega_id = $2::uuid)
                AND (x.vigencia_desde IS NULL OR x.vigencia_desde <= $3::date)
                AND (x.vigencia_hasta IS NULL OR x.vigencia_hasta >= $3::date)
              ORDER BY (x.direccion_entrega_id IS NOT NULL) DESC, x.tarifa ASC
              LIMIT 1
           ) tf ON true
          WHERE t.estado = 'activo'
          ORDER BY (tf.tarifa IS NULL), tf.tarifa ASC, t.razon_social`,
        [tipoUnidad, direccionEntregaId ?? null, dia],
      );

      res.json({
        tipoUnidad,
        tipoUnidadLabel: etiquetaTipoUnidad(tipoUnidad),
        fecha: dia,
        direccionEntregaId: direccionEntregaId ?? null,
        // Spelled out in the response so a client that renders this list cannot present it as a plain
        // carrier directory: it is the answer to a question that already fixed the unit type (D7).
        orden: 'tipo de unidad primero, transportista después (D7)',
        opciones: rows.map((r) => ({
          ...r,
          advertencia: r.tarifaId
            ? null
            : 'Sin tarifa vigente para este tipo de unidad: no hay convenio firmado que la cubra en esta fecha.',
        })),
      });
    } catch (err) {
      next(err);
    }
  },
);

// =================================================================================================
// Lectura
// =================================================================================================

despachosRouter.get(
  '/',
  requireAuth,
  validate({ query: despachoListQuery }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { fecha, estado, transportistaId, operacionId } = req.query as Record<string, string | undefined>;
      const { rows } = await query(
        `SELECT ${SELECT_DESPACHO},
                (SELECT count(*)::int FROM despacho_partidas p WHERE p.despacho_id = d.id) AS "partidas"
         ${FROM_DESPACHO}
          WHERE ($1::date IS NULL OR d.fecha_operacion = $1::date)
            AND ($2::text IS NULL OR d.estado = $2)
            AND ($3::uuid IS NULL OR d.transportista_id = $3::uuid)
            AND ($4::uuid IS NULL OR EXISTS (
                  SELECT 1 FROM despacho_partidas dp
                   WHERE dp.despacho_id = d.id AND dp.operacion_id = $4::uuid))
          ORDER BY d.fecha_operacion DESC, d.folio
          LIMIT 500`,
        [fecha ?? null, estado ?? null, transportistaId ?? null, operacionId ?? null],
      );
      res.json(rows);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /api/despachos/:id — the trip with its load and its own timeline.
 *
 * `desviacionArriboMin` is computed here rather than stored: it is a pure function of two columns
 * that are already the record (D14), and a stored copy would be a third number able to disagree
 * with both.
 */
despachosRouter.get(
  '/:id',
  requireAuth,
  validate({ params: despachoParam }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const d = await query(`SELECT ${SELECT_DESPACHO} ${FROM_DESPACHO} WHERE d.id = $1`, [id]);
      if (!d.rows.length) {
        res.status(404).json({ error: 'Despacho no encontrado' });
        return;
      }

      const partidas = await query(
        `SELECT p.id,
                p.operacion_id       AS "operacionId",
                o.mawb,
                p.operacion_guia_id  AS "operacionGuiaId",
                g.guia_norm          AS "guia",
                g.estado             AS "guiaEstado",
                c.name               AS "cliente",
                p.pedimento_id       AS "pedimentoId",
                p.cartones_planeados AS "cartonesPlaneados",
                p.cartones_cargados  AS "cartonesCargados",
                p.piezas,
                p.orden_carga        AS "ordenCarga"
           FROM despacho_partidas p
           JOIN operaciones o ON o.id = p.operacion_id
           LEFT JOIN operacion_guias g ON g.id = p.operacion_guia_id
           LEFT JOIN clients c ON c.id = COALESCE(g.client_id, o.client_id)
          WHERE p.despacho_id = $1
          ORDER BY p.orden_carga NULLS LAST, p.created_at`,
        [id],
      );

      const eventos = await query(
        `SELECT id, operacion_id AS "operacionId", operacion_mawb AS "mawb", tipo, origen,
                ocurrido_at AS "ocurridoAt", registrado_at AS "registradoAt", payload,
                override, motivo
           FROM operacion_eventos
          WHERE despacho_id = $1
          ORDER BY ocurrido_at, id`,
        [id],
      );

      const despacho = d.rows[0] as { etaCalculado: Date | null; arriboReal: Date | null };
      res.json({
        ...despacho,
        desviacionArriboMin: desviacionArriboMin(despacho.etaCalculado, despacho.arriboReal),
        partidas: partidas.rows,
        eventos: eventos.rows,
      });
    } catch (err) {
      next(err);
    }
  },
);

// =================================================================================================
// Alta y asignación — R22 / D7, R28
// =================================================================================================

/**
 * Validate a carrier/unit assignment against the trip's unit type.
 *
 * The unit-type check is the reason this function exists. A `torton` despacho assigned a `tracto` is
 * not a typo to be tolerated: the load was sized for one and the rate was agreed for the other, so
 * accepting it would put a wrong price on a wrong vehicle and make both untraceable afterwards.
 */
async function validarAsignacion(
  q: Q,
  args: { transportistaId: string | null; unidadId: string | null; tipoUnidad: string },
): Promise<
  | { kind: 'ok'; placas: string | null }
  | { kind: 'transportista_no_encontrado' }
  | { kind: 'transportista_inactivo'; estado: string }
  | { kind: 'unidad_sin_transportista' }
  | { kind: 'unidad_ajena' }
  | { kind: 'unidad_inactiva' }
  | { kind: 'unidad_tipo_distinto'; tipoUnidad: string }
> {
  if (args.unidadId && !args.transportistaId) return { kind: 'unidad_sin_transportista' };
  if (!args.transportistaId) return { kind: 'ok', placas: null };

  const t = await q('SELECT id, estado FROM transportistas WHERE id = $1', [args.transportistaId]);
  if (!t.rows.length) return { kind: 'transportista_no_encontrado' };
  if (t.rows[0].estado !== 'activo') return { kind: 'transportista_inactivo', estado: String(t.rows[0].estado) };

  if (!args.unidadId) return { kind: 'ok', placas: null };
  const u = await q(
    'SELECT id, transportista_id, tipo_unidad, placas, activo FROM transportista_unidades WHERE id = $1',
    [args.unidadId],
  );
  if (!u.rows.length || u.rows[0].transportista_id !== args.transportistaId) return { kind: 'unidad_ajena' };
  if (!u.rows[0].activo) return { kind: 'unidad_inactiva' };
  if (u.rows[0].tipo_unidad !== args.tipoUnidad) {
    return { kind: 'unidad_tipo_distinto', tipoUnidad: String(u.rows[0].tipo_unidad) };
  }
  return { kind: 'ok', placas: String(u.rows[0].placas) };
}

function responderAsignacionInvalida(res: Response, r: { kind: string; [k: string]: unknown }, tipoUnidad: string): boolean {
  switch (r.kind) {
    case 'transportista_no_encontrado':
      res.status(400).json({ error: 'El transportista indicado no existe.' });
      return true;
    case 'transportista_inactivo':
      res.status(409).json({
        error: `El transportista está en estado '${r.estado}': no se le puede asignar carga.`,
      });
      return true;
    case 'unidad_sin_transportista':
      res.status(400).json({
        error: 'No se puede asignar una unidad sin transportista: una placa sin línea es un vehículo de nadie.',
      });
      return true;
    case 'unidad_ajena':
      res.status(400).json({ error: 'La unidad indicada no pertenece a ese transportista.' });
      return true;
    case 'unidad_inactiva':
      res.status(409).json({ error: 'La unidad está dada de baja.' });
      return true;
    case 'unidad_tipo_distinto':
      res.status(409).json({
        error: `El despacho es de tipo '${tipoUnidad}' y la unidad es '${r.tipoUnidad}'. Primero el tipo de unidad, después la línea (D7).`,
      });
      return true;
    default:
      return false;
  }
}

/**
 * POST /api/despachos — plan a trip.
 *
 * `tipoUnidad` is required, everything about the carrier is optional: that is D7 in the request
 * shape. A trip can be created with nothing but a date and a unit type, which is exactly how the
 * previous day's planning works — decide how much space is needed, THEN go looking for who has it.
 *
 * When a carrier IS supplied, the agreed rate is resolved and stored on the trip. It is stored as an
 * amount (`tarifa_monto`), not only as a pointer, because the rate row can later be superseded and
 * the figure that matters afterwards is what was agreed on the day.
 */
despachosRouter.post(
  '/',
  requireAuth,
  requireRole('admin', 'capturista'),
  validate({ body: despachoCrearBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const b = req.body as DespachoCrearBody;
      const userId = req.user!.userId;

      const resultado = await withTransaction(async (q: Q) => {
        if (b.direccionEntregaId) {
          const d = await q('SELECT id FROM client_direcciones WHERE id = $1 AND activo', [b.direccionEntregaId]);
          if (!d.rows.length) return { kind: 'direccion_invalida' as const };
        }

        const asignacion = await validarAsignacion(q, {
          transportistaId: b.transportistaId ?? null,
          unidadId: b.unidadId ?? null,
          tipoUnidad: b.tipoUnidad,
        });
        if (asignacion.kind !== 'ok') return { kind: 'asignacion_invalida' as const, detalle: asignacion };

        let tarifa: Awaited<ReturnType<typeof resolverTarifa>> = null;
        if (b.transportistaId) {
          tarifa = await resolverTarifa(q, {
            transportistaId: b.transportistaId,
            tipoUnidad: b.tipoUnidad,
            direccionEntregaId: b.direccionEntregaId ?? null,
            fecha: b.fechaOperacion,
          });
        }

        const folio = b.folio ?? (await siguienteFolio(q, b.fechaOperacion));
        const ins = await q(
          `INSERT INTO despachos
             (folio, fecha_operacion, tipo_unidad, transportista_id, unidad_id, placas,
              operador_nombre, direccion_entrega_id, cita_at, tarifa_id, tarifa_monto, moneda,
              comentarios, created_by)
           VALUES ($1,$2::date,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
           RETURNING id, folio, estado, created_at AS "createdAt"`,
          [
            folio,
            b.fechaOperacion,
            b.tipoUnidad,
            b.transportistaId ?? null,
            b.unidadId ?? null,
            b.placas ?? asignacion.placas ?? null,
            b.operadorNombre ?? null,
            b.direccionEntregaId ?? null,
            b.citaAt ? new Date(b.citaAt) : null,
            tarifa?.id ?? null,
            tarifa?.tarifa ?? null,
            tarifa?.moneda ?? null,
            b.comentarios ?? null,
            userId,
          ],
        );
        return { kind: 'ok' as const, despacho: ins.rows[0], tarifa, placas: b.placas ?? asignacion.placas ?? null };
      });

      if (resultado.kind === 'direccion_invalida') {
        res.status(400).json({ error: 'La `direccionEntregaId` indicada no existe o está inactiva.' });
        return;
      }
      if (resultado.kind === 'asignacion_invalida') {
        responderAsignacionInvalida(res, resultado.detalle, b.tipoUnidad);
        return;
      }

      await recordAudit({
        userId,
        action: 'DESPACHO_CREADO',
        entity: 'despacho',
        entityId: resultado.despacho.id,
        after: {
          folio: resultado.despacho.folio,
          fechaOperacion: b.fechaOperacion,
          tipoUnidad: b.tipoUnidad,
          transportistaId: b.transportistaId ?? null,
          unidadId: b.unidadId ?? null,
          placas: resultado.placas,
          direccionEntregaId: b.direccionEntregaId ?? null,
          tarifaId: resultado.tarifa?.id ?? null,
          tarifaMonto: resultado.tarifa?.tarifa ?? null,
        },
        ip: req.ip,
      });

      res.status(201).json({
        ok: true,
        id: resultado.despacho.id,
        folio: resultado.despacho.folio,
        estado: resultado.despacho.estado,
        fechaOperacion: b.fechaOperacion,
        tipoUnidad: b.tipoUnidad,
        tipoUnidadLabel: etiquetaTipoUnidad(b.tipoUnidad),
        transportistaId: b.transportistaId ?? null,
        unidadId: b.unidadId ?? null,
        placas: resultado.placas,
        tarifaId: resultado.tarifa?.id ?? null,
        tarifaMonto: resultado.tarifa?.tarifa ?? null,
        moneda: resultado.tarifa?.moneda ?? null,
        // Said out loud rather than left as a null column: a trip with a carrier and no agreed rate
        // is the shape a surprise invoice arrives in (R25/D9).
        advertencia:
          b.transportistaId && !resultado.tarifa
            ? 'Se asignó transportista sin tarifa de convenio vigente para este tipo de unidad y destino.'
            : null,
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        res.status(409).json({ error: 'Ya existe un despacho con ese folio.' });
        return;
      }
      next(err);
    }
  },
);

/**
 * PUT /api/despachos/:id — edit the assignment (R28).
 *
 * Refused once the trip is `cargado` or beyond: at that point the cargo is physically on the vehicle
 * and the assignment is a record of what happened, not a plan. `null` unassigns (distinct from
 * absent, which leaves the field alone) so a coordinator who loses a carrier can say so.
 *
 * Changing `tipoUnidad` while a unit is assigned is rejected rather than silently clearing the unit.
 * D7 again: the type is the decision the rest hangs off, and re-deciding it invalidates the carrier
 * choice and the rate — the caller has to unassign deliberately.
 */
despachosRouter.put(
  '/:id',
  requireAuth,
  requireRole('admin', 'capturista'),
  validate({ params: despachoParam, body: despachoActualizarBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const b = req.body as DespachoActualizarBody;
      const userId = req.user!.userId;

      const resultado = await withTransaction(async (q: Q) => {
        const d = await q(
          `SELECT id, folio, estado, tipo_unidad, transportista_id, unidad_id, placas,
                  direccion_entrega_id, fecha_operacion::text AS fecha
             FROM despachos WHERE id = $1 FOR UPDATE`,
          [id],
        );
        if (!d.rows.length) return { kind: 'no_encontrado' as const };
        const actual = d.rows[0] as {
          id: string; folio: string; estado: EstadoDespacho; tipo_unidad: string;
          transportista_id: string | null; unidad_id: string | null; placas: string | null;
          direccion_entrega_id: string | null; fecha: string;
        };
        if (ESTADOS_CARGA_CERRADA.has(actual.estado)) {
          return { kind: 'carga_cerrada' as const, estado: actual.estado };
        }

        const tipoUnidad = b.tipoUnidad ?? actual.tipo_unidad;
        const unidadId = b.unidadId === undefined ? actual.unidad_id : b.unidadId;
        const transportistaId =
          b.transportistaId === undefined ? actual.transportista_id : b.transportistaId;

        if (b.tipoUnidad && b.tipoUnidad !== actual.tipo_unidad && unidadId && b.unidadId === undefined) {
          return { kind: 'tipo_con_unidad' as const, tipoUnidad: actual.tipo_unidad };
        }
        // Dropping the carrier necessarily drops its unit; requiring the caller to say so keeps a
        // vehicle from being left attached to nobody (also a table CHECK).
        if (transportistaId === null && unidadId !== null) {
          return { kind: 'unidad_huerfana' as const };
        }

        const asignacion = await validarAsignacion(q, { transportistaId, unidadId, tipoUnidad });
        if (asignacion.kind !== 'ok') return { kind: 'asignacion_invalida' as const, detalle: asignacion, tipoUnidad };

        const direccionEntregaId =
          b.direccionEntregaId === undefined ? actual.direccion_entrega_id : b.direccionEntregaId;
        if (direccionEntregaId && direccionEntregaId !== actual.direccion_entrega_id) {
          const dir = await q('SELECT id FROM client_direcciones WHERE id = $1 AND activo', [direccionEntregaId]);
          if (!dir.rows.length) return { kind: 'direccion_invalida' as const };
        }

        // Re-resolve the rate whenever anything it depends on moved. A stale `tarifa_monto` beside a
        // new carrier or a new destination is worse than none: it looks agreed and is not.
        const cambioTarifable =
          transportistaId !== actual.transportista_id ||
          tipoUnidad !== actual.tipo_unidad ||
          direccionEntregaId !== actual.direccion_entrega_id;
        let tarifa: Awaited<ReturnType<typeof resolverTarifa>> = null;
        if (cambioTarifable && transportistaId) {
          tarifa = await resolverTarifa(q, {
            transportistaId,
            tipoUnidad,
            direccionEntregaId: direccionEntregaId ?? null,
            fecha: actual.fecha,
          });
        }

        const sets: string[] = [];
        const params: unknown[] = [id];
        const set = (col: string, val: unknown): void => {
          params.push(val);
          sets.push(`${col} = $${params.length}`);
        };
        if (b.tipoUnidad !== undefined) set('tipo_unidad', tipoUnidad);
        if (b.transportistaId !== undefined) set('transportista_id', transportistaId);
        if (b.unidadId !== undefined) set('unidad_id', unidadId);
        // Plates follow the unit unless the caller overrides them. `b.placas === null` clears them
        // outright; and when the UNIT is dropped (`unidadId: null`) the denormalized copy goes with
        // it, because `asignacion.placas` is null in that case. Leaving the old plate behind is how
        // the published plan ends up naming a truck that is no longer on the trip — the copy must
        // never outlive what it is a copy of.
        if (b.placas !== undefined) set('placas', b.placas);
        else if (b.unidadId !== undefined) set('placas', asignacion.placas);
        if (b.operadorNombre !== undefined) set('operador_nombre', b.operadorNombre);
        if (b.direccionEntregaId !== undefined) set('direccion_entrega_id', direccionEntregaId);
        if (b.citaAt !== undefined) set('cita_at', b.citaAt ? new Date(b.citaAt) : null);
        if (b.comentarios !== undefined) set('comentarios', b.comentarios);
        if (cambioTarifable) {
          set('tarifa_id', tarifa?.id ?? null);
          set('tarifa_monto', tarifa?.tarifa ?? null);
          set('moneda', tarifa?.moneda ?? null);
        }
        if (!sets.length) return { kind: 'sin_cambios' as const };

        const upd = await q(
          `UPDATE despachos SET ${sets.join(', ')} WHERE id = $1
           RETURNING id, folio, estado, tipo_unidad AS "tipoUnidad", transportista_id AS "transportistaId",
                     unidad_id AS "unidadId", placas, operador_nombre AS "operadorNombre",
                     direccion_entrega_id AS "direccionEntregaId", cita_at AS "citaAt",
                     tarifa_id AS "tarifaId", tarifa_monto AS "tarifaMonto", moneda`,
          params,
        );
        const nuevo = upd.rows[0];

        // A carrier where there was none is the D7 second step, and it deserves its own event.
        const asignoTransportista =
          b.transportistaId !== undefined && transportistaId && transportistaId !== actual.transportista_id;
        const { eventos } = await registrarEventoDespacho(q, {
          despachoId: id,
          tipo: asignoTransportista ? 'DESPACHO_ASIGNADO' : 'DESPACHO_ACTUALIZADO',
          payload: {
            folio: actual.folio,
            tipoUnidad,
            transportistaId,
            unidadId,
            placas: nuevo.placas,
            direccionEntregaId,
            tarifaId: nuevo.tarifaId,
            tarifaMonto: nuevo.tarifaMonto,
            motivo: b.motivo ?? null,
          },
          userId,
        });

        return { kind: 'ok' as const, despacho: nuevo, eventos, antes: actual };
      });

      switch (resultado.kind) {
        case 'no_encontrado':
          res.status(404).json({ error: 'Despacho no encontrado' });
          return;
        case 'carga_cerrada':
          res.status(409).json({
            error: `El despacho está en estado '${resultado.estado}': la carga ya está cerrada y la asignación es un registro de lo ocurrido, no un plan.`,
          });
          return;
        case 'tipo_con_unidad':
          res.status(409).json({
            error: `No se puede cambiar el tipo de unidad mientras haya una unidad asignada (es de tipo '${resultado.tipoUnidad}'). Primero libera la unidad: el tipo es la decisión de la que cuelgan la línea y la tarifa (D7).`,
          });
          return;
        case 'unidad_huerfana':
          res.status(400).json({
            error: 'Al quitar el transportista hay que quitar también la unidad (envía `unidadId: null`).',
          });
          return;
        case 'direccion_invalida':
          res.status(400).json({ error: 'La `direccionEntregaId` indicada no existe o está inactiva.' });
          return;
        case 'asignacion_invalida':
          responderAsignacionInvalida(res, resultado.detalle, resultado.tipoUnidad);
          return;
        case 'sin_cambios':
          res.status(400).json({ error: 'No hay nada que actualizar.' });
          return;
        default:
          break;
      }

      await recordAudit({
        userId,
        action: 'DESPACHO_ACTUALIZADO',
        entity: 'despacho',
        entityId: id,
        before: {
          tipoUnidad: resultado.antes.tipo_unidad,
          transportistaId: resultado.antes.transportista_id,
          unidadId: resultado.antes.unidad_id,
          placas: resultado.antes.placas,
          direccionEntregaId: resultado.antes.direccion_entrega_id,
        },
        after: { ...resultado.despacho, motivo: b.motivo ?? null },
        ip: req.ip,
      });

      res.json({ ok: true, ...resultado.despacho, eventosRegistrados: resultado.eventos });
    } catch (err) {
      next(err);
    }
  },
);

// =================================================================================================
// Partidas — R29: N guías, N clientes, un destino
// =================================================================================================

/**
 * POST /api/despachos/:id/partidas — put one guía on this truck.
 *
 * THE FOUR REFUSALS, each of which is a real failure mode of the process this replaces:
 *
 *  1. the trip is `cargado` or beyond — the load is closed, and the record has to keep describing
 *     what physically left, because that is what the pedimento declares.
 *  2. the caso is under an active hold — the freeze layer's whole purpose. A hold never stops the
 *     aircraft; it stops PLANNING, and putting cargo on a contracted unit is the planning act that
 *     costs money (CT-3/CT-4/CT-6). Refusing here is what prevents the *flete en falso*.
 *  3. the guía is `retenida`, `no_transmitida`, `csa_pendiente` or `cancelada` — cargo that must not
 *     be declared as leaving when it is not leaving (CT-2/CT-5). Each gets its own message, because
 *     "no" without the reason sends somebody to ask three people. AND WHEN NO `operacionGuiaId` IS
 *     GIVEN THE SAME REFUSAL APPLIES TO EVERY GUÍA OF THE CASO: a partida without a guía claims all
 *     of that caso's cargo, so one blocked guía blocks it, and the message names the guía so the
 *     coordinator can split the caso instead of guessing.
 *  4. the guía is already on this truck — the unique constraint, surfaced as a 409.
 *
 * `ordenCarga` is assigned as the next consecutive when the caller omits it (R14: the warehouse
 * stages by this number, and holes in it are an instruction nobody can follow).
 */
despachosRouter.post(
  '/:id/partidas',
  requireAuth,
  requireRole('admin', 'capturista'),
  validate({ params: despachoParam, body: despachoPartidaBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const b = req.body as DespachoPartidaBody;
      const userId = req.user!.userId;

      const resultado = await withTransaction(async (q: Q) => {
        const d = await q('SELECT id, folio, estado FROM despachos WHERE id = $1 FOR UPDATE', [id]);
        if (!d.rows.length) return { kind: 'no_encontrado' as const };
        const despacho = d.rows[0] as { id: string; folio: string; estado: EstadoDespacho };
        if (ESTADOS_CARGA_CERRADA.has(despacho.estado)) {
          return { kind: 'carga_cerrada' as const, estado: despacho.estado };
        }

        const o = await q(
          'SELECT id, mawb, hold_activo, etapa FROM operaciones WHERE id = $1',
          [b.operacionId],
        );
        if (!o.rows.length) return { kind: 'operacion_no_encontrada' as const };
        const operacion = o.rows[0] as { id: string; mawb: string; hold_activo: boolean; etapa: string };
        if (operacion.hold_activo) return { kind: 'hold_activo' as const, mawb: operacion.mawb };

        let guia: { id: string; guiaNorm: string; estado: string; piezas: number | null; cartones: number | null } | null = null;
        if (b.operacionGuiaId) {
          const g = await q(
            `SELECT id, guia_norm AS "guiaNorm", estado, piezas, cartones
               FROM operacion_guias WHERE id = $1 AND operacion_id = $2`,
            [b.operacionGuiaId, b.operacionId],
          );
          if (!g.rows.length) return { kind: 'guia_ajena' as const };
          guia = g.rows[0];
          if (!ESTADOS_GUIA_CARGABLES.has(guia!.estado)) {
            return {
              kind: 'guia_no_cargable' as const,
              estado: guia!.estado,
              guia: guia!.guiaNorm,
              alcance: 'guia' as const,
            };
          }
        } else {
          // A PARTIDA WITHOUT A GUÍA CLAIMS THE WHOLE CASO, SO IT ANSWERS FOR EVERY GUÍA IN IT.
          //
          // The refusal above only ever looked at the guía it was handed, so omitting `operacionGuiaId`
          // walked straight past CT-2/CT-3/CT-5: a caso with one guía `retenida` could be put on a
          // truck in its entirety, and the pedimento would then declare cargo the authority is
          // holding. Refusing on the FIRST offending guía — in the shared list's declared order, so
          // the answer is deterministic — and naming it is what lets the coordinator go split the
          // caso guía by guía instead of guessing which one is blocked.
          const g = await q(
            `SELECT guia_norm AS "guiaNorm", estado
               FROM operacion_guias
              WHERE operacion_id = $1 AND estado <> ALL($2::text[])
              ORDER BY array_position($3::text[], estado) NULLS LAST, guia_norm
              LIMIT 1`,
            [b.operacionId, [...GUIA_ESTADOS_DESPACHABLES], [...GUIA_ESTADOS_NO_DESPACHABLES]],
          );
          if (g.rows.length) {
            const bloqueada = g.rows[0] as { guiaNorm: string; estado: string };
            return {
              kind: 'guia_no_cargable' as const,
              estado: bloqueada.estado,
              guia: bloqueada.guiaNorm,
              alcance: 'caso' as const,
            };
          }
        }

        let ordenCarga = b.ordenCarga ?? null;
        if (ordenCarga === null) {
          const max = await q(
            'SELECT COALESCE(max(orden_carga), 0)::int AS n FROM despacho_partidas WHERE despacho_id = $1',
            [id],
          );
          ordenCarga = (max.rows[0].n as number) + 1;
        }

        const ins = await q(
          `INSERT INTO despacho_partidas
             (despacho_id, operacion_id, operacion_guia_id, pedimento_id,
              cartones_planeados, piezas, orden_carga)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           RETURNING id, orden_carga AS "ordenCarga", cartones_planeados AS "cartonesPlaneados", piezas`,
          [
            id,
            b.operacionId,
            b.operacionGuiaId ?? null,
            b.pedimentoId ?? null,
            // Fall back to what the guía already declares, so the plan carries real quantities
            // instead of blanks the warehouse has to look up again.
            b.cartonesPlaneados ?? guia?.cartones ?? null,
            b.piezas ?? guia?.piezas ?? null,
            ordenCarga,
          ],
        );
        const partida = ins.rows[0];

        const { eventos } = await registrarEventoDespacho(q, {
          despachoId: id,
          tipo: 'DESPACHO_PARTIDA_AGREGADA',
          payload: {
            folio: despacho.folio,
            partidaId: partida.id,
            guia: guia?.guiaNorm ?? null,
            operacionGuiaId: guia?.id ?? null,
            ordenCarga: partida.ordenCarga,
            cartonesPlaneados: partida.cartonesPlaneados,
            piezas: partida.piezas,
          },
          userId,
          // Only this caso's timeline: the other shipments on the truck did not change.
          operacionIds: [b.operacionId],
        });

        return { kind: 'ok' as const, partida, despacho, mawb: operacion.mawb, guia, eventos };
      });

      switch (resultado.kind) {
        case 'no_encontrado':
          res.status(404).json({ error: 'Despacho no encontrado' });
          return;
        case 'carga_cerrada':
          res.status(409).json({
            error: `El despacho está en estado '${resultado.estado}': la carga ya está cerrada y no admite más guías.`,
          });
          return;
        case 'operacion_no_encontrada':
          res.status(404).json({ error: 'Operación no encontrada' });
          return;
        case 'hold_activo':
          res.status(409).json({
            error: `La operación ${resultado.mawb} tiene un hold activo: no se programa ni se solicitan unidades hasta que se cierre.`,
          });
          return;
        case 'guia_ajena':
          res.status(400).json({ error: 'La `operacionGuiaId` indicada no pertenece a esa operación.' });
          return;
        case 'guia_no_cargable': {
          // The cause is the same sentence either way; what changes is that a whole-caso partida has
          // to say WHICH guía blocked it, since the caller never named one.
          const motivo =
            MOTIVO_GUIA_NO_CARGABLE[resultado.estado as GuiaEstadoNoDespachable] ??
            `La guía está en estado '${resultado.estado}' y no puede cargarse.`;
          res.status(409).json({
            error:
              resultado.alcance === 'caso'
                ? `La partida sin guía se lleva TODA la operación, y la guía ${resultado.guia} no puede salir. ${motivo} Agrega las guías una por una si el resto sí sale.`
                : motivo,
            guia: resultado.guia,
            estado: resultado.estado,
            alcance: resultado.alcance,
          });
          return;
        }
        default:
          break;
      }

      await recordAudit({
        userId,
        action: 'DESPACHO_PARTIDA_AGREGADA',
        entity: 'despacho_partida',
        entityId: resultado.partida.id,
        after: {
          despachoId: id,
          folio: resultado.despacho.folio,
          operacionId: b.operacionId,
          mawb: resultado.mawb,
          operacionGuiaId: resultado.guia?.id ?? null,
          guia: resultado.guia?.guiaNorm ?? null,
          ordenCarga: resultado.partida.ordenCarga,
        },
        ip: req.ip,
      });

      res.status(201).json({ ok: true, despachoId: id, ...resultado.partida, eventosRegistrados: resultado.eventos });
    } catch (err) {
      if (isUniqueViolation(err)) {
        res.status(409).json({
          error: 'Esa guía ya está en este despacho, o el `ordenCarga` indicado ya está ocupado.',
        });
        return;
      }
      next(err);
    }
  },
);

/**
 * PUT /api/despachos/:id/partidas/:pid — what was ACTUALLY loaded.
 *
 * `cartonesCargados` beside `cartonesPlaneados` is the difference somebody has to explain: a truck
 * that left with fewer cartons than the plan said is a retención, a short manifest, or cargo left on
 * the dock, and one column could not tell those apart. Allowed while loading and after it, because
 * the count is often reconciled once the doors are closed.
 */
despachosRouter.put(
  '/:id/partidas/:pid',
  requireAuth,
  requireRole('admin', 'capturista', 'tramitador'),
  validate({ params: despachoPartidaParam, body: despachoPartidaCargaBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id, pid } = req.params;
      const { cartonesCargados } = req.body as { cartonesCargados?: number };
      if (cartonesCargados === undefined) {
        res.status(400).json({ error: 'Falta `cartonesCargados`.' });
        return;
      }

      const { rows } = await query(
        `UPDATE despacho_partidas SET cartones_cargados = $3
          WHERE id = $1 AND despacho_id = $2
          RETURNING id, operacion_id AS "operacionId", cartones_planeados AS "cartonesPlaneados",
                    cartones_cargados AS "cartonesCargados", orden_carga AS "ordenCarga"`,
        [pid, id, cartonesCargados],
      );
      if (!rows.length) {
        res.status(404).json({ error: 'Partida no encontrada para este despacho' });
        return;
      }

      await recordAudit({
        userId: req.user!.userId,
        action: 'DESPACHO_PARTIDA_CARGADA',
        entity: 'despacho_partida',
        entityId: pid,
        after: { despachoId: id, ...rows[0] },
        ip: req.ip,
      });

      res.json({
        ok: true,
        ...rows[0],
        // Surfaced, never silently tolerated: a gap between planned and loaded is a question.
        diferencia:
          rows[0].cartonesPlaneados == null
            ? null
            : Number(rows[0].cartonesCargados) - Number(rows[0].cartonesPlaneados),
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * DELETE /api/despachos/:id/partidas/:pid — take a guía off the truck.
 *
 * The row is deleted rather than flagged, and the reason it is safe to delete is that the removal is
 * an append-only ledger event on the caso's own timeline: the plan is a mutable working object, the
 * history of what was planned and unplanned is not. Refused once the load is closed, for the same
 * reason as adding.
 */
despachosRouter.delete(
  '/:id/partidas/:pid',
  requireAuth,
  requireRole('admin', 'capturista'),
  validate({ params: despachoPartidaParam }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id, pid } = req.params;
      const userId = req.user!.userId;

      const resultado = await withTransaction(async (q: Q) => {
        const d = await q('SELECT id, folio, estado FROM despachos WHERE id = $1 FOR UPDATE', [id]);
        if (!d.rows.length) return { kind: 'no_encontrado' as const };
        const despacho = d.rows[0] as { folio: string; estado: EstadoDespacho };
        if (ESTADOS_CARGA_CERRADA.has(despacho.estado)) {
          return { kind: 'carga_cerrada' as const, estado: despacho.estado };
        }

        const del = await q(
          `DELETE FROM despacho_partidas WHERE id = $1 AND despacho_id = $2
           RETURNING id, operacion_id AS "operacionId", operacion_guia_id AS "operacionGuiaId",
                     orden_carga AS "ordenCarga"`,
          [pid, id],
        );
        if (!del.rows.length) return { kind: 'partida_no_encontrada' as const };
        const partida = del.rows[0];

        const g = partida.operacionGuiaId
          ? await q('SELECT guia_norm AS "guiaNorm" FROM operacion_guias WHERE id = $1', [partida.operacionGuiaId])
          : { rows: [] as Array<{ guiaNorm: string }> };

        const { eventos } = await registrarEventoDespacho(q, {
          despachoId: id,
          tipo: 'DESPACHO_PARTIDA_RETIRADA',
          payload: {
            folio: despacho.folio,
            partidaId: partida.id,
            guia: g.rows[0]?.guiaNorm ?? null,
            ordenCarga: partida.ordenCarga,
          },
          userId,
          operacionIds: [partida.operacionId],
        });

        return { kind: 'ok' as const, partida, despacho, guia: g.rows[0]?.guiaNorm ?? null, eventos };
      });

      switch (resultado.kind) {
        case 'no_encontrado':
          res.status(404).json({ error: 'Despacho no encontrado' });
          return;
        case 'carga_cerrada':
          res.status(409).json({
            error: `El despacho está en estado '${resultado.estado}': la carga ya está cerrada.`,
          });
          return;
        case 'partida_no_encontrada':
          res.status(404).json({ error: 'Partida no encontrada para este despacho' });
          return;
        default:
          break;
      }

      await recordAudit({
        userId,
        action: 'DESPACHO_PARTIDA_RETIRADA',
        entity: 'despacho_partida',
        entityId: pid,
        after: {
          despachoId: id,
          folio: resultado.despacho.folio,
          operacionId: resultado.partida.operacionId,
          guia: resultado.guia,
        },
        ip: req.ip,
      });

      res.json({ ok: true, despachoId: id, partidaId: pid, eventosRegistrados: resultado.eventos });
    } catch (err) {
      next(err);
    }
  },
);

// =================================================================================================
// Estado — R21, la máquina de estados que sustituye la fórmula de Excel
// =================================================================================================

/** Which timestamp each state stamps. States that stamp nothing are pure position changes. */
const COLUMNA_TIEMPO: Partial<Record<EstadoDespacho, string>> = {
  en_patio: 'ingreso_patio_at',
  en_aduana: 'ingreso_aduana_at',
  cargando: 'inicio_carga_at',
  cargado: 'fin_carga_at',
  modulado: 'modulacion_at',
  en_transito: 'salida_at',
};

function minutosEntre(desde: Date, hasta: Date): number {
  return Math.round((hasta.getTime() - desde.getTime()) / 60000);
}

/**
 * POST /api/despachos/:id/estado — one step of the FSM (R21).
 *
 * `tramitador` is allowed: the arrival at the patio, the entry to the aduana and the load itself are
 * facts he is standing in front of, and routing them through an office phone call is how the times
 * stop being real. He cannot cancel — that is a commercial decision — which is enforced below.
 *
 * The `en_espera` resume is the one non-obvious mechanic. `en_espera` does not remember where the
 * trip stopped, and a column for it would be a second mutable copy of something the append-only
 * ledger already holds. So the pause point is read back from the last DESPACHO_ESTADO event and the
 * monotonicity check runs against THAT — which means a paused trip cannot silently rewind by being
 * resumed into an earlier state.
 */
despachosRouter.post(
  '/:id/estado',
  requireAuth,
  requireRole('admin', 'capturista', 'tramitador'),
  validate({ params: despachoParam, body: despachoEstadoBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const b = req.body as DespachoEstadoBody;
      const destino = b.estado as EstadoDespacho;
      const userId = req.user!.userId;
      const ocurrido = b.ocurridoAt ? new Date(b.ocurridoAt) : new Date();

      if (destino === 'cancelado' && req.user!.role === 'tramitador') {
        res.status(403).json({
          error: 'Cancelar un despacho es una decisión de oficina: el rol de campo reporta hechos, no cancela viajes.',
        });
        return;
      }

      const resultado = await withTransaction(async (q: Q) => {
        const d = await q(
          `SELECT id, folio, estado, cita_at, inicio_carga_at, ingreso_patio_at
             FROM despachos WHERE id = $1 FOR UPDATE`,
          [id],
        );
        if (!d.rows.length) return { kind: 'no_encontrado' as const };
        const despacho = d.rows[0] as {
          folio: string; estado: EstadoDespacho; cita_at: Date | null;
          inicio_carga_at: Date | null; ingreso_patio_at: Date | null;
        };
        if (despacho.estado === destino) return { kind: 'noop' as const, estado: destino };

        // Resolve the pause point from the ledger — see the doc comment.
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
            [id],
          );
          base = (prev.rows[0]?.estado as EstadoDespacho) ?? 'planeado';
        }

        if (!canAdvanceEstadoDespacho(base, destino, { reanudandoDesdeEspera: reanudando })) {
          return { kind: 'transicion_invalida' as const, estado: despacho.estado, base, destino };
        }

        const sets = ['estado = $2'];
        const params: unknown[] = [id, destino];
        const columna = COLUMNA_TIEMPO[destino];
        if (columna) {
          params.push(ocurrido);
          // COALESCE: re-entering a state after a pause must not rewrite the time it FIRST happened.
          sets.push(`${columna} = COALESCE(${columna}, $${params.length})`);
        }
        await q(`UPDATE despachos SET ${sets.join(', ')} WHERE id = $1`, params);

        const payload: Record<string, unknown> = {
          folio: despacho.folio,
          estado: destino,
          estadoAnterior: despacho.estado,
          ocurridoAt: ocurrido.toISOString(),
          motivo: b.motivo ?? null,
        };
        if (reanudando) payload.reanudadoDesde = base;
        // R30, the number the whole patio-regulador requirement is about: cité 10:00, entró 10:05.
        // Negative means early. Computed on write because `cita_at` is not stored per event.
        if (destino === 'en_patio' && despacho.cita_at) {
          payload.citaAt = new Date(despacho.cita_at).toISOString();
          payload.demoraMin = minutosEntre(new Date(despacho.cita_at), ocurrido);
        }
        if (destino === 'cargado' && despacho.inicio_carga_at) {
          payload.tiempoCargaMin = minutosEntre(new Date(despacho.inicio_carga_at), ocurrido);
        }

        const { eventos, operacionIds } = await registrarEventoDespacho(q, {
          despachoId: id,
          tipo: destino === 'cancelado' ? 'DESPACHO_CANCELADO' : 'DESPACHO_ESTADO',
          payload,
          userId,
          origen: req.user!.role === 'tramitador' ? 'tramitador' : 'coordinador',
          ocurridoAt: ocurrido,
          motivo: b.motivo ?? null,
        });

        return { kind: 'ok' as const, despacho, payload, eventos, operacionIds };
      });

      switch (resultado.kind) {
        case 'no_encontrado':
          res.status(404).json({ error: 'Despacho no encontrado' });
          return;
        case 'noop':
          // 200 with `noop`, same contract as the field buttons: a retry is not an error.
          res.json({ ok: true, noop: true, estado: resultado.estado });
          return;
        case 'transicion_invalida':
          res.status(409).json({
            error:
              resultado.estado === 'en_espera'
                ? `El despacho está en espera desde '${resultado.base}'; no puede reanudarse hacia '${resultado.destino}', que quedó atrás.`
                : `El despacho no puede pasar de '${resultado.estado}' a '${resultado.destino}': el avance es monótono y la carga, una vez iniciada, ya no admite espera.`,
            estadoActual: resultado.estado,
          });
          return;
        default:
          break;
      }

      await recordAudit({
        userId,
        action: destino === 'cancelado' ? 'DESPACHO_CANCELADO' : 'DESPACHO_ESTADO',
        entity: 'despacho',
        entityId: id,
        after: { ...resultado.payload, operacionesAfectadas: resultado.operacionIds.length },
        ip: req.ip,
      });

      res.status(201).json({
        ok: true,
        despachoId: id,
        ...resultado.payload,
        eventosRegistrados: resultado.eventos,
      });
    } catch (err) {
      next(err);
    }
  },
);

// =================================================================================================
// CT-7 / D10 — reasignación anti-flete-en-falso
// =================================================================================================

/**
 * POST /api/despachos/:id/reasignar — move the contracted unit onto other cargo.
 *
 * THE PROBLEM IT SOLVES, in the meeting's own terms: a flight slips fourteen hours, the tracto is
 * already contracted, and cancelling it means paying for a truck that carried nothing — a *flete en
 * falso*. D10's answer is to reassign rather than cancel. This endpoint is that move: the original
 * trip is cancelled, and a NEW trip inherits the carrier, the unit, the plates and the agreed rate,
 * pointing back at its predecessor through `reasignado_de_despacho_id`.
 *
 * IT IS THE ONLY OVERRIDE IN THIS FILE, and deliberately so (§8.8 / D6 / R20). The contingency
 * engine may execute exclusions, reschedules, holds and notifications by itself; anything that
 * commits spend it may only PROPOSE. So `motivo` is mandatory, every ledger event it writes carries
 * `override = true`, and the audit row names the human. Automating the decision without recording
 * who approved it is exactly the trace the authority would ask for and we would not have.
 *
 * The new trip starts EMPTY unless `copiarPartidas` is set. Reassignment usually happens precisely
 * because the original cargo is not coming, so carrying the load over by default would recreate the
 * problem it exists to solve.
 */
despachosRouter.post(
  '/:id/reasignar',
  requireAuth,
  requireRole('admin', 'capturista'),
  validate({ params: despachoParam, body: despachoReasignarBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const b = req.body as DespachoReasignarBody;
      const userId = req.user!.userId;

      const resultado = await withTransaction(async (q: Q) => {
        // `fecha_operacion::text`: pg hands a DATE back as a JS Date, and stringifying that gives
        // 'Fri Aug 14 2026 …', which Postgres then refuses as a date literal. The text form is what
        // travels through the tariff lookup and into the new row.
        const d = await q(
          'SELECT *, fecha_operacion::text AS fecha_texto FROM despachos WHERE id = $1 FOR UPDATE',
          [id],
        );
        if (!d.rows.length) return { kind: 'no_encontrado' as const };
        const origen = d.rows[0] as Record<string, any>;
        if (origen.estado === 'entregado' || origen.estado === 'cancelado') {
          return { kind: 'estado_invalido' as const, estado: String(origen.estado) };
        }
        if (!origen.transportista_id) {
          return { kind: 'sin_transportista' as const };
        }

        const fecha = b.fechaOperacion ?? String(origen.fecha_texto);
        const direccionEntregaId = b.direccionEntregaId ?? origen.direccion_entrega_id ?? null;

        // Re-resolve the rate for the NEW destination and date. Inheriting the old amount unchanged
        // would be the one thing this endpoint must never do quietly: the point of the manoeuvre is
        // that the money moved, so the money has to be recomputed and shown.
        const tarifa = await resolverTarifa(q, {
          transportistaId: origen.transportista_id,
          tipoUnidad: origen.tipo_unidad,
          direccionEntregaId,
          fecha,
        });

        const folio = b.folio ?? (await siguienteFolio(q, fecha));
        const ins = await q(
          `INSERT INTO despachos
             (folio, fecha_operacion, tipo_unidad, transportista_id, unidad_id, placas,
              operador_nombre, direccion_entrega_id, cita_at, tarifa_id, tarifa_monto, moneda,
              reasignado_de_despacho_id, comentarios, created_by)
           VALUES ($1,$2::date,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           RETURNING id, folio, estado, fecha_operacion AS "fechaOperacion",
                     tipo_unidad AS "tipoUnidad", transportista_id AS "transportistaId",
                     unidad_id AS "unidadId", placas, direccion_entrega_id AS "direccionEntregaId",
                     tarifa_id AS "tarifaId", tarifa_monto AS "tarifaMonto", moneda,
                     reasignado_de_despacho_id AS "reasignadoDeDespachoId"`,
          [
            folio,
            fecha,
            origen.tipo_unidad,
            origen.transportista_id,
            origen.unidad_id,
            origen.placas,
            origen.operador_nombre,
            direccionEntregaId,
            b.citaAt ? new Date(b.citaAt) : origen.cita_at,
            tarifa?.id ?? null,
            tarifa?.tarifa ?? null,
            tarifa?.moneda ?? null,
            id,
            b.motivo,
            userId,
          ],
        );
        const nuevo = ins.rows[0];

        let partidasCopiadas = 0;
        if (b.copiarPartidas) {
          const cop = await q(
            `INSERT INTO despacho_partidas
               (despacho_id, operacion_id, operacion_guia_id, pedimento_id,
                cartones_planeados, piezas, orden_carga)
             SELECT $2, operacion_id, operacion_guia_id, pedimento_id,
                    cartones_planeados, piezas, orden_carga
               FROM despacho_partidas WHERE despacho_id = $1`,
            [id, nuevo.id],
          );
          partidasCopiadas = cop.rowCount ?? 0;
        }

        const deltaTarifa =
          origen.tarifa_monto != null && tarifa?.tarifa != null
            ? Number(tarifa.tarifa) - Number(origen.tarifa_monto)
            : null;

        const payload = {
          folioOrigen: origen.folio,
          folioNuevo: nuevo.folio,
          despachoNuevoId: nuevo.id,
          motivo: b.motivo,
          tarifaAnterior: origen.tarifa_monto,
          tarifaNueva: tarifa?.tarifa ?? null,
          // The number a human is confirming. Null when either side had no agreed rate — reported as
          // unknown rather than as zero, which would read as "no cost change".
          deltaTarifa,
          partidasCopiadas,
          efecto: 'Se reasigna la unidad ya contratada en vez de cancelarla (CT-7/D10, evitar flete en falso).',
        };

        // The ORIGINAL trip's casos are the ones whose plan just changed: they are the shipments that
        // are not going out on this unit. Written before the cancellation so the set is still there.
        const evOrigen = await registrarEventoDespacho(q, {
          despachoId: id,
          tipo: 'DESPACHO_REASIGNADO',
          payload,
          userId,
          override: true,
          motivo: b.motivo,
        });

        await q(`UPDATE despachos SET estado = 'cancelado' WHERE id = $1`, [id]);

        const evNuevo = b.copiarPartidas
          ? await registrarEventoDespacho(q, {
              despachoId: nuevo.id,
              tipo: 'DESPACHO_REASIGNADO',
              payload,
              userId,
              override: true,
              motivo: b.motivo,
            })
          : { eventos: 0, operacionIds: [] as string[] };

        return {
          kind: 'ok' as const,
          nuevo,
          origen,
          payload,
          eventos: evOrigen.eventos + evNuevo.eventos,
        };
      });

      switch (resultado.kind) {
        case 'no_encontrado':
          res.status(404).json({ error: 'Despacho no encontrado' });
          return;
        case 'estado_invalido':
          res.status(409).json({
            error: `El despacho está en estado '${resultado.estado}' y ya no se puede reasignar.`,
          });
          return;
        case 'sin_transportista':
          res.status(409).json({
            error: 'No hay nada que reasignar: este despacho no tiene transportista contratado. Basta con cancelarlo.',
          });
          return;
        default:
          break;
      }

      await recordAudit({
        userId,
        action: 'DESPACHO_REASIGNADO',
        entity: 'despacho',
        entityId: resultado.nuevo.id,
        before: { despachoOrigenId: id, folio: resultado.origen.folio, tarifaMonto: resultado.origen.tarifa_monto },
        after: { ...resultado.payload, override: true },
        ip: req.ip,
      });

      res.status(201).json({
        ok: true,
        despachoOrigenId: id,
        ...resultado.nuevo,
        ...resultado.payload,
        eventosRegistrados: resultado.eventos,
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        res.status(409).json({ error: 'Ya existe un despacho con ese folio.' });
        return;
      }
      next(err);
    }
  },
);

// =================================================================================================
// R36 / D14 — arribo estimado contra arribo real
// =================================================================================================

/**
 * POST /api/despachos/:id/eta — compute the estimated arrival.
 *
 * IT REFUSES RATHER THAN GUESSES. If the delivery address has no coordinates, or the origin cannot
 * be resolved, the answer is a 409 that says which piece is missing — never a plausible number.
 * Discipline 6: what cannot be verified must say so. A fabricated ETA is worse than none because the
 * warehouse at the other end plans staff around it.
 *
 * The origin is resolved in three steps, most explicit first: coordinates in the body, then an IATA
 * code in the body, then the customs point the cargo actually arrived at, read from the casos on the
 * truck (`operaciones.destino_iata`). The estimator itself is pure, deterministic and version-stamped
 * (shared/operaciones/eta.ts); everything about how the number was produced is stored in `eta_calculo`
 * beside it, so a later reader can see the assumptions rather than inherit them.
 */
despachosRouter.post(
  '/:id/eta',
  requireAuth,
  requireRole('admin', 'capturista'),
  validate({ params: despachoParam, body: despachoEtaBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const b = req.body as DespachoEtaBody;
      const userId = req.user!.userId;

      const resultado = await withTransaction(async (q: Q) => {
        const d = await q(
          `SELECT d.id, d.folio, d.salida_at, d.estado,
                  cd.id AS "direccionId", cd.alias, cd.lat, cd.lng
             FROM despachos d
             LEFT JOIN client_direcciones cd ON cd.id = d.direccion_entrega_id
            WHERE d.id = $1 FOR UPDATE OF d`,
          [id],
        );
        if (!d.rows.length) return { kind: 'no_encontrado' as const };
        const row = d.rows[0] as {
          folio: string; salida_at: Date | null; direccionId: string | null;
          alias: string | null; lat: string | null; lng: string | null;
        };
        if (!row.direccionId) return { kind: 'sin_destino' as const };
        if (row.lat == null || row.lng == null) return { kind: 'sin_coordenadas' as const, alias: row.alias };

        let origen: { lat: number; lng: number } | null = null;
        let origenDescripcion: string | null = null;
        if (b.origenLat != null && b.origenLng != null) {
          origen = { lat: b.origenLat, lng: b.origenLng };
          origenDescripcion = 'coordenadas indicadas en la solicitud';
        } else {
          let iata = b.origenIata ?? null;
          if (!iata) {
            const o = await q(
              `SELECT o.destino_iata
                 FROM despacho_partidas p
                 JOIN operaciones o ON o.id = p.operacion_id
                WHERE p.despacho_id = $1 AND o.destino_iata IS NOT NULL
                LIMIT 1`,
              [id],
            );
            iata = o.rows[0]?.destino_iata ?? null;
          }
          const aduana = aduanaOrigen(iata);
          if (!aduana) return { kind: 'sin_origen' as const, iata };
          origen = { lat: aduana.lat, lng: aduana.lng };
          origenDescripcion = `${aduana.iata} — ${aduana.nombre}`;
        }

        const salida = b.salidaAt ? new Date(b.salidaAt) : (row.salida_at ?? new Date());
        const estimacion = estimarArribo({
          salida,
          origen,
          destino: { lat: Number(row.lat), lng: Number(row.lng) },
        });
        if (!estimacion) return { kind: 'no_estimable' as const };

        const calculo = {
          ...estimacion,
          origen: origenDescripcion,
          origenLat: origen.lat,
          origenLng: origen.lng,
          destino: row.alias,
          destinoLat: Number(row.lat),
          destinoLng: Number(row.lng),
          salidaAt: salida.toISOString(),
          calculadoAt: new Date().toISOString(),
        };

        await q(
          `UPDATE despachos SET eta_calculado = $2, eta_calculo = $3::jsonb WHERE id = $1`,
          [id, estimacion.etaCalculado, JSON.stringify(calculo)],
        );

        const { eventos } = await registrarEventoDespacho(q, {
          despachoId: id,
          tipo: 'ETA_CALCULADA',
          payload: {
            folio: row.folio,
            etaCalculado: estimacion.etaCalculado,
            minutosEstimados: estimacion.minutosEstimados,
            metodo: estimacion.metodo,
            rulesetVersion: estimacion.rulesetVersion,
            confianza: estimacion.confianza,
            origen: origenDescripcion,
            destino: row.alias,
          },
          userId,
          // 'sistema': the value came from a deterministic ruleset, not from a person's judgement.
          origen: 'sistema',
        });

        return { kind: 'ok' as const, folio: row.folio, calculo, estimacion, eventos };
      });

      switch (resultado.kind) {
        case 'no_encontrado':
          res.status(404).json({ error: 'Despacho no encontrado' });
          return;
        case 'sin_destino':
          res.status(409).json({
            error: 'El despacho no tiene dirección de entrega: sin destino no hay arribo que estimar (R38/D15).',
          });
          return;
        case 'sin_coordenadas':
          res.status(409).json({
            error: `La dirección de entrega '${resultado.alias ?? ''}' no tiene coordenadas. Sin lat/lng no se estima: preferimos no dar una hora inventada.`,
          });
          return;
        case 'sin_origen':
          res.status(409).json({
            error: `No se pudo resolver el punto de origen${resultado.iata ? ` ('${resultado.iata}' no está en el catálogo de aduanas)` : ''}. Indica \`origenIata\` o \`origenLat\`/\`origenLng\`.`,
          });
          return;
        case 'no_estimable':
          res.status(409).json({ error: 'No se pudo estimar el arribo con los datos disponibles.' });
          return;
        default:
          break;
      }

      await recordAudit({
        userId,
        action: 'ETA_CALCULADA',
        entity: 'despacho',
        entityId: id,
        after: { folio: resultado.folio, ...resultado.calculo },
        ip: req.ip,
      });

      res.status(201).json({
        ok: true,
        despachoId: id,
        etaCalculado: resultado.estimacion.etaCalculado,
        calculo: resultado.calculo,
        eventosRegistrados: resultado.eventos,
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /api/despachos/:id/arribo — the unit reached the client's site (R36 / D14).
 *
 * Writes `arribo_real` and NEVER touches `eta_calculado`. That separation is decision D14 in one
 * line: the estimate stays exactly as it was made, the observation is recorded beside it, and
 * `desviacionMin` — positive for late — is the number that has to be explained. Overwriting the
 * estimate would make every trip look perfectly predicted.
 *
 * It does not advance the estado to `entregado` either. Arriving at the gate is not delivery;
 * delivery is a signed POD (R39, backlog #30), and conflating them would let a truck that arrived
 * and was turned away read as a completed delivery.
 */
despachosRouter.post(
  '/:id/arribo',
  requireAuth,
  requireRole('admin', 'capturista', 'tramitador'),
  validate({ params: despachoParam, body: despachoArriboBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const b = req.body as DespachoArriboBody;
      const userId = req.user!.userId;
      const arribo = b.arriboAt ? new Date(b.arriboAt) : new Date();

      const resultado = await withTransaction(async (q: Q) => {
        const d = await q(
          'SELECT id, folio, estado, eta_calculado, arribo_real, salida_at FROM despachos WHERE id = $1 FOR UPDATE',
          [id],
        );
        if (!d.rows.length) return { kind: 'no_encontrado' as const };
        const row = d.rows[0] as {
          folio: string; estado: EstadoDespacho; eta_calculado: Date | null;
          arribo_real: Date | null; salida_at: Date | null;
        };
        if (row.estado === 'cancelado') return { kind: 'cancelado' as const };
        if (row.arribo_real) return { kind: 'ya_arribado' as const, arriboReal: row.arribo_real };

        await q('UPDATE despachos SET arribo_real = $2 WHERE id = $1', [id, arribo]);

        const desviacionMin = desviacionArriboMin(row.eta_calculado, arribo);
        const payload: Record<string, unknown> = {
          folio: row.folio,
          arriboReal: arribo.toISOString(),
          etaCalculado: row.eta_calculado ? new Date(row.eta_calculado).toISOString() : null,
          // Null, not 0, when there was no estimate: "on time" is not the answer to "we never
          // estimated it" (discipline 6).
          desviacionMin,
          transitoMin: row.salida_at ? minutosEntre(new Date(row.salida_at), arribo) : null,
          motivo: b.motivo ?? null,
        };

        const { eventos } = await registrarEventoDespacho(q, {
          despachoId: id,
          tipo: 'ARRIBO_DESTINO',
          payload,
          userId,
          origen: req.user!.role === 'tramitador' ? 'tramitador' : 'coordinador',
          ocurridoAt: arribo,
        });

        return { kind: 'ok' as const, payload, eventos };
      });

      switch (resultado.kind) {
        case 'no_encontrado':
          res.status(404).json({ error: 'Despacho no encontrado' });
          return;
        case 'cancelado':
          res.status(409).json({ error: 'El despacho está cancelado: no puede registrar un arribo.' });
          return;
        case 'ya_arribado':
          res.status(409).json({
            error: 'El arribo ya estaba registrado; corregirlo borraría la hora observada original.',
            arriboReal: resultado.arriboReal,
          });
          return;
        default:
          break;
      }

      await recordAudit({
        userId,
        action: 'ARRIBO_DESTINO',
        entity: 'despacho',
        entityId: id,
        after: resultado.payload,
        ip: req.ip,
      });

      res.status(201).json({ ok: true, despachoId: id, ...resultado.payload, eventosRegistrados: resultado.eventos });
    } catch (err) {
      next(err);
    }
  },
);

// =================================================================================================
// Trazabilidad — la dirección carga → transportista (R29)
// =================================================================================================

/**
 * A SECOND ROUTER, mounted on `/api/operaciones` (see app.ts).
 *
 * The despacho endpoints live under their own prefix precisely because a trip is NOT a property of
 * one caso: one unit carries several clients' cargo (R29), and nesting it under a single operación
 * would have made the multi-client truck impossible to express. But the reverse question — "which
 * unit took MY guías out, and with whom?" — is asked FROM a caso, one shipment at a time, by the
 * same person reading its timeline. Same reasoning as the ledger events landing on every caso riding
 * on the unit: six weeks later nobody knows which folio to look up, they know their MAWB.
 */
export const operacionDespachosRouter = Router();

/**
 * GET /api/operaciones/:id/despachos — every trip that carried any guía of this caso.
 *
 * ONE AGGREGATE QUERY. `partidas` is built with `json_agg` filtered to THIS operación, so a truck
 * shared with two other clients shows only this caso's guías — the others are somebody else's cargo
 * and this is a per-caso read. `partidasTotales` counts the whole load beside it, because "your two
 * guías travelled on a truck that carried nine" is the fact that explains a delay at the dock, and
 * hiding it would leave the reader with a number that does not match what they saw leave.
 *
 * A caso whose guías went out on two different trips (a split load, or a reschedule after CT-7)
 * returns both, newest operating day first. An empty array is a real answer — "nothing of this caso
 * has been loaded onto a unit yet" — not a 404.
 */
operacionDespachosRouter.get(
  '/:id/despachos',
  requireAuth,
  validate({ params: operacionIdParam }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;

      const op = await query<{ mawb: string }>('SELECT mawb FROM operaciones WHERE id = $1', [id]);
      if (!op.rows.length) {
        res.status(404).json({ error: 'Operación no encontrada' });
        return;
      }

      const { rows } = await query<{
        id: string;
        tipoUnidad: string;
        transportistaId: string | null;
        etaCalculado: Date | null;
        arriboReal: Date | null;
        partidas: Array<Record<string, unknown>>;
      }>(
        `SELECT ${SELECT_DESPACHO},
                (SELECT count(*)::int FROM despacho_partidas dp WHERE dp.despacho_id = d.id)
                  AS "partidasTotales",
                json_agg(
                  json_build_object(
                    'id', p.id,
                    'operacionGuiaId', p.operacion_guia_id,
                    'guia', g.guia_norm,
                    'guiaEstado', g.estado,
                    'cliente', c.name,
                    'pedimentoId', p.pedimento_id,
                    'piezas', p.piezas,
                    'cartonesPlaneados', p.cartones_planeados,
                    'cartonesCargados', p.cartones_cargados,
                    'ordenCarga', p.orden_carga
                  ) ORDER BY p.orden_carga NULLS LAST, p.created_at
                ) AS partidas
         ${FROM_DESPACHO}
           JOIN despacho_partidas p ON p.despacho_id = d.id AND p.operacion_id = $1
           JOIN operaciones o ON o.id = p.operacion_id
           LEFT JOIN operacion_guias g ON g.id = p.operacion_guia_id
           LEFT JOIN clients c ON c.id = COALESCE(g.client_id, o.client_id)
          GROUP BY d.id, t.id, cd.id
          ORDER BY d.fecha_operacion DESC, d.folio`,
        [id],
      );

      const transportistas = new Set(rows.map((r) => r.transportistaId).filter(Boolean));
      res.json({
        operacionId: id,
        mawb: op.rows[0].mawb,
        totales: {
          despachos: rows.length,
          transportistas: transportistas.size,
          partidas: rows.reduce((acc, r) => acc + r.partidas.length, 0),
        },
        despachos: rows.map((r) => ({
          ...r,
          tipoUnidadLabel: etiquetaTipoUnidad(r.tipoUnidad),
          desviacionArriboMin: desviacionArriboMin(r.etaCalculado, r.arriboReal),
        })),
      });
    } catch (err) {
      next(err);
    }
  },
);
