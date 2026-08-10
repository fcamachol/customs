import { Router, type Request, type Response, type NextFunction } from 'express';
import { query } from '../db/pool';
import { withTransaction } from '../db/tx';
import { requireAuth, requireRole } from '../auth/middleware';
import { recordAudit } from '../services/audit';
import { evaluarOperacion } from '../services/replanService';
import { validate } from '../validation/middleware';
import {
  replanAccionParam,
  replanDecisionBody,
  replanGuiaNoTransmitidaBody,
  replanGuiaParam,
  replanOperacionParam,
  type ReplanDecisionBody,
  type ReplanGuiaNoTransmitidaBody,
} from '../validation/schemas';
import {
  REPLAN_RULESET_HASH,
  REPLAN_RULESET_VERSION,
} from '../../../shared/operaciones/replan';

/**
 * Contingency engine — the HTTP surface (PRD-02 §8.8, CT-1…CT-7).
 *
 * Four endpoints, and the shape of them is the governance rule made concrete:
 *
 *   - `POST /:id/replan` runs the engine now. It never needs a body, because the engine's input is
 *     the world, not the caller's opinion of it.
 *   - `GET /:id/replan` is the coordinator's queue: what the engine decided and, above all, what is
 *     still WAITING for a human — the reassignments that change a tarifa.
 *   - `POST /:id/replan/acciones/:accionId/confirmar` and `.../descartar` are the money boundary
 *     (D6/P3/R20). Both demand a `motivo` and both write `override = true` into the ledger, because
 *     both are a person overruling or ratifying an engine's proposal with company money attached.
 *   - `POST /:id/guias/:guiaId/no-transmitida` is CT-2's trigger, and it lives here rather than in
 *     `operaciones.ts` because marking a guía untransmitted is not an edit — it is the fact that sets
 *     the contingency off, and the engine runs on the same call so the consequence cannot lag the
 *     cause by a tick.
 *
 * ROUTING NOTE. Like `holdsRouter`, this router is stacked on the `/api/operaciones` prefix that
 * `operacionesRouter` also owns (`GET /:id`). Every route here is multi-segment and every `:id` is
 * validated as a UUID, so nothing here can be shadowed by, or shadow, the caso detail route.
 *
 * `tramitador` is excluded throughout. The field role reports what it sees; replanning the day and
 * committing a carrier is office work with a budget attached. `autoridad` reads, like everywhere.
 */
export const replanRouter = Router();

/**
 * POST /api/operaciones/:id/replan — evaluate the contingency catalogue now.
 *
 * Exists as a manual call even though the tick sweeps automatically, for the case that made this
 * feature necessary: a coordinator who has just learned something (the client called, the warehouse
 * called) and needs the day's plan reconsidered in seconds, not in five minutes.
 *
 * The response reports `omitidas` — actions the engine re-derived that were already on record.
 * Surfacing that number rather than hiding it is what makes the anti-stutter behaviour visible:
 * pressing the button twice is safe and says so.
 */
