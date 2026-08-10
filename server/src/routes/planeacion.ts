import { Router, type Request, type Response, type NextFunction } from 'express';
import { query } from '../db/pool';
import { withTransaction } from '../db/tx';
import { isUniqueViolation } from '../db/errors';
import { requireAuth, requireRole } from '../auth/middleware';
import { recordAudit } from '../services/audit';
import { validate } from '../validation/middleware';
import {
  planFechaQuery,
  planPublicacionParam,
  planPublicarBody,
  type PlanPublicarBody,
} from '../validation/schemas';
import {
  diffPlan,
  resumenDiff,
  type PlanDespachoSnapshot,
  type PlanExclusionSnapshot,
  type PlanSnapshot,
} from '../../../shared/operaciones/plan';
import {
  GUIA_ESTADOS_DESPACHABLES,
  GUIA_ESTADOS_NO_DESPACHABLES,
} from '../../../shared/operaciones/catalogos';
import {
  contactosDeRol,
  enviarNotificaciones,
  resumirEnvios,
  type EnvioResultado,
} from '../services/notificaciones';
import { avisarInternoPorEvento } from '../services/whatsappFanout';

/**
 * PLANEACIÓN — the living plan (PRD-02 R13, R14, R16, R19, principle P4).
 *
 * WHAT IS BEING REPLACED. The day's programme is an Excel workbook mailed to the warehouse, the
 * transportista and the client. Change anything and a second workbook goes out; from that moment
 * nobody in the chain can prove which version they are working from, and the warehouse stages cargo
 * against one file while the carrier quotes another. The meeting's phrase was "sustituye el Excel
 * corrigiendo al Excel" — keep the document, version it, and ship the DELTA rather than asking three
 * organisations to diff two spreadsheets by eye.
 *
 * THE PLAN IS A SNAPSHOT, NOT A QUERY. `POST /publicar` freezes the day into `plan_publicaciones` as
 * a flat, human-shaped document: folios, plates, guías, client names. A published plan is a statement
 * made to third parties at a moment in time, so re-opening version 3 next month has to show what was
 * actually sent — a view over live tables would silently re-answer the question against today's rows.
 *
 * EXCLUSIONS ARE PART OF THE DOCUMENT, WITH THEIR CAUSE. This is the piece the spreadsheet never had
 * and the reason `GET /` returns them alongside the plan. A caso that is not on today's programme is
 * either blocked (a hold: CT-3/CT-4/CT-6), carrying cargo that must not be declared as leaving (a
 * guía `retenida`/`no_transmitida`/`csa_pendiente`: CT-2/CT-5), or simply not ready — and the
 * difference decides who has to do something about it. Publishing the causes is what turns "it's not
 * on the list" into an answerable question, and it is what feeds R16, the search for a replacement.
 *
 * ELIGIBILITY IS DELIBERATELY PERMISSIVE ON THE PHYSICAL AXIS. A caso still in the air is eligible
 * for TOMORROW's plan — that is the entire point of planning the day before (R13). What excludes a
 * caso is a hold or a guía state, never its etapa, because etapa describes where the cargo is and
 * planning is about where it is going.
 */
export const planeacionRouter = Router();

type Q = (text: string, params?: unknown[]) => Promise<any>;

/** Serializes version minting per operating day. `(fecha, version)` UNIQUE is the backstop. */
const LOCK_PLAN_PUBLICACION = 5100001;

function hoyISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Casos that are done with; nothing about them belongs on a forward-looking plan. */
const ETAPAS_CERRADAS = "('entregado','cerrada','cancelada')";

/**
 * Build the day's document from the live tables.
 *
 * Returns the exact structure that gets stored in `plan_publicaciones.snapshot`, so what `GET /`
 * shows on screen and what `POST /publicar` freezes are the same object built by the same code —
 * there is no second rendering that could disagree with the published one.
 */
