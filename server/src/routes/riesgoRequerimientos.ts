import { Router, type Request, type Response, type NextFunction } from 'express';
import { query } from '../db/pool';
import { withTransaction } from '../db/tx';
import { requireAuth, requireRole } from '../auth/middleware';
import { recordAudit } from '../services/audit';
import { mirrorEventoToAgora } from '../services/agoraMirror';
import { validate } from '../validation/middleware';
import {
  operacionIdParam,
  requerimientoCancelarBody,
  requerimientoEmitirBody,
  requerimientoIdParam,
  requerimientoListaQuery,
  requerimientoResolverBody,
  type RequerimientoCancelarBody,
  type RequerimientoEmitirBody,
  type RequerimientoListaQuery,
  type RequerimientoResolverBody,
} from '../validation/schemas';
import {
  calcularVenceAt,
  notificarRequerimiento,
  ventanaHorasPorDefecto,
} from '../services/requerimientosService';

/**
 * RIESGO REQUERIMIENTOS — risk findings turned into an obligation with a clock (PRD-02 `R18`/`D13`).
 *
 * PRD-01's risk engine has always produced findings. What it could not do was MAKE SOMEBODY ANSWER
 * THEM. This router is that step: a coordinator emits a requerimiento quoting the engine's own
 * `ReasonCode[]` and the ruleset version that produced them, the client is told in English (`N6`)
 * with an explicit deadline (`eta_pais` + the offload window), and if the deadline passes unanswered
 * the tick freezes the cargo (`CT-4`, `services/requerimientosService.ts`).
 *
 * THE ONE RULE WORTH REPEATING: emission does NOT start the clock — notification does. `sendMail`
 * degrades to `omitido` while SMTP is unprovisioned (#22), the row records that, and the sweep
 * refuses to expire anything the client was never told about. So a 201 from this endpoint can
 * legitimately come back with `notificacion.estado = 'omitida'`, and the response says so out loud
 * rather than implying the client has been warned.
 *
 * WHAT RESOLUTION UNDOES. Resolving (or withdrawing) the last outstanding requerimiento lifts the
 * CT-4 hold this system opened — identified by `hold_id` on the row, never guessed from the tipo —
 * and walks `estado_documental` back to `riesgo_ok` (§8.4 allows `riesgo_vencido → riesgo_ok`, the
 * "resolución tardía aceptada" edge). A freeze whose reason is gone but which nobody can find to
 * close is the failure `routes/holds.ts` exists to prevent, so it is closed here, in the same
 * transaction, by id.
 *
 * It does NOT touch `estado_planeacion`, exclude the caso, or request units: that is the contingency
 * engine's job (§8.8), same boundary every other hold respects.
 *
 * ROUTING. Two routers because the resource is addressed two ways: per caso (`/api/operaciones/:id/
 * riesgo-requerimientos`, which shares a prefix with `operacionesRouter`'s `GET /:id` and therefore
 * validates every `:id` as a UUID, exactly like holds.ts) and per requerimiento
 * (`/api/riesgo-requerimientos/...`, the work queue the control tower reads).
 */
export const operacionRequerimientosRouter = Router();
export const riesgoRequerimientosRouter = Router();

type Q = (text: string, params?: unknown[]) => Promise<any>;

/** Ledger row. `origen` is 'coordinador' for human acts and 'sistema' for the sweep's expiry. */
async function registrarEvento(
  q: Q,
  args: {
    operacionId: string;
    mawb: string;
    tipo: string;
    payload: Record<string, unknown>;
    userId: string | null;
  },
): Promise<string> {
  const { rows } = await q(
    `INSERT INTO operacion_eventos
       (operacion_id, operacion_mawb, tipo, origen, ocurrido_at, payload, created_by)
     VALUES ($1,$2,$3,'coordinador',now(),$4,$5)
     RETURNING id`,
    [args.operacionId, args.mawb, args.tipo, JSON.stringify(args.payload), args.userId],
  );
  return String(rows[0].id);
}

/** The same absolute formula holds.ts uses — asks the table what is true, never toggles a flag. */
async function materializarHold(q: Q, operacionId: string): Promise<boolean> {
  const { rows } = await q(
    `UPDATE operaciones o
        SET hold_activo = EXISTS (
              SELECT 1 FROM operacion_holds h
               WHERE h.activo
                 AND (h.operacion_id IS NULL OR h.operacion_id = o.id))
      WHERE o.id = $1
      RETURNING o.hold_activo`,
    [operacionId],
  );
  return Boolean(rows[0]?.hold_activo);
}