replanRouter.post(
  '/:id/replan',
  requireAuth,
  requireRole('admin', 'capturista'),
  validate({ params: replanOperacionParam }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const resultado = await evaluarOperacion({
        operacionId: id,
        disparador: 'manual',
        userId: req.user!.userId,
      });
      if (!resultado) {
        res.status(404).json({ error: 'Operación no encontrada' });
        return;
      }
      res.json({
        ok: true,
        rulesetVersion: REPLAN_RULESET_VERSION,
        rulesetHash: REPLAN_RULESET_HASH,
        ...resultado,
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /api/operaciones/:id/replan — what the engine decided, pending decisions first.
 *
 * Open to every authenticated role including `autoridad` and `tramitador`: "this shipment is out of
 * today's plan and why" is not privileged information, it is the information that stops people
 * working on cargo that is not going anywhere.
 */
replanRouter.get(
  '/:id/replan',
  requireAuth,
  validate({ params: replanOperacionParam }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const op = await query('SELECT id FROM operaciones WHERE id = $1', [id]);
      if (!op.rows.length) {
        res.status(404).json({ error: 'Operación no encontrada' });
        return;
      }

      const acciones = await query<{ estado: string }>(
        `SELECT a.id,
                a.contingencia,
                a.tipo,
                a.clave,
                a.ejecucion,
                a.estado,
                a.motivo,
                a.payload,
                a.evento_id       AS "eventoId",
                a.decidida_at     AS "decididaAt",
                a.decidida_por    AS "decididaPor",
                u.username        AS "decididaPorUsuario",
                a.decision_motivo AS "decisionMotivo",
                a.created_at      AS "createdAt",
                e.ruleset_version AS "rulesetVersion",
                e.ruleset_hash    AS "rulesetHash",
                e.disparador
           FROM replan_acciones a
           JOIN replan_evaluaciones e ON e.id = a.evaluacion_id
           LEFT JOIN users u ON u.id = a.decidida_por
          WHERE a.operacion_id = $1
          ORDER BY (a.estado = 'propuesta') DESC, a.created_at DESC`,
        [id],
      );

      const ultima = await query(
        `SELECT id, ruleset_version AS "rulesetVersion", ruleset_hash AS "rulesetHash",
                disparador, acciones, created_at AS "createdAt"
           FROM replan_evaluaciones
          WHERE operacion_id = $1
          ORDER BY created_at DESC
          LIMIT 1`,
        [id],
      );

      res.json({
        rulesetVersion: REPLAN_RULESET_VERSION,
        rulesetHash: REPLAN_RULESET_HASH,
        ultimaEvaluacion: ultima.rows[0] ?? null,
        pendientes: acciones.rows.filter((a) => a.estado === 'propuesta').length,
        acciones: acciones.rows,
      });
    } catch (err) {
      next(err);
    }
  },
);

/** Shared by confirmar/descartar: the same row lookup, the same failure modes, one place. */
async function decidir(
  req: Request,
  res: Response,
  decision: 'confirmada' | 'descartada',
): Promise<void> {
  const { id, accionId } = req.params;
  const { motivo, nuevaOperacionId } = req.body as ReplanDecisionBody;
  const userId = req.user!.userId;

  const resultado = await withTransaction(async (q) => {
    const opRes = await q('SELECT id, mawb FROM operaciones WHERE id = $1 FOR UPDATE', [id]);
    if (!opRes.rows.length) return { kind: 'no_encontrada' as const };
    const op = opRes.rows[0] as { id: string; mawb: string };

    const accRes = await q(
      `SELECT id, contingencia, tipo, ejecucion, estado, motivo, payload
         FROM replan_acciones
        WHERE id = $1 AND operacion_id = $2 FOR UPDATE`,
      [accionId, id],
    );
    if (!accRes.rows.length) return { kind: 'accion_no_encontrada' as const };
    const accion = accRes.rows[0] as {
      id: string;
      contingencia: string;
      tipo: string;
      ejecucion: string;
      estado: string;
      motivo: string;
      payload: Record<string, unknown>;
    };
    // 409, not 200: a second confirmation would append a second override event describing an
    // approval that never happened, and the ledger cannot be allowed to say that.
    if (accion.estado !== 'propuesta') {
      return { kind: 'estado_invalido' as const, estado: accion.estado };
    }

    // The chosen target must exist. A reassignment confirmed against a caso id that is not there is
    // a truck sent nowhere, recorded as a decision.
    if (nuevaOperacionId) {
      const destino = await q('SELECT id, mawb FROM operaciones WHERE id = $1', [nuevaOperacionId]);
      if (!destino.rows.length) return { kind: 'destino_no_encontrado' as const };
      if (nuevaOperacionId === id) return { kind: 'destino_invalido' as const };
    }

    const upd = await q(
      `UPDATE replan_acciones
          SET estado = $2, decidida_at = now(), decidida_por = $3, decision_motivo = $4
        WHERE id = $1
        RETURNING decidida_at AS "decididaAt"`,
      [accionId, decision, userId, motivo],
    );

    const tipoEvento = decision === 'confirmada' ? 'REASIGNACION_CONFIRMADA' : 'REASIGNACION_DESCARTADA';
    // `override = true` with an obligatory motivo IS the governance record (R20/N2): a human took
    // responsibility for a decision the engine was not allowed to take. `origen` is 'coordinador'
    // here — unlike the engine's own events — because this one really was a person.
    const evRes = await q(
      `INSERT INTO operacion_eventos
         (operacion_id, operacion_mawb, tipo, origen, ocurrido_at, payload, override, motivo, created_by)
       VALUES ($1,$2,$3,'coordinador',now(),$4,true,$5,$6)
       RETURNING id`,
      [
        op.id,
        op.mawb,
        tipoEvento,
        JSON.stringify({
          accionId: accion.id,
          contingencia: accion.contingencia,
          accion: accion.tipo,
          propuesta: accion.motivo,
          despachoId: accion.payload?.despachoId ?? null,
          nuevaOperacionId: nuevaOperacionId ?? null,
          decision,
          // Spelled out because it is the whole argument of CT-7 and the reader six weeks later is
          // usually looking for exactly this sentence.
          efecto:
            decision === 'confirmada'
              ? 'Se reasigna la unidad en vez de cancelarla: no hay flete en falso, sólo cambio de tarifa.'
              : 'Se descarta la reasignación; la unidad queda sin carga y el costo corre por cuenta de la agencia.',
        }),
        motivo,
        userId,
      ],
    );

    return {
      kind: 'ok' as const,
      accion,
      mawb: op.mawb,
      decididaAt: upd.rows[0].decididaAt as Date,
      eventoId: String(evRes.rows[0].id),
    };
  });

  switch (resultado.kind) {
    case 'no_encontrada':
      res.status(404).json({ error: 'Operación no encontrada' });
      return;
    case 'accion_no_encontrada':
      res.status(404).json({ error: 'Acción de replaneación no encontrada para esta operación' });
      return;
    case 'destino_no_encontrado':
      res.status(404).json({ error: 'La operación destino de la reasignación no existe' });
      return;
    case 'destino_invalido':
      res.status(400).json({ error: 'La operación destino no puede ser la misma que pierde la carga.' });
      return;
    case 'estado_invalido':
      res.status(409).json({
        error: `La acción está en estado '${resultado.estado}'; sólo se puede decidir una acción 'propuesta'.`,
        estado: resultado.estado,
      });
      return;
    default:
      break;
  }

  await recordAudit({
    userId,
    action: decision === 'confirmada' ? 'REASIGNACION_CONFIRMADA' : 'REASIGNACION_DESCARTADA',
    entity: 'replan_accion',
    entityId: resultado.accion.id,
    after: {
      operacionId: id,
      mawb: resultado.mawb,
      contingencia: resultado.accion.contingencia,
      tipo: resultado.accion.tipo,
      nuevaOperacionId: nuevaOperacionId ?? null,
      motivo,
      override: true,
    },
    ip: req.ip,
  });

  res.json({
    ok: true,
    accionId: resultado.accion.id,
    operacionId: id,
    estado: decision,
    nuevaOperacionId: nuevaOperacionId ?? null,
    motivo,
    decididaAt: resultado.decididaAt,
    eventoId: resultado.eventoId,
  });
}

/**
 * POST /api/operaciones/:id/replan/acciones/:accionId/confirmar — a human commits the money.
 *
 * This is the ONLY way a `reasignar_despacho` ever takes effect, and the `motivo` is not paperwork:
 * it is the answer to "who decided to move that truck and why", which is the question that follows a
 * tarifa change.
 */
replanRouter.post(
  '/:id/replan/acciones/:accionId/confirmar',
  requireAuth,
  requireRole('admin', 'capturista'),
  validate({ params: replanAccionParam, body: replanDecisionBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await decidir(req, res, 'confirmada');
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /api/operaciones/:id/replan/acciones/:accionId/descartar — the coordinator says no.
 *
 * Recorded with the same weight as a confirmation. Discarding leaves a contracted unit without cargo,
 * which is the flete en falso itself: the decision to absorb that cost is a decision, and the payload
 * says so out loud rather than letting the proposal quietly disappear from a screen.
 */
replanRouter.post(
  '/:id/replan/acciones/:accionId/descartar',
  requireAuth,
  requireRole('admin', 'capturista'),
  validate({ params: replanAccionParam, body: replanDecisionBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await decidir(req, res, 'descartada');
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /api/operaciones/:id/guias/:guiaId/no-transmitida — CT-2's trigger.
 *
 * There is no feed for this: somebody in the office finds out the guía was never transmitted, usually
 * from the client, usually the morning of. The state is deliberately one-way here — `operacion_guias`
 * never walks a guía backwards from a fact someone observed (migration 1700004400000) — and the
 * engine runs on the same request, so the exclusion and the client notice do not wait for a tick.
 *
 * 409 on a guía that is already `no_transmitida`: a repeat is not an error the caller should retry,
 * but appending a second GUIA_NO_TRANSMITIDA event for the same guía would put a duplicate fact in an
 * append-only ledger.
 */
replanRouter.post(
  '/:id/guias/:guiaId/no-transmitida',
  requireAuth,
  requireRole('admin', 'capturista'),
  validate({ params: replanGuiaParam, body: replanGuiaNoTransmitidaBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id, guiaId } = req.params;
      const { motivo } = req.body as ReplanGuiaNoTransmitidaBody;
      const userId = req.user!.userId;

      const resultado = await withTransaction(async (q) => {
        const opRes = await q('SELECT id, mawb FROM operaciones WHERE id = $1 FOR UPDATE', [id]);
        if (!opRes.rows.length) return { kind: 'no_encontrada' as const };
        const op = opRes.rows[0] as { id: string; mawb: string };

        const gRes = await q(
          `SELECT id, guia_norm AS "guiaNorm", estado
             FROM operacion_guias WHERE id = $1 AND operacion_id = $2 FOR UPDATE`,
          [guiaId, id],
        );
        if (!gRes.rows.length) return { kind: 'guia_ajena' as const };
        const guia = gRes.rows[0] as { id: string; guiaNorm: string; estado: string };
        if (guia.estado === 'no_transmitida') {
          return { kind: 'estado_invalido' as const, estado: guia.estado };
        }

        await q(`UPDATE operacion_guias SET estado = 'no_transmitida' WHERE id = $1`, [guiaId]);

        const evRes = await q(
          `INSERT INTO operacion_eventos
             (operacion_id, operacion_mawb, tipo, origen, ocurrido_at, payload, created_by)
           VALUES ($1,$2,'GUIA_NO_TRANSMITIDA','coordinador',now(),$3,$4)
           RETURNING id`,
          [
            op.id,
            op.mawb,
            JSON.stringify({
              operacionGuiaId: guia.id,
              guia: guia.guiaNorm,
              estadoAnterior: guia.estado,
              estado: 'no_transmitida',
              motivo,
              efecto: 'La guía no puede despacharse; se evalúa la contingencia CT-2.',
            }),
            userId,
          ],
        );

        return {
          kind: 'ok' as const,
          guia,
          mawb: op.mawb,
          eventoId: String(evRes.rows[0].id),
        };
      });

      switch (resultado.kind) {
        case 'no_encontrada':
          res.status(404).json({ error: 'Operación no encontrada' });
          return;
        case 'guia_ajena':
          res.status(400).json({ error: 'La guía indicada no pertenece a esta operación.' });
          return;
        case 'estado_invalido':
          res.status(409).json({ error: 'La guía ya está marcada como no transmitida.' });
          return;
        default:
          break;
      }

      await recordAudit({
        userId,
        action: 'GUIA_NO_TRANSMITIDA',
        entity: 'operacion_guia',
        entityId: resultado.guia.id,
        after: {
          operacionId: id,
          mawb: resultado.mawb,
          guia: resultado.guia.guiaNorm,
          estadoAnterior: resultado.guia.estado,
          estado: 'no_transmitida',
          motivo,
        },
        ip: req.ip,
      });

      // The consequence, on the same request. A CT-2 exclusion that waits for the next tick is an
      // hour in which somebody can still load a guía that cannot legally move.
      const replan = await evaluarOperacion({
        operacionId: id,
        disparador: 'guia',
        userId,
      });

      res.status(201).json({
        ok: true,
        operacionId: id,
        operacionGuiaId: resultado.guia.id,
        guia: resultado.guia.guiaNorm,
        estado: 'no_transmitida',
        eventoId: resultado.eventoId,
        replan,
      });
    } catch (err) {
      next(err);
    }
  },
);