async function construirSnapshot(q: Q, fecha: string): Promise<PlanSnapshot> {
  const despachos = await q(
    `SELECT d.id,
            d.folio,
            d.tipo_unidad      AS "tipoUnidad",
            t.razon_social     AS "transportista",
            d.placas,
            d.operador_nombre  AS "operadorNombre",
            cd.alias           AS "destino",
            d.estado,
            d.cita_at          AS "citaAt"
       FROM despachos d
       LEFT JOIN transportistas t ON t.id = d.transportista_id
       LEFT JOIN client_direcciones cd ON cd.id = d.direccion_entrega_id
      WHERE d.fecha_operacion = $1::date
        AND d.estado <> 'cancelado'
      ORDER BY d.folio`,
    [fecha],
  );

  const partidas = await q(
    `SELECT p.despacho_id       AS "despachoId",
            COALESCE(g.guia_norm, o.mawb) AS guia,
            o.mawb,
            c.name              AS cliente,
            p.cartones_planeados AS cartones,
            p.piezas,
            p.orden_carga       AS "ordenCarga"
       FROM despacho_partidas p
       JOIN despachos d ON d.id = p.despacho_id
       JOIN operaciones o ON o.id = p.operacion_id
       LEFT JOIN operacion_guias g ON g.id = p.operacion_guia_id
       LEFT JOIN clients c ON c.id = COALESCE(g.client_id, o.client_id)
      WHERE d.fecha_operacion = $1::date AND d.estado <> 'cancelado'
      ORDER BY p.orden_carga NULLS LAST, p.created_at`,
    [fecha],
  );

  const porDespacho = new Map<string, PlanDespachoSnapshot['partidas']>();
  for (const p of partidas.rows as Array<Record<string, any>>) {
    const lista = porDespacho.get(p.despachoId) ?? [];
    lista.push({
      guia: String(p.guia),
      mawb: String(p.mawb),
      cliente: p.cliente ?? null,
      cartones: p.cartones ?? null,
      piezas: p.piezas ?? null,
      ordenCarga: p.ordenCarga ?? null,
    });
    porDespacho.set(p.despachoId, lista);
  }

  /**
   * The exclusions, with their cause. Two sources, deliberately kept apart because they are two
   * different problems for two different people: a hold is an office/authority matter, a guía state
   * is a transmission or a retention on the dock.
   */
  const holds = await q(
    `SELECT o.mawb,
            NULL::text AS guia,
            'hold_activo' AS causa,
            (SELECT string_agg(h.tipo || ': ' || h.motivo, ' | ')
               FROM operacion_holds h
              WHERE h.activo AND (h.operacion_id IS NULL OR h.operacion_id = o.id)) AS detalle
       FROM operaciones o
      WHERE o.hold_activo
        AND o.etapa NOT IN ${ETAPAS_CERRADAS}
      ORDER BY o.mawb`,
  );

  // The "cannot leave today" list is the shared vocabulary (shared/operaciones/catalogos.ts), the
  // same one routes/despachos.ts refuses on and REPLAN_RULESET reasons with — passed as a parameter
  // so the plan's exclusions and the dispatch endpoint can never disagree about which guías are out.
  const guias = await q(
    `SELECT o.mawb,
            g.guia_norm AS guia,
            'guia_' || g.estado AS causa,
            NULL::text AS detalle
       FROM operacion_guias g
       JOIN operaciones o ON o.id = g.operacion_id
      WHERE g.estado = ANY($1::text[])
        AND o.etapa NOT IN ${ETAPAS_CERRADAS}
        AND NOT o.hold_activo
      ORDER BY o.mawb, g.guia_norm`,
    [[...GUIA_ESTADOS_NO_DESPACHABLES]],
  );

  const exclusiones: PlanExclusionSnapshot[] = [...holds.rows, ...guias.rows].map((r: Record<string, any>) => ({
    mawb: String(r.mawb),
    guia: r.guia ?? null,
    causa: String(r.causa),
    detalle: r.detalle ?? null,
  }));

  return {
    fechaOperacion: fecha,
    generadoAt: new Date().toISOString(),
    despachos: (despachos.rows as Array<Record<string, any>>).map((d) => ({
      folio: String(d.folio),
      tipoUnidad: String(d.tipoUnidad),
      transportista: d.transportista ?? null,
      placas: d.placas ?? null,
      operadorNombre: d.operadorNombre ?? null,
      destino: d.destino ?? null,
      estado: String(d.estado),
      citaAt: d.citaAt ? new Date(d.citaAt).toISOString() : null,
      partidas: porDespacho.get(d.id) ?? [],
    })),
    exclusiones,
  };
}