interface CierreResultado {
  /** Requerimientos still outstanding on this caso after the one just closed. */
  pendientes: number;
  holdCerrado: string | null;
  holdActivo: boolean;
  estadoDocumental: string;
}

/**
 * The consequences of closing ONE requerimiento, applied only when it was the LAST one outstanding.
 *
 * Shared by `resolver` and `cancelar` because the operational effect is identical: the reason for the
 * freeze is gone. Gated on `pendientes === 0` because a caso with two findings and one answer is
 * still a caso with an unanswered finding — lifting the hold there would let cargo move on a
 * half-answered demand, which is worse than never having raised it.
 */
async function aplicarCierre(
  q: Q,
  args: { operacionId: string; mawb: string; holdId: string | null; userId: string },
): Promise<CierreResultado> {
  const pend = await q(
    `SELECT count(*)::int AS n
       FROM riesgo_requerimientos
      WHERE operacion_id = $1 AND estado IN ('abierto','vencido')`,
    [args.operacionId],
  );
  const pendientes = Number(pend.rows[0].n);

  let holdCerrado: string | null = null;
  if (pendientes === 0 && args.holdId) {
    const upd = await q(
      `UPDATE operacion_holds
          SET activo = false, cerrado_at = now(), cerrado_por = $2
        WHERE id = $1 AND activo
        RETURNING id, tipo, motivo`,
      [args.holdId, args.userId],
    );
    if (upd.rows.length) {
      holdCerrado = String(upd.rows[0].id);
      await registrarEvento(q, {
        operacionId: args.operacionId,
        mawb: args.mawb,
        tipo: 'HOLD_CERRADO',
        payload: {
          holdId: holdCerrado,
          tipoHold: String(upd.rows[0].tipo),
          alcance: 'operacion',
          motivo: String(upd.rows[0].motivo),
          origen: 'requerimiento de riesgo cerrado',
        },
        userId: args.userId,
      });
    }
  }

  const holdActivo = await materializarHold(q, args.operacionId);

  // §8.4: `riesgo_con_hallazgos → riesgo_ok` and the late-acceptance edge `riesgo_vencido → riesgo_ok`.
  // Narrowed to those two states so a caso that already reached `pedimento_generado` is never dragged
  // backwards by a piece of paperwork arriving late.
  let estadoDocumental: string;
  if (pendientes === 0) {
    const doc = await q(
      `UPDATE operaciones
          SET estado_documental = 'riesgo_ok'
        WHERE id = $1 AND estado_documental IN ('riesgo_con_hallazgos','riesgo_vencido')
        RETURNING estado_documental`,
      [args.operacionId],
    );
    estadoDocumental = doc.rows.length
      ? String(doc.rows[0].estado_documental)
      : String((await q('SELECT estado_documental FROM operaciones WHERE id = $1', [args.operacionId])).rows[0].estado_documental);
  } else {
    estadoDocumental = String(
      (await q('SELECT estado_documental FROM operaciones WHERE id = $1', [args.operacionId])).rows[0]
        .estado_documental,
    );
  }

  return { pendientes, holdCerrado, holdActivo, estadoDocumental };
}

/** Row shape returned to clients, camelCase by explicit alias per the house convention. */
const SELECT_REQUERIMIENTO = `
  SELECT r.id,
         r.operacion_id          AS "operacionId",
         o.mawb,
         r.operacion_guia_id     AS "operacionGuiaId",
         g.guia_norm             AS "guiaNorm",
         r.shipment_id           AS "shipmentId",
         r.reason_codes          AS "reasonCodes",
         r.ruleset_version       AS "rulesetVersion",
         r.ruleset_hash          AS "rulesetHash",
         r.detalle,
         r.estado,
         r.vence_at              AS "venceAt",
         r.ventana_horas         AS "ventanaHoras",
         r.eta_base              AS "etaBase",
         r.notificacion_estado   AS "notificacionEstado",
         r.notificado_at         AS "notificadoAt",
         r.destinatario_email    AS "destinatarioEmail",
         r.notificacion_detalle  AS "notificacionDetalle",
         r.notificacion_intentos AS "notificacionIntentos",
         r.resuelto_at           AS "resueltoAt",
         r.resuelto_por          AS "resueltoPor",
         ur.username             AS "resueltoPorUsuario",
         r.resolucion_nota       AS "resolucionNota",
         r.evidencia_file_id     AS "evidenciaFileId",
         r.vencido_at            AS "vencidoAt",
         r.hold_id               AS "holdId",
         r.created_by            AS "createdBy",
         uc.username             AS "createdByUsuario",
         r.created_at            AS "createdAt",
         CASE WHEN r.estado = 'abierto'
              THEN round(extract(epoch FROM (r.vence_at - now())) / 60)::int
              END                AS "venceEnMin"
    FROM riesgo_requerimientos r
    JOIN operaciones o ON o.id = r.operacion_id
    LEFT JOIN operacion_guias g ON g.id = r.operacion_guia_id
    LEFT JOIN users ur ON ur.id = r.resuelto_por
    LEFT JOIN users uc ON uc.id = r.created_by
`;

// =================================================================================================
// Per caso — mounted on /api/operaciones, every `:id` validated as a UUID.
// =================================================================================================

/**
 * POST /api/operaciones/:id/riesgo-requerimientos — raise the demand and start telling the client.
 *
 * `capturista` alongside `admin`: this is the follow-up to a risk run, which is capturista work.
 * `tramitador` is excluded — the field role reports facts, it does not impose obligations.
 *
 * THE DEADLINE. `vence_at = eta_pais + ventanaHoras` (default 3 h, PRD-02 §16). When the caso has no
 * `eta_pais` — a prealerta that never declared a flight — the caller MUST send an explicit `venceAt`
 * and gets a 400 otherwise. Deriving one from `now()` would look like a deadline while being a
 * shorter window than the client was promised, and the whole legitimacy of freezing their cargo
 * rests on the window being the one they were given.
 */
operacionRequerimientosRouter.post(
  '/:id/riesgo-requerimientos',
  requireAuth,
  requireRole('admin', 'capturista'),
  validate({ params: operacionIdParam, body: requerimientoEmitirBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const body = req.body as RequerimientoEmitirBody;
      const userId = req.user!.userId;
      const ventanaHoras = body.ventanaHoras ?? ventanaHorasPorDefecto();

      const resultado = await withTransaction(async (q) => {
        const op = await q(
          'SELECT id, mawb, eta_pais, agora_conversation_id FROM operaciones WHERE id = $1 FOR UPDATE',
          [id],
        );
        if (!op.rows.length) return { kind: 'no_encontrada' as const };
        const operacion = op.rows[0] as {
          id: string;
          mawb: string;
          eta_pais: Date | null;
          agora_conversation_id: string | null;
        };

        const etaBase = operacion.eta_pais ? new Date(operacion.eta_pais) : null;
        let venceAt: Date;
        if (body.venceAt) {
          venceAt = new Date(body.venceAt);
        } else if (etaBase) {
          venceAt = calcularVenceAt(etaBase, ventanaHoras);
        } else {
          return { kind: 'sin_eta' as const };
        }

        let guia: { id: string; guiaNorm: string } | null = null;
        if (body.operacionGuiaId) {
          const g = await q(
            'SELECT id, guia_norm AS "guiaNorm" FROM operacion_guias WHERE id = $1 AND operacion_id = $2',
            [body.operacionGuiaId, id],
          );
          if (!g.rows.length) return { kind: 'guia_ajena' as const };
          guia = g.rows[0] as { id: string; guiaNorm: string };
        }
        if (body.shipmentId) {
          // Checked rather than left to the FK: a stale partida id must answer 400 with a sentence,
          // not 500 with a constraint name.
          const s = await q('SELECT id FROM shipments WHERE id = $1', [body.shipmentId]);
          if (!s.rows.length) return { kind: 'shipment_desconocido' as const };
        }

        const ins = await q(
          `INSERT INTO riesgo_requerimientos
             (operacion_id, operacion_guia_id, shipment_id, reason_codes, ruleset_version,
              ruleset_hash, detalle, vence_at, ventana_horas, eta_base, destinatario_email, created_by)
           VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12)
           RETURNING id, estado, vence_at AS "venceAt", created_at AS "createdAt"`,
          [
            id,
            guia?.id ?? null,
            body.shipmentId ?? null,
            JSON.stringify(body.reasonCodes ?? []),
            body.rulesetVersion ?? null,
            body.rulesetHash ?? null,
            body.detalle ?? null,
            venceAt.toISOString(),
            // Only meaningful when the deadline was derived; an explicit venceAt has no window.
            body.venceAt ? null : ventanaHoras,
            etaBase ? etaBase.toISOString() : null,
            body.destinatarioEmail ?? null,
            userId,
          ],
        );
        const requerimiento = ins.rows[0] as {
          id: string;
          estado: string;
          venceAt: Date;
          createdAt: Date;
        };

        const eventoId = await registrarEvento(q, {
          operacionId: operacion.id,
          mawb: operacion.mawb,
          tipo: 'REQUERIMIENTO_EMITIDO',
          payload: {
            requerimientoId: requerimiento.id,
            venceAt: requerimiento.venceAt,
            ventanaHoras: body.venceAt ? null : ventanaHoras,
            etaBase,
            guia: guia?.guiaNorm ?? null,
            operacionGuiaId: guia?.id ?? null,
            shipmentId: body.shipmentId ?? null,
            rulesetVersion: body.rulesetVersion ?? null,
            hallazgos: (body.reasonCodes ?? []).map((rc) => rc.signalId),
            detalle: body.detalle ?? null,
            efecto:
              'R18: el cliente debe resolver antes del plazo; al vencer se abre hold de riesgo (CT-4).',
          },
          userId,
        });

        return {
          kind: 'ok' as const,
          requerimiento,
          guia,
          etaBase,
          eventoId,
          mawb: operacion.mawb,
          agoraConversationId: operacion.agora_conversation_id,
        };
      });

      switch (resultado.kind) {
        case 'no_encontrada':
          res.status(404).json({ error: 'Operación no encontrada' });
          return;
        case 'sin_eta':
          res.status(400).json({
            error:
              'La operación no tiene ETA (`eta_pais`), así que el plazo no se puede derivar: envía `venceAt` explícito.',
          });
          return;
        case 'guia_ajena':
          res.status(400).json({ error: 'La `operacionGuiaId` indicada no pertenece a esta operación.' });
          return;
        case 'shipment_desconocido':
          res.status(400).json({ error: 'El `shipmentId` indicado no existe.' });
          return;
        default:
          break;
      }

      await recordAudit({
        userId,
        action: 'REQUERIMIENTO_EMITIDO',
        entity: 'riesgo_requerimiento',
        entityId: resultado.requerimiento.id,
        after: {
          operacionId: id,
          mawb: resultado.mawb,
          venceAt: resultado.requerimiento.venceAt,
          ventanaHoras: body.venceAt ? null : ventanaHoras,
          etaBase: resultado.etaBase,
          operacionGuiaId: resultado.guia?.id ?? null,
          rulesetVersion: body.rulesetVersion ?? null,
          hallazgos: (body.reasonCodes ?? []).map((rc) => rc.signalId),
        },
        ip: req.ip,
      });

      // AFTER the commit, and never inside it: an SMTP round trip inside a transaction holds a row
      // lock for the duration of somebody else's network. Also the reason the notification outcome is
      // reported separately from the creation — the requerimiento exists either way.
      const { outcome } = await notificarRequerimiento(resultado.requerimiento.id);

      await mirrorEventoToAgora({
        operacionId: id,
        agoraConversationId: resultado.agoraConversationId,
        tipo: 'REQUERIMIENTO_EMITIDO',
        payloadResumen: {
          requerimientoId: resultado.requerimiento.id,
          venceAt: resultado.requerimiento.venceAt,
          guia: resultado.guia?.guiaNorm ?? null,
          hallazgos: (body.reasonCodes ?? []).map((rc) => rc.signalId),
          notificacion: outcome.status,
        },
      });

      res.status(201).json({
        ok: true,
        requerimientoId: resultado.requerimiento.id,
        operacionId: id,
        estado: resultado.requerimiento.estado,
        venceAt: resultado.requerimiento.venceAt,
        ventanaHoras: body.venceAt ? null : ventanaHoras,
        etaBase: resultado.etaBase,
        operacionGuiaId: resultado.guia?.id ?? null,
        eventoId: resultado.eventoId,
        // Deliberately explicit. `omitida` means the client has NOT been told and the deadline is not
        // running yet — the caller must be able to see that without inspecting the row.
        notificacion: {
          estado: outcome.status,
          detalle:
            outcome.status === 'omitido'
              ? outcome.motivo
              : outcome.status === 'error'
                ? outcome.error
                : outcome.destinatario,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

/** GET /api/operaciones/:id/riesgo-requerimientos — this caso's demands, outstanding first. */
operacionRequerimientosRouter.get(
  '/:id/riesgo-requerimientos',
  requireAuth,
  validate({ params: operacionIdParam }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const op = await query('SELECT id FROM operaciones WHERE id = $1', [id]);
      if (!op.rows.length) {
        res.status(404).json({ error: 'Operación no encontrada' });
        return;
      }
      const { rows } = await query(
        `${SELECT_REQUERIMIENTO}
          WHERE r.operacion_id = $1
          ORDER BY (r.estado = 'abierto') DESC, r.vence_at ASC`,
        [id],
      );
      res.json(rows);
    } catch (err) {
      next(err);
    }
  },
);

// =================================================================================================
// The work queue — mounted on /api/riesgo-requerimientos.
// =================================================================================================

/**
 * GET /api/riesgo-requerimientos — open demands and the ones about to expire (PRD-02 §11).
 *
 * Open to every authenticated role, `autoridad` included: "which clients were given a deadline and
 * did they answer" is the question this whole feature exists to be able to answer under audit.
 *
 * `venceEnMin` is computed in SQL rather than in the browser so every reader — the control tower, a
 * report, the authority portal — counts down from the same clock.
 */
riesgoRequerimientosRouter.get(
  '/',
  requireAuth,
  validate({ query: requerimientoListaQuery }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { estado, porVencerHoras, operacionId } = req.query as unknown as RequerimientoListaQuery;
      const { rows } = await query(
        `${SELECT_REQUERIMIENTO}
          WHERE ($1::text = 'todos' OR r.estado = $1::text)
            AND ($2::numeric IS NULL OR r.vence_at <= now() + ($2::numeric * interval '1 hour'))
            AND ($3::uuid IS NULL OR r.operacion_id = $3::uuid)
          ORDER BY (r.estado = 'abierto') DESC, r.vence_at ASC
          LIMIT 500`,
        [estado, porVencerHoras ?? null, operacionId ?? null],
      );
      res.json(rows);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /api/riesgo-requerimientos/:id/notificar — send (or re-send) the demand to the client.
 *
 * Exists because the notification is config-gated: everything emitted while SMTP was unprovisioned
 * (#22) sits with `notificado_at IS NULL` and no clock running. The tick retries automatically; this
 * is the manual poke for the coordinator who just watched the operator turn SMTP on and wants the
 * client told now. Idempotent by construction — `notificado_at` is set once, so a re-send never
 * restarts a deadline that is already running.
 */
riesgoRequerimientosRouter.post(
  '/:id/notificar',
  requireAuth,
  requireRole('admin', 'capturista'),
  validate({ params: requerimientoIdParam }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const existe = await query<{ estado: string }>(
        'SELECT estado FROM riesgo_requerimientos WHERE id = $1',
        [id],
      );
      if (!existe.rows.length) {
        res.status(404).json({ error: 'Requerimiento no encontrado' });
        return;
      }
      const { outcome } = await notificarRequerimiento(id);
      const { rows } = await query(`${SELECT_REQUERIMIENTO} WHERE r.id = $1`, [id]);
      res.json({
        ok: outcome.status === 'enviado',
        notificacion: {
          estado: outcome.status,
          detalle:
            outcome.status === 'omitido'
              ? outcome.motivo
              : outcome.status === 'error'
                ? outcome.error
                : outcome.destinatario,
        },
        requerimiento: rows[0],
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /api/riesgo-requerimientos/:id/resolver — the client answered.
 *
 * Accepts a `vencido` requerimiento as well as an `abierto` one: §8.4 has `riesgo_vencido →
 * riesgo_ok` explicitly ("resolución tardía aceptada"), and refusing late evidence would leave cargo
 * frozen after the problem was fixed. 409 for the terminal states, because "resolving" something
 * already resolved or withdrawn would put a second, fictional resolution in the ledger.
 */
riesgoRequerimientosRouter.post(
  '/:id/resolver',
  requireAuth,
  requireRole('admin', 'capturista'),
  validate({ params: requerimientoIdParam, body: requerimientoResolverBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const { nota, evidenciaFileId } = req.body as RequerimientoResolverBody;
      const userId = req.user!.userId;

      const resultado = await withTransaction(async (q) => {
        const sel = await q(
          `SELECT r.id, r.estado, r.operacion_id, r.hold_id, r.vence_at,
                  o.mawb, o.agora_conversation_id, g.guia_norm
             FROM riesgo_requerimientos r
             JOIN operaciones o ON o.id = r.operacion_id
             LEFT JOIN operacion_guias g ON g.id = r.operacion_guia_id
            WHERE r.id = $1
            FOR UPDATE OF r`,
          [id],
        );
        if (!sel.rows.length) return { kind: 'no_encontrado' as const };
        const req0 = sel.rows[0] as {
          id: string;
          estado: string;
          operacion_id: string;
          hold_id: string | null;
          vence_at: Date;
          mawb: string;
          agora_conversation_id: string | null;
          guia_norm: string | null;
        };
        if (req0.estado !== 'abierto' && req0.estado !== 'vencido') {
          return { kind: 'estado_invalido' as const, estado: req0.estado };
        }

        await q(
          `UPDATE riesgo_requerimientos
              SET estado = 'resuelto', resuelto_at = now(), resuelto_por = $2,
                  resolucion_nota = $3, evidencia_file_id = $4
            WHERE id = $1`,
          [id, userId, nota, evidenciaFileId ?? null],
        );

        const cierre = await aplicarCierre(q, {
          operacionId: req0.operacion_id,
          mawb: req0.mawb,
          holdId: req0.hold_id,
          userId,
        });

        // `aTiempo` is the fact the whole feature turns on: did they answer before the deadline?
        const aTiempo = new Date(req0.vence_at).getTime() >= Date.now();
        const eventoId = await registrarEvento(q, {
          operacionId: req0.operacion_id,
          mawb: req0.mawb,
          tipo: 'REQUERIMIENTO_RESUELTO',
          payload: {
            requerimientoId: id,
            estadoAnterior: req0.estado,
            venceAt: req0.vence_at,
            aTiempo,
            nota,
            evidenciaFileId: evidenciaFileId ?? null,
            guia: req0.guia_norm,
            requerimientosPendientes: cierre.pendientes,
            holdCerrado: cierre.holdCerrado,
            holdActivo: cierre.holdActivo,
            estadoDocumental: cierre.estadoDocumental,
          },
          userId,
        });

        return { kind: 'ok' as const, req0, cierre, aTiempo, eventoId };
      });

      switch (resultado.kind) {
        case 'no_encontrado':
          res.status(404).json({ error: 'Requerimiento no encontrado' });
          return;
        case 'estado_invalido':
          res.status(409).json({
            error: `El requerimiento está en estado '${resultado.estado}'; sólo se puede resolver uno 'abierto' o 'vencido'.`,
            estado: resultado.estado,
          });
          return;
        default:
          break;
      }

      await recordAudit({
        userId,
        action: 'REQUERIMIENTO_RESUELTO',
        entity: 'riesgo_requerimiento',
        entityId: id,
        after: {
          operacionId: resultado.req0.operacion_id,
          mawb: resultado.req0.mawb,
          estadoAnterior: resultado.req0.estado,
          aTiempo: resultado.aTiempo,
          nota,
          evidenciaFileId: evidenciaFileId ?? null,
          holdCerrado: resultado.cierre.holdCerrado,
          holdActivo: resultado.cierre.holdActivo,
          estadoDocumental: resultado.cierre.estadoDocumental,
        },
        ip: req.ip,
      });

      await mirrorEventoToAgora({
        operacionId: resultado.req0.operacion_id,
        agoraConversationId: resultado.req0.agora_conversation_id,
        tipo: 'REQUERIMIENTO_RESUELTO',
        payloadResumen: {
          requerimientoId: id,
          aTiempo: resultado.aTiempo,
          guia: resultado.req0.guia_norm,
          holdActivo: resultado.cierre.holdActivo,
          estadoDocumental: resultado.cierre.estadoDocumental,
        },
      });

      res.json({
        ok: true,
        requerimientoId: id,
        operacionId: resultado.req0.operacion_id,
        estado: 'resuelto',
        aTiempo: resultado.aTiempo,
        requerimientosPendientes: resultado.cierre.pendientes,
        holdCerrado: resultado.cierre.holdCerrado,
        holdActivo: resultado.cierre.holdActivo,
        estadoDocumental: resultado.cierre.estadoDocumental,
        eventoId: resultado.eventoId,
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /api/riesgo-requerimientos/:id/cancelar — withdraw a demand that should not have been made.
 *
 * Admin only. The case it exists for: a re-parse corrects a misread weight and the finding evaporates.
 * Withdrawing explicitly, with a stated motivo, is the honest ending — letting it expire instead would
 * freeze a client's cargo over our own error and leave a ledger that says they failed to answer.
 */
riesgoRequerimientosRouter.post(
  '/:id/cancelar',
  requireAuth,
  requireRole('admin'),
  validate({ params: requerimientoIdParam, body: requerimientoCancelarBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const { motivo } = req.body as RequerimientoCancelarBody;
      const userId = req.user!.userId;

      const resultado = await withTransaction(async (q) => {
        const sel = await q(
          `SELECT r.id, r.estado, r.operacion_id, r.hold_id, o.mawb, o.agora_conversation_id, g.guia_norm
             FROM riesgo_requerimientos r
             JOIN operaciones o ON o.id = r.operacion_id
             LEFT JOIN operacion_guias g ON g.id = r.operacion_guia_id
            WHERE r.id = $1
            FOR UPDATE OF r`,
          [id],
        );
        if (!sel.rows.length) return { kind: 'no_encontrado' as const };
        const req0 = sel.rows[0] as {
          id: string;
          estado: string;
          operacion_id: string;
          hold_id: string | null;
          mawb: string;
          agora_conversation_id: string | null;
          guia_norm: string | null;
        };
        if (req0.estado !== 'abierto' && req0.estado !== 'vencido') {
          return { kind: 'estado_invalido' as const, estado: req0.estado };
        }

        await q(
          `UPDATE riesgo_requerimientos
              SET estado = 'cancelado', resuelto_at = now(), resuelto_por = $2, resolucion_nota = $3
            WHERE id = $1`,
          [id, userId, motivo],
        );

        const cierre = await aplicarCierre(q, {
          operacionId: req0.operacion_id,
          mawb: req0.mawb,
          holdId: req0.hold_id,
          userId,
        });

        const eventoId = await registrarEvento(q, {
          operacionId: req0.operacion_id,
          mawb: req0.mawb,
          tipo: 'REQUERIMIENTO_CANCELADO',
          payload: {
            requerimientoId: id,
            estadoAnterior: req0.estado,
            motivo,
            guia: req0.guia_norm,
            requerimientosPendientes: cierre.pendientes,
            holdCerrado: cierre.holdCerrado,
            holdActivo: cierre.holdActivo,
            estadoDocumental: cierre.estadoDocumental,
          },
          userId,
        });

        return { kind: 'ok' as const, req0, cierre, eventoId };
      });

      switch (resultado.kind) {
        case 'no_encontrado':
          res.status(404).json({ error: 'Requerimiento no encontrado' });
          return;
        case 'estado_invalido':
          res.status(409).json({
            error: `El requerimiento está en estado '${resultado.estado}'; sólo se puede cancelar uno 'abierto' o 'vencido'.`,
            estado: resultado.estado,
          });
          return;
        default:
          break;
      }

      await recordAudit({
        userId,
        action: 'REQUERIMIENTO_CANCELADO',
        entity: 'riesgo_requerimiento',
        entityId: id,
        after: {
          operacionId: resultado.req0.operacion_id,
          mawb: resultado.req0.mawb,
          estadoAnterior: resultado.req0.estado,
          motivo,
          holdCerrado: resultado.cierre.holdCerrado,
          holdActivo: resultado.cierre.holdActivo,
          estadoDocumental: resultado.cierre.estadoDocumental,
        },
        ip: req.ip,
      });

      res.json({
        ok: true,
        requerimientoId: id,
        operacionId: resultado.req0.operacion_id,
        estado: 'cancelado',
        requerimientosPendientes: resultado.cierre.pendientes,
        holdCerrado: resultado.cierre.holdCerrado,
        holdActivo: resultado.cierre.holdActivo,
        estadoDocumental: resultado.cierre.estadoDocumental,
        eventoId: resultado.eventoId,
      });
    } catch (err) {
      next(err);
    }
  },
);