/**
 * GET /api/planeacion?fecha= — the working view of the day.
 *
 * Adds `elegibles` to the snapshot: open casos with at least one loadable guía that is not yet on a
 * unit for this date. That is the planner's actual worklist, and it is computed rather than stored
 * because it changes every time a hold closes, a manifest arrives or a truck is filled.
 *
 * Open to every authenticated role including `autoridad`: the plan and, above all, its exclusions
 * with causes are precisely what an authority asks to see.
 */
planeacionRouter.get(
  '/',
  requireAuth,
  validate({ query: planFechaQuery }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const fecha = (req.query.fecha as string | undefined) ?? hoyISO();

      const snapshot = await construirSnapshot(
        (text, params) => query(text, params as unknown[]),
        fecha,
      );

      const elegibles = await query(
        `SELECT o.id            AS "operacionId",
                o.mawb,
                o.etapa,
                o.eta_pais      AS "etaPais",
                c.name          AS cliente,
                g.id            AS "operacionGuiaId",
                g.guia_norm     AS guia,
                g.cartones,
                g.piezas
           FROM operaciones o
           JOIN operacion_guias g ON g.operacion_id = o.id
           LEFT JOIN clients c ON c.id = COALESCE(g.client_id, o.client_id)
          WHERE o.etapa NOT IN ${ETAPAS_CERRADAS}
            AND NOT o.hold_activo
            AND g.estado = ANY($2::text[])
            AND NOT EXISTS (
              SELECT 1 FROM despacho_partidas p
                JOIN despachos d ON d.id = p.despacho_id
               WHERE p.operacion_guia_id = g.id
                 AND d.fecha_operacion = $1::date
                 AND d.estado <> 'cancelado')
          ORDER BY o.eta_pais NULLS LAST, o.mawb, g.guia_norm
          LIMIT 500`,
        [fecha, [...GUIA_ESTADOS_DESPACHABLES]],
      );

      const ultima = await query(
        `SELECT id, version, publicado_at AS "publicadoAt"
           FROM plan_publicaciones WHERE fecha_operacion = $1::date
          ORDER BY version DESC LIMIT 1`,
        [fecha],
      );

      res.json({
        ...snapshot,
        elegibles: elegibles.rows,
        ultimaPublicacion: ultima.rows[0] ?? null,
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * The message a published plan sends (R19 / N5).
 *
 * SPANISH, and deliberately so: the recipients of a plan are the warehouse, the transportista and the
 * coordination desk — Mexican operations staff. (The English rule, `N6`, is about messages to the
 * CLIENT, who is mostly Chinese; `requerimientosService.ts` writes those.)
 *
 * IT CARRIES THE DELTA, NOT THE DOCUMENT. That is the entire replacement for the second emailed
 * workbook: "sustituye el Excel corrigiendo al Excel" only works if the recipient is told what
 * CHANGED, with the reason, and can then open the version to see the rest. Pasting a whole day's plan
 * into an email or a WhatsApp message reproduces the problem — three organisations diffing two
 * documents by eye.
 *
 * Exported so the wording, which is what three organisations actually act on, is testable without an
 * SMTP server or a WhatsApp session.
 */
export function construirAvisoPublicacion(args: {
  fechaOperacion: string;
  version: number;
  motivo: string | null;
  resumen: string;
  snapshot: PlanSnapshot;
}): { asunto: string; texto: string } {
  const asunto = `Plan de despacho ${args.fechaOperacion} — versión ${args.version}`;
  const texto = [
    args.version === 1
      ? `Se publicó el plan de despacho del ${args.fechaOperacion}.`
      : `Se publicó la versión ${args.version} del plan de despacho del ${args.fechaOperacion}. ` +
        'Esta versión SUSTITUYE a la anterior.',
    ...(args.motivo ? ['', `Motivo: ${args.motivo}`] : []),
    '',
    `Cambios: ${args.resumen}`,
    '',
    `Despachos programados: ${args.snapshot.despachos.length}. ` +
      `Operaciones excluidas: ${args.snapshot.exclusiones.length}.`,
    ...(args.snapshot.exclusiones.length
      ? [
          '',
          'Exclusiones (y su causa):',
          // Capped: the point of the message is that something changed and here is where to look, not
          // to reproduce the document. The full list is on the published version.
          ...args.snapshot.exclusiones
            .slice(0, 10)
            .map((e) => `- ${e.mawb}${e.guia ? ` / ${e.guia}` : ''}: ${e.causa}${e.detalle ? ` (${e.detalle})` : ''}`),
          ...(args.snapshot.exclusiones.length > 10
            ? [`- … y ${args.snapshot.exclusiones.length - 10} más.`]
            : []),
        ]
      : []),
    '',
    'La versión completa, con folios, placas y orden de carga, está en el sistema de operaciones.',
  ].join('\n');
  return { asunto, texto };
}

/**
 * Deliver the published plan to the people who have to act on it. NEVER throws.
 *
 * WHO GETS IT. The explicit `destinatarios` on the request — the coordinator naming this
 * publication's audience — PLUS the standing `almacen` and `coordinacion` rosters
 * (`services/notificaciones.ts`), because those two always need the day's plan and requiring somebody
 * to retype them on every publication is how a warehouse stops being told. Duplicates collapse.
 *
 * The internal `dirección` ping goes through `whatsappFanout.ts` on the ledger-event path instead, so
 * the plan change reads there exactly like the freeze events it sits beside.
 */
async function fanOutPublicacion(args: {
  destinatarios: string[];
  fechaOperacion: string;
  version: number;
  motivo: string | null;
  resumen: string;
  snapshot: PlanSnapshot;
}): Promise<EnvioResultado[]> {
  try {
    const mensaje = construirAvisoPublicacion(args);
    const destinos = [...args.destinatarios, ...contactosDeRol('almacen'), ...contactosDeRol('coordinacion')];
    const envios = destinos.length ? await enviarNotificaciones(destinos, mensaje) : [];
    if (!destinos.length) {
      console.warn(
        `[planeacion] plan ${args.fechaOperacion} v${args.version} publicado SIN destinatarios — ` +
          'no se avisó a nadie (ni lista explícita ni NOTIFICACION_ALMACEN/NOTIFICACION_COORDINACION).',
      );
    }
    // Best-effort, exactly like the AGORA mirror: the publication already committed.
    await avisarInternoPorEvento({
      tipo: 'PLAN_PUBLICADO',
      payloadResumen: {
        fechaOperacion: args.fechaOperacion,
        version: args.version,
        motivo: args.motivo,
        resumen: args.resumen,
      },
    });
    return envios;
  } catch (err) {
    console.warn('[planeacion] falló el fan-out de la publicación:', err);
    return [];
  }
}

/**
 * POST /api/planeacion/publicar — mint version n+1 with its diff (R19 / P4).
 *
 * `motivo` is required from version 2 onward and NOT for version 1. Version 1 is simply the plan;
 * every republication is a correction somebody in the chain has to act on, and a plan that changed
 * for no stated reason is the Excel problem with better storage.
 *
 * A no-change republication is refused (409) rather than silently versioned. Publishing an identical
 * document trains three organisations to ignore the notification, which costs exactly the attention
 * the versioning exists to buy.
 *
 * Every caso on the plan gets a PLAN_PUBLICADO event on its own timeline in the same transaction —
 * the table is the convenience copy of the document, the append-only ledger is the record.
 */
planeacionRouter.post(
  '/publicar',
  requireAuth,
  requireRole('admin', 'capturista'),
  validate({ body: planPublicarBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const b = req.body as PlanPublicarBody;
      const userId = req.user!.userId;

      const resultado = await withTransaction(async (q: Q) => {
        const compacta = Number(b.fechaOperacion.replace(/-/g, '').slice(2));
        await q('SELECT pg_advisory_xact_lock($1, $2)', [LOCK_PLAN_PUBLICACION, compacta]);

        const previa = await q(
          `SELECT id, version, snapshot FROM plan_publicaciones
            WHERE fecha_operacion = $1::date ORDER BY version DESC LIMIT 1`,
          [b.fechaOperacion],
        );
        const anterior = (previa.rows[0]?.snapshot as PlanSnapshot | undefined) ?? null;
        const version = (previa.rows[0]?.version as number | undefined ?? 0) + 1;

        if (version > 1 && !(b.motivo ?? '').trim()) return { kind: 'sin_motivo' as const, version };

        const snapshot = await construirSnapshot(q, b.fechaOperacion);
        if (!snapshot.despachos.length && version === 1) return { kind: 'plan_vacio' as const };

        const diff = diffPlan(anterior, snapshot);
        if (diff.sinCambios) return { kind: 'sin_cambios' as const, version: version - 1 };

        const ins = await q(
          `INSERT INTO plan_publicaciones
             (fecha_operacion, version, snapshot, diff, motivo, publicado_por, destinatarios)
           VALUES ($1::date,$2,$3::jsonb,$4::jsonb,$5,$6,$7::jsonb)
           RETURNING id, version, publicado_at AS "publicadoAt"`,
          [
            b.fechaOperacion,
            version,
            JSON.stringify(snapshot),
            version === 1 ? null : JSON.stringify(diff),
            b.motivo ?? null,
            userId,
            b.destinatarios ? JSON.stringify(b.destinatarios) : null,
          ],
        );
        const publicacion = ins.rows[0];

        // One event per caso on the plan. `string_agg`-style bulk insert, same shape as the global
        // hold: the plan is asked about one shipment at a time.
        const { rowCount } = await q(
          `INSERT INTO operacion_eventos
             (operacion_id, operacion_mawb, despacho_id, tipo, origen, ocurrido_at, payload, created_by)
           SELECT DISTINCT ON (o.id)
                  o.id, o.mawb, d.id, 'PLAN_PUBLICADO', 'coordinador', now(),
                  jsonb_build_object(
                    'fechaOperacion', $1::text,
                    'version', $2::int,
                    'publicacionId', $3::uuid,
                    'folio', d.folio,
                    'motivo', $4::text,
                    'resumen', $5::text
                  ),
                  $6
             FROM despacho_partidas p
             JOIN despachos d ON d.id = p.despacho_id
             JOIN operaciones o ON o.id = p.operacion_id
            WHERE d.fecha_operacion = $1::date AND d.estado <> 'cancelado'`,
          [
            b.fechaOperacion,
            version,
            publicacion.id,
            b.motivo ?? null,
            resumenDiff(diff),
            userId,
          ],
        );

        return { kind: 'ok' as const, publicacion, snapshot, diff, eventos: rowCount ?? 0 };
      });

      switch (resultado.kind) {
        case 'sin_motivo':
          res.status(400).json({
            error: `La versión ${resultado.version} del plan requiere \`motivo\`: una republicación sin razón declarada es el problema del Excel con mejor almacenamiento.`,
          });
          return;
        case 'plan_vacio':
          res.status(409).json({
            error: 'No hay despachos programados para esa fecha: no hay plan que publicar.',
          });
          return;
        case 'sin_cambios':
          res.status(409).json({
            error: `El plan no cambió respecto de la versión ${resultado.version}. Publicar un documento idéntico enseña a los destinatarios a ignorar el aviso.`,
            version: resultado.version,
          });
          return;
        default:
          break;
      }

      // ---- R19 / N5 — the fan-out, AFTER the commit and never before it.
      //
      // The published version is the fact; telling people is the consequence of the fact. Sending
      // inside the transaction would mean a rollback after a message went out — three organisations
      // holding a version of the plan this system says was never published.
      const envios = await fanOutPublicacion({
        destinatarios: b.destinatarios ?? [],
        fechaOperacion: b.fechaOperacion,
        version: resultado.publicacion.version,
        motivo: b.motivo ?? null,
        resumen: resumenDiff(resultado.diff),
        snapshot: resultado.snapshot,
      });
      const resumenEnvios = resumirEnvios(envios);

      await recordAudit({
        userId,
        action: 'PLAN_PUBLICADO',
        entity: 'plan_publicacion',
        entityId: resultado.publicacion.id,
        after: {
          fechaOperacion: b.fechaOperacion,
          version: resultado.publicacion.version,
          motivo: b.motivo ?? null,
          destinatarios: b.destinatarios ?? null,
          despachos: resultado.snapshot.despachos.length,
          exclusiones: resultado.snapshot.exclusiones.length,
          resumen: resumenDiff(resultado.diff),
          // What ACTUALLY went out, per recipient, in the same row that records the publication. The
          // audit answers "was the warehouse told?" without a second system to consult.
          notificacion: { ...resumenEnvios, detalle: envios },
        },
        ip: req.ip,
      });

      res.status(201).json({
        ok: true,
        id: resultado.publicacion.id,
        fechaOperacion: b.fechaOperacion,
        version: resultado.publicacion.version,
        publicadoAt: resultado.publicacion.publicadoAt,
        resumen: resumenDiff(resultado.diff),
        diff: resultado.diff,
        snapshot: resultado.snapshot,
        eventosRegistrados: resultado.eventos,
        // Real per-recipient outcomes (#22 + #31), not a promise. Four counts and a detail list,
        // because "the plan went out" is not a statement this system can make when two of five
        // recipients were skipped for want of SMTP — and the screen has to be able to say so.
        notificacion: { ...resumenEnvios, detalle: envios },
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        res.status(409).json({
          error: 'Otra publicación tomó esa versión al mismo tiempo. Vuelve a intentar.',
        });
        return;
      }
      next(err);
    }
  },
);

/**
 * GET /api/planeacion/publicaciones?fecha= — the version history.
 *
 * Snapshots are omitted from the list (they are large and the list is a chooser) but the DIFF of
 * every version is included: the history of what changed is the point of keeping versions at all.
 */
planeacionRouter.get(
  '/publicaciones',
  requireAuth,
  validate({ query: planFechaQuery }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const fecha = req.query.fecha as string | undefined;
      const { rows } = await query(
        `SELECT p.id,
                p.fecha_operacion AS "fechaOperacion",
                p.version,
                p.diff,
                p.motivo,
                p.destinatarios,
                p.publicado_at    AS "publicadoAt",
                u.username        AS "publicadoPor",
                jsonb_array_length(COALESCE(p.snapshot->'despachos', '[]'::jsonb))   AS "despachos",
                jsonb_array_length(COALESCE(p.snapshot->'exclusiones', '[]'::jsonb)) AS "exclusiones"
           FROM plan_publicaciones p
           LEFT JOIN users u ON u.id = p.publicado_por
          WHERE ($1::date IS NULL OR p.fecha_operacion = $1::date)
          ORDER BY p.fecha_operacion DESC, p.version DESC
          LIMIT 200`,
        [fecha ?? null],
      );
      res.json(rows);
    } catch (err) {
      next(err);
    }
  },
);

/** GET /api/planeacion/publicaciones/:id — one published version, exactly as it went out. */
planeacionRouter.get(
  '/publicaciones/:id',
  requireAuth,
  validate({ params: planPublicacionParam }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { rows } = await query(
        `SELECT p.id,
                p.fecha_operacion AS "fechaOperacion",
                p.version,
                p.snapshot,
                p.diff,
                p.motivo,
                p.destinatarios,
                p.publicado_at    AS "publicadoAt",
                u.username        AS "publicadoPor"
           FROM plan_publicaciones p
           LEFT JOIN users u ON u.id = p.publicado_por
          WHERE p.id = $1`,
        [req.params.id],
      );
      if (!rows.length) {
        res.status(404).json({ error: 'Publicación no encontrada' });
        return;
      }
      res.json(rows[0]);
    } catch (err) {
      next(err);
    }
  },
);
