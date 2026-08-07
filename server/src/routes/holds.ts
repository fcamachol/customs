import { Router, type Request, type Response, type NextFunction } from 'express';
import { query } from '../db/pool';
import { withTransaction } from '../db/tx';
import { requireAuth, requireRole } from '../auth/middleware';
import { recordAudit } from '../services/audit';
import { validate } from '../validation/middleware';
import {
  holdGlobalBody,
  holdGlobalIdParam,
  holdOperacionBody,
  holdOperacionHoldParam,
  holdOperacionParam,
  retencionBody,
  retencionParam,
  type HoldGlobalBody,
  type HoldOperacionBody,
  type RetencionBody,
} from '../validation/schemas';

/**
 * HOLDS and RETENCIONES — the blocking layer of the operations state machine
 * (PRD-02 §8.4, §8.5, contingencies CT-3/CT-4/CT-5/CT-6).
 *
 * THE DESIGN RULE, AND IT IS THE WHOLE FILE. A hold NEVER changes the physical etapa. The aircraft
 * landed whether or not the authority is auditing the warehouse, so rewriting `etapa` would be a lie
 * about the world and would break the monotonicity that field capture depends on (routes/campo.ts).
 * What a hold does is inhibit PLANNING transitions: nothing gets programmed, and above all no truck
 * gets requested. Acting on that inhibition — moving `estado_planeacion` to `excluida`, putting
 * despachos into `en_espera`, looking for a replacement guía (R16) — belongs to the contingency engine
 * (§8.8) and is deliberately NOT done here. This file owns four things and nothing else: the rows, the
 * materialized `operaciones.hold_activo` flag, the per-caso ledger events, and the audit trail.
 *
 * WHY THE GLOBAL HOLD IS THE POINT OF THE FEATURE (CT-6). From the source meeting, verbatim: "un botón
 * que dice auditoría de autoridad, track, y todo está parado". When the authority audits the almacén
 * nothing moves — and critically, the system must STOP REQUESTING TRUCKS. A truck contracted against
 * cargo that cannot be loaded is a *flete en falso*, and somebody pays for it. So the global hold is
 * not a UI convenience: it is the mechanism that converts "we found out too late" into "we never
 * called the transportista". That is why opening one writes an event onto EVERY open caso's timeline
 * rather than into a single system log — six weeks later, the question is asked one shipment at a
 * time ("why didn't guía X go out on Tuesday?"), and each timeline has to answer it on its own.
 *
 * OPERACIÓN-LEVEL HOLDS are CT-3 and CT-4: cargo consigned to another agencia aduanal, blocked until
 * the cesión letter arrives (cotejo rule PA-09), and risk findings the client left unanswered past the
 * hard deadline. Both resolve OUTSIDE this system, which is exactly why they need an explicit
 * open/close record instead of a state someone infers.
 *
 * RETENCIONES are CT-5, the partial retention: the authority pulls one pallet for inspection and the
 * rest ships the same afternoon. Two consequences, both of them expensive to get wrong. The pedimento
 * must declare the cargo that ACTUALLY LEFT — declaring the full manifiesto for a truck that carried
 * less is a false declaration — and the detained pallet keeps living, in custody, with its own
 * `retenida → liberada` lifecycle until somebody signs it out (§9.7). The `tramitador` may create one
 * because the tramitador is the person standing there watching the pallet get pulled; he may NOT
 * release one, because release is an office decision against an authority document.
 *
 * ROUTING NOTE (why the order of registrations below is load-bearing). This router shares the
 * `/api/operaciones` prefix with `operacionesRouter`, which owns `GET /:id`. The global endpoints live
 * at `/holds/global`, so the global routes are registered FIRST here, and every parameterized route
 * validates `:id` as a UUID. Belt and braces on purpose: either measure alone would keep the literal
 * string 'holds' from being captured as an operación id, and the failure mode if both were missing is
 * an authority-audit freeze that silently 404s or 500s.
 *
 * Snake_case in the database, camelCase over the wire via explicit `AS "camelCase"` aliases, per the
 * house convention.
 */
export const holdsRouter = Router();

/** The tx query function handed out by `withTransaction`. */
type Q = (text: string, params?: unknown[]) => Promise<any>;

/**
 * A caso is "open" — and therefore affected by a global freeze — until it is delivered, closed or
 * cancelled. Freezing an already-delivered shipment would be meaningless (there is nothing left to
 * plan) and actively harmful: it would light up `hold_activo` on the board for cargo that is already
 * at the client's warehouse, burying the shipments that actually need attention.
 */
const ETAPAS_CERRADAS = "('entregado','cerrada','cancelada')";

/**
 * Serializes global-hold opens. The duplicate check and the insert are two statements, so without
 * this two admins pressing the audit button at the same instant would both read "no active global
 * hold" and both insert one — leaving two rows that each have to be closed before trucks resume. A
 * transaction-scoped advisory lock is the same tool `recordAudit` uses to serialize the hash chain.
 */
const LOCK_HOLD_GLOBAL = 4600001;

/**
 * Recompute the materialized flag for ONE caso.
 *
 * `hold_activo` is denormalized onto `operaciones` because the control-tower board filters on it on
 * every poll (§8.5). The formula is deliberately absolute rather than incremental — it does not
 * increment a counter or trust the caller's intent, it asks the table what is true right now:
 * "is there any active hold that is either global or mine?". So a hold opened while a global freeze is
 * already in force, or closed while another one remains, both land on the correct value with no
 * ordering assumptions.
 */
async function materializarUna(q: Q, operacionId: string): Promise<boolean> {
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

/**
 * Recompute the flag for EVERY open caso — the global open/close path.
 *
 * One statement, not a loop: the whole point of the audit button is that it is instantaneous and
 * atomic, and a per-row loop inside the transaction would hold locks proportionally to the size of the
 * board. The same absolute formula is reused, which is what makes the interesting edge case correct
 * without a special branch — closing the global hold does NOT clear `hold_activo` on a caso that still
 * has an operación-level hold of its own, because the EXISTS still finds that row.
 *
 * Returns the affected casos so the caller can write one ledger event per timeline.
 */
async function materializarAbiertas(q: Q): Promise<Array<{ id: string; mawb: string; holdActivo: boolean }>> {
  const { rows } = await q(
    `UPDATE operaciones o
        SET hold_activo = EXISTS (
              SELECT 1 FROM operacion_holds h
               WHERE h.activo
                 AND (h.operacion_id IS NULL OR h.operacion_id = o.id))
      WHERE o.etapa NOT IN ${ETAPAS_CERRADAS}
      RETURNING o.id, o.mawb, o.hold_activo AS "holdActivo"`,
  );
  return rows as Array<{ id: string; mawb: string; holdActivo: boolean }>;
}

/**
 * Ledger row for a single caso.
 *
 * `origen` is 'coordinador' for every write in this file: holds and retenciones are human decisions
 * taken from the office (or reported from the dock and entered by the office), never facts derived by
 * the system from a feed. The `motivo` travels in the payload as well as in the row, because the
 * timeline is what gets read six weeks later and it has to be self-contained.
 *
 * TODO(orchestrator): add to TIPOS_EVENTO when estados.ts frees up —
 * 'HOLD_ABIERTO', 'HOLD_CERRADO', 'HOLD_GLOBAL_ABIERTO', 'HOLD_GLOBAL_CERRADO',
 * 'RETENCION_CREADA', 'RETENCION_LIBERADA'. `operacion_eventos.tipo` carries no DB constraint, so
 * these insert correctly today; the shared vocabulary is owned by another agent right now.
 */
async function registrarEvento(
  q: Q,
  args: {
    operacionId: string;
    mawb: string;
    tipo: string;
    payload: Record<string, unknown>;
    userId: string;
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

/**
 * One ledger row per open caso, in a single statement.
 *
 * DELIBERATELY NOT one system-wide event. The global freeze is asked about per shipment, so it has to
 * be answerable per shipment: every affected caso's timeline says, in its own words, that it stopped
 * because of an authority audit and who ordered it. The same `holdId` appears in all of them, which is
 * what lets a reader collapse them back into the single decision they came from.
 */
async function registrarEventoGlobal(
  q: Q,
  args: {
    operacionIds: string[];
    tipo: string;
    payload: Record<string, unknown>;
    userId: string;
  },
): Promise<number> {
  if (!args.operacionIds.length) return 0;
  const { rowCount } = await q(
    `INSERT INTO operacion_eventos
       (operacion_id, operacion_mawb, tipo, origen, ocurrido_at, payload, created_by)
     SELECT o.id, o.mawb, $1, 'coordinador', now(), $2::jsonb, $3
       FROM operaciones o
      WHERE o.id = ANY($4::uuid[])`,
    [args.tipo, JSON.stringify(args.payload), args.userId, args.operacionIds],
  );
  return rowCount ?? 0;
}

// =================================================================================================
// GLOBAL — registered BEFORE the parameterized routes (see the routing note above).
// =================================================================================================

/**
 * POST /api/operaciones/holds/global — the authority-audit button (CT-6). Admin only.
 *
 * Admin only, with no capturista escape hatch, because this single call stops the entire operation:
 * it is the most disruptive write in the system and the person who makes it has to be identifiable.
 *
 * 409 on a duplicate active hold of the same tipo rather than a silent second row. Two open global
 * holds would mean trucks stay suspended after the first one is closed, for a reason nobody
 * remembers — the freeze would outlive the audit, which is its own kind of operational failure.
 */
holdsRouter.post(
  '/holds/global',
  requireAuth,
  requireRole('admin'),
  validate({ body: holdGlobalBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tipo, motivo } = req.body as HoldGlobalBody;
      const userId = req.user!.userId;

      const resultado = await withTransaction(async (q) => {
        await q('SELECT pg_advisory_xact_lock($1)', [LOCK_HOLD_GLOBAL]);

        const existente = await q(
          `SELECT id FROM operacion_holds
            WHERE activo AND operacion_id IS NULL AND tipo = $1
            LIMIT 1`,
          [tipo],
        );
        if (existente.rows.length) {
          return { kind: 'duplicado' as const, holdId: String(existente.rows[0].id) };
        }

        const ins = await q(
          `INSERT INTO operacion_holds (operacion_id, tipo, alcance, activo, abierto_por, motivo)
           VALUES (NULL, $1, 'global', true, $2, $3)
           RETURNING id, abierto_at AS "abiertoAt"`,
          [tipo, userId, motivo],
        );
        const hold = ins.rows[0] as { id: string; abiertoAt: Date };

        // Materialize first, then log: the event payload reports the number of casos actually frozen,
        // so it has to be computed from the same transaction that froze them.
        const afectadas = await materializarAbiertas(q);
        const eventos = await registrarEventoGlobal(q, {
          operacionIds: afectadas.map((o) => o.id),
          tipo: 'HOLD_GLOBAL_ABIERTO',
          payload: {
            holdId: hold.id,
            tipoHold: tipo,
            alcance: 'global',
            motivo,
            // Spelled out in every timeline because it is the operational consequence, not a
            // side note: this is what prevents the flete en falso (CT-6).
            efecto: 'Se suspende la solicitud de unidades; la operación no se programa.',
            operacionesAfectadas: afectadas.length,
          },
          userId,
        });

        return {
          kind: 'ok' as const,
          holdId: hold.id,
          abiertoAt: hold.abiertoAt,
          afectadas: afectadas.map((o) => o.mawb),
          eventos,
        };
      });

      if (resultado.kind === 'duplicado') {
        res.status(409).json({
          error: `Ya existe un hold global activo de tipo '${tipo}'. Ciérralo antes de abrir otro.`,
          holdId: resultado.holdId,
        });
        return;
      }

      await recordAudit({
        userId,
        action: 'HOLD_GLOBAL_ABIERTO',
        entity: 'operacion_hold',
        entityId: resultado.holdId,
        after: {
          tipo,
          alcance: 'global',
          motivo,
          operacionesAfectadas: resultado.afectadas.length,
          mawbsAfectadas: resultado.afectadas,
        },
        ip: req.ip,
      });

      res.status(201).json({
        ok: true,
        holdId: resultado.holdId,
        tipo,
        alcance: 'global',
        motivo,
        abiertoAt: resultado.abiertoAt,
        operacionesAfectadas: resultado.afectadas.length,
        eventosRegistrados: resultado.eventos,
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * DELETE /api/operaciones/holds/global/:holdId — the audit ended; unfreeze. Admin only.
 *
 * Closed, never deleted: `activo = false` plus `cerrado_at`/`cerrado_por` IS the release record, and
 * the row is the only proof of how long the operation was stopped and on whose authority.
 *
 * 404 when the hold does not exist OR is already closed — the two are the same answer to the caller
 * ("there is nothing here to release"), and treating a re-close as success would append a second
 * release event describing an unfreeze that did not happen.
 */
holdsRouter.delete(
  '/holds/global/:holdId',
  requireAuth,
  requireRole('admin'),
  validate({ params: holdGlobalIdParam }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { holdId } = req.params;
      const userId = req.user!.userId;

      const resultado = await withTransaction(async (q) => {
        const upd = await q(
          `UPDATE operacion_holds
              SET activo = false, cerrado_at = now(), cerrado_por = $2
            WHERE id = $1 AND activo AND operacion_id IS NULL
            RETURNING id, tipo, motivo, abierto_at AS "abiertoAt", cerrado_at AS "cerradoAt"`,
          [holdId, userId],
        );
        if (!upd.rows.length) return { kind: 'no_encontrado' as const };
        const hold = upd.rows[0] as {
          id: string;
          tipo: string;
          motivo: string;
          abiertoAt: Date;
          cerradoAt: Date;
        };

        const afectadas = await materializarAbiertas(q);
        // THE edge case: a caso that still carries its own operación-level hold stays frozen. Reported
        // in each timeline so nobody reads "hold global cerrado" and expects that shipment to move.
        const siguenBloqueadas = afectadas.filter((o) => o.holdActivo);
        const eventos = await registrarEventoGlobal(q, {
          operacionIds: afectadas.map((o) => o.id),
          tipo: 'HOLD_GLOBAL_CERRADO',
          payload: {
            holdId: hold.id,
            tipoHold: hold.tipo,
            alcance: 'global',
            motivo: hold.motivo,
            efecto: 'Se reanuda la solicitud de unidades salvo que persista un hold propio.',
            operacionesAfectadas: afectadas.length,
            operacionesAunBloqueadas: siguenBloqueadas.length,
          },
          userId,
        });

        return {
          kind: 'ok' as const,
          hold,
          afectadas: afectadas.length,
          aunBloqueadas: siguenBloqueadas.map((o) => o.mawb),
          eventos,
        };
      });

      if (resultado.kind === 'no_encontrado') {
        res.status(404).json({ error: 'Hold global activo no encontrado' });
        return;
      }

      await recordAudit({
        userId,
        action: 'HOLD_GLOBAL_CERRADO',
        entity: 'operacion_hold',
        entityId: resultado.hold.id,
        after: {
          tipo: resultado.hold.tipo,
          alcance: 'global',
          motivo: resultado.hold.motivo,
          abiertoAt: resultado.hold.abiertoAt,
          cerradoAt: resultado.hold.cerradoAt,
          operacionesAfectadas: resultado.afectadas,
          mawbsAunBloqueadas: resultado.aunBloqueadas,
        },
        ip: req.ip,
      });

      res.json({
        ok: true,
        holdId: resultado.hold.id,
        tipo: resultado.hold.tipo,
        alcance: 'global',
        cerradoAt: resultado.hold.cerradoAt,
        operacionesAfectadas: resultado.afectadas,
        operacionesAunBloqueadas: resultado.aunBloqueadas.length,
        eventosRegistrados: resultado.eventos,
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /api/operaciones/holds/global — is the operation frozen right now?
 *
 * Open to every authenticated role including `autoridad` and `tramitador`. The tramitador especially:
 * he is the one who would otherwise walk cargo to a dock during an audit, and "everything is stopped"
 * is not privileged information — it is the information that prevents wasted work.
 */
holdsRouter.get(
  '/holds/global',
  requireAuth,
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const { rows } = await query(
        `SELECT h.id,
                h.tipo,
                h.alcance,
                h.motivo,
                h.activo,
                h.abierto_at  AS "abiertoAt",
                h.abierto_por AS "abiertoPor",
                u.username    AS "abiertoPorUsuario"
           FROM operacion_holds h
           LEFT JOIN users u ON u.id = h.abierto_por
          WHERE h.activo AND h.operacion_id IS NULL
          ORDER BY h.abierto_at DESC`,
      );
      res.json({ holdGlobalActivo: rows.length > 0, holds: rows });
    } catch (err) {
      next(err);
    }
  },
);

// =================================================================================================
// PER-OPERACIÓN — every `:id` validated as a UUID, so 'holds' can never be captured as a caso id.
// =================================================================================================

/**
 * POST /api/operaciones/:id/holds — CT-3 (csa) and CT-4 (riesgo), plus the documental cases.
 *
 * `capturista` allowed alongside `admin`: these blocks are discovered during cotejo and during the
 * risk follow-up, which is capturista work. `tramitador` is NOT allowed — the field role reports
 * facts, it does not decide that a shipment is blocked.
 *
 * `alcance = 'guia'` must name a guía that belongs to THIS caso. A guía id from another operación
 * would freeze the wrong client's cargo while appearing, on this caso's screen, to be about this one:
 * a block filed against the wrong shipment is worse than no block at all.
 */
holdsRouter.post(
  '/:id/holds',
  requireAuth,
  requireRole('admin', 'capturista'),
  validate({ params: holdOperacionParam, body: holdOperacionBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const { tipo, alcance, operacionGuiaId, motivo } = req.body as HoldOperacionBody;
      const userId = req.user!.userId;

      if (alcance === 'guia' && !operacionGuiaId) {
        res.status(400).json({
          error: "Un hold con alcance 'guia' requiere `operacionGuiaId`: hay que decir cuál guía queda bloqueada.",
        });
        return;
      }
      // Rejected rather than silently ignored. An `operacionGuiaId` sent with alcance 'operacion'
      // means the caller believes one guía is blocked while the row would say the whole caso is;
      // discarding the field would hide that disagreement instead of surfacing it.
      if (alcance === 'operacion' && operacionGuiaId) {
        res.status(400).json({
          error: "Un hold con alcance 'operacion' no lleva `operacionGuiaId`; usa alcance 'guia' para bloquear una sola guía.",
        });
        return;
      }

      const resultado = await withTransaction(async (q) => {
        const op = await q(
          'SELECT id, mawb FROM operaciones WHERE id = $1 FOR UPDATE',
          [id],
        );
        if (!op.rows.length) return { kind: 'no_encontrada' as const };
        const operacion = op.rows[0] as { id: string; mawb: string };

        let guia: { id: string; guiaNorm: string } | null = null;
        if (operacionGuiaId) {
          const g = await q(
            'SELECT id, guia_norm AS "guiaNorm" FROM operacion_guias WHERE id = $1 AND operacion_id = $2',
            [operacionGuiaId, id],
          );
          if (!g.rows.length) return { kind: 'guia_ajena' as const };
          guia = g.rows[0] as { id: string; guiaNorm: string };
        }

        const ins = await q(
          `INSERT INTO operacion_holds
             (operacion_id, tipo, alcance, operacion_guia_id, activo, abierto_por, motivo)
           VALUES ($1,$2,$3,$4,true,$5,$6)
           RETURNING id, abierto_at AS "abiertoAt"`,
          [id, tipo, alcance, guia?.id ?? null, userId, motivo],
        );
        const hold = ins.rows[0] as { id: string; abiertoAt: Date };

        const holdActivo = await materializarUna(q, id);
        const eventoId = await registrarEvento(q, {
          operacionId: operacion.id,
          mawb: operacion.mawb,
          tipo: 'HOLD_ABIERTO',
          payload: {
            holdId: hold.id,
            tipoHold: tipo,
            alcance,
            operacionGuiaId: guia?.id ?? null,
            guia: guia?.guiaNorm ?? null,
            motivo,
          },
          userId,
        });

        return { kind: 'ok' as const, hold, holdActivo, eventoId, mawb: operacion.mawb, guia };
      });

      switch (resultado.kind) {
        case 'no_encontrada':
          res.status(404).json({ error: 'Operación no encontrada' });
          return;
        case 'guia_ajena':
          res.status(400).json({ error: 'La `operacionGuiaId` indicada no pertenece a esta operación.' });
          return;
        default:
          break;
      }

      await recordAudit({
        userId,
        action: 'HOLD_ABIERTO',
        entity: 'operacion_hold',
        entityId: resultado.hold.id,
        after: {
          operacionId: id,
          mawb: resultado.mawb,
          tipo,
          alcance,
          operacionGuiaId: resultado.guia?.id ?? null,
          motivo,
          holdActivo: resultado.holdActivo,
        },
        ip: req.ip,
      });

      res.status(201).json({
        ok: true,
        holdId: resultado.hold.id,
        operacionId: id,
        tipo,
        alcance,
        operacionGuiaId: resultado.guia?.id ?? null,
        motivo,
        abiertoAt: resultado.hold.abiertoAt,
        holdActivo: resultado.holdActivo,
        eventoId: resultado.eventoId,
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * DELETE /api/operaciones/:id/holds/:holdId — the cesión letter arrived, the client answered.
 *
 * The response carries `holdActivo` after the recompute, which is frequently `true`: closing one hold
 * does not release a caso that also sits under a global freeze or under a second hold. Returning the
 * recomputed value rather than an implied `false` is what keeps the caller from telling a coordinator
 * that a shipment is free to plan when it is not.
 */
holdsRouter.delete(
  '/:id/holds/:holdId',
  requireAuth,
  requireRole('admin', 'capturista'),
  validate({ params: holdOperacionHoldParam }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id, holdId } = req.params;
      const userId = req.user!.userId;

      const resultado = await withTransaction(async (q) => {
        const op = await q('SELECT id, mawb FROM operaciones WHERE id = $1 FOR UPDATE', [id]);
        if (!op.rows.length) return { kind: 'no_encontrada' as const };
        const operacion = op.rows[0] as { id: string; mawb: string };

        const upd = await q(
          `UPDATE operacion_holds
              SET activo = false, cerrado_at = now(), cerrado_por = $3
            WHERE id = $1 AND operacion_id = $2 AND activo
            RETURNING id, tipo, alcance, motivo, operacion_guia_id AS "operacionGuiaId",
                      abierto_at AS "abiertoAt", cerrado_at AS "cerradoAt"`,
          [holdId, id, userId],
        );
        if (!upd.rows.length) return { kind: 'hold_no_encontrado' as const };
        const hold = upd.rows[0] as {
          id: string;
          tipo: string;
          alcance: string;
          motivo: string;
          operacionGuiaId: string | null;
          abiertoAt: Date;
          cerradoAt: Date;
        };

        const holdActivo = await materializarUna(q, id);
        const eventoId = await registrarEvento(q, {
          operacionId: operacion.id,
          mawb: operacion.mawb,
          tipo: 'HOLD_CERRADO',
          payload: {
            holdId: hold.id,
            tipoHold: hold.tipo,
            alcance: hold.alcance,
            operacionGuiaId: hold.operacionGuiaId,
            motivo: hold.motivo,
            // Reported because it is the operational answer: does this shipment move now, or not yet?
            holdActivoTrasCierre: holdActivo,
          },
          userId,
        });

        return { kind: 'ok' as const, hold, holdActivo, eventoId, mawb: operacion.mawb };
      });

      switch (resultado.kind) {
        case 'no_encontrada':
          res.status(404).json({ error: 'Operación no encontrada' });
          return;
        case 'hold_no_encontrado':
          res.status(404).json({ error: 'Hold activo no encontrado para esta operación' });
          return;
        default:
          break;
      }

      await recordAudit({
        userId,
        action: 'HOLD_CERRADO',
        entity: 'operacion_hold',
        entityId: resultado.hold.id,
        after: {
          operacionId: id,
          mawb: resultado.mawb,
          tipo: resultado.hold.tipo,
          alcance: resultado.hold.alcance,
          motivo: resultado.hold.motivo,
          abiertoAt: resultado.hold.abiertoAt,
          cerradoAt: resultado.hold.cerradoAt,
          holdActivo: resultado.holdActivo,
        },
        ip: req.ip,
      });

      res.json({
        ok: true,
        holdId: resultado.hold.id,
        operacionId: id,
        cerradoAt: resultado.hold.cerradoAt,
        holdActivo: resultado.holdActivo,
        eventoId: resultado.eventoId,
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /api/operaciones/:id/holds — this caso's own holds, active first, then most recent.
 *
 * Closed holds are returned too, deliberately: the history of what blocked a shipment and for how long
 * is the audit answer, and hiding it behind a query flag guarantees nobody looks. Global holds are NOT
 * merged in — they are not properties of this caso and have their own endpoint; `hold_activo` on the
 * operación is where the combined answer lives.
 */
holdsRouter.get(
  '/:id/holds',
  requireAuth,
  validate({ params: holdOperacionParam }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const op = await query('SELECT id FROM operaciones WHERE id = $1', [id]);
      if (!op.rows.length) {
        res.status(404).json({ error: 'Operación no encontrada' });
        return;
      }

      const { rows } = await query(
        `SELECT h.id,
                h.tipo,
                h.alcance,
                h.operacion_guia_id AS "operacionGuiaId",
                g.guia_norm         AS "guiaNorm",
                h.activo,
                h.motivo,
                h.abierto_at        AS "abiertoAt",
                h.cerrado_at        AS "cerradoAt",
                h.abierto_por       AS "abiertoPor",
                ua.username         AS "abiertoPorUsuario",
                h.cerrado_por       AS "cerradoPor",
                uc.username         AS "cerradoPorUsuario"
           FROM operacion_holds h
           LEFT JOIN operacion_guias g ON g.id = h.operacion_guia_id
           LEFT JOIN users ua ON ua.id = h.abierto_por
           LEFT JOIN users uc ON uc.id = h.cerrado_por
          WHERE h.operacion_id = $1
          ORDER BY h.activo DESC, h.abierto_at DESC`,
        [id],
      );
      res.json(rows);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /api/operaciones/:id/retenciones — CT-5, the pallet the authority pulled.
 *
 * `tramitador` is allowed here and nowhere else in this file, and that is the design: he is the person
 * standing on the dock watching one pallet get separated from the load. Making him route the fact
 * through an office phone call is how the pedimento ends up declaring cargo that did not leave.
 *
 * A `parcial` retención naming a guía also walks that guía to `estado = 'retenida'`. That is the flag
 * the pedimento module and the planner read: the guía is out of today's load, the rest of the caso is
 * not. The retención row is the reason; the guía state is the consequence. Both in one transaction,
 * because a retención whose guía still reads `liberada` would let the pedimento declare the pallet
 * that is sitting in the authority's custody.
 *
 * A `total` retención does NOT touch guía states here: the whole caso is held, and deciding what that
 * implies for each guía, the plan and the despachos belongs to the contingency engine (§8.8).
 */
holdsRouter.post(
  '/:id/retenciones',
  requireAuth,
  requireRole('admin', 'capturista', 'tramitador'),
  validate({ params: holdOperacionParam, body: retencionBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const { alcance, unidad, cantidad, motivo, oficioReferencia, operacionGuiaId } =
        req.body as RetencionBody;
      const userId = req.user!.userId;

      const resultado = await withTransaction(async (q) => {
        const op = await q('SELECT id, mawb FROM operaciones WHERE id = $1 FOR UPDATE', [id]);
        if (!op.rows.length) return { kind: 'no_encontrada' as const };
        const operacion = op.rows[0] as { id: string; mawb: string };

        let guia: { id: string; guiaNorm: string; estado: string } | null = null;
        if (operacionGuiaId) {
          const g = await q(
            `SELECT id, guia_norm AS "guiaNorm", estado
               FROM operacion_guias WHERE id = $1 AND operacion_id = $2 FOR UPDATE`,
            [operacionGuiaId, id],
          );
          if (!g.rows.length) return { kind: 'guia_ajena' as const };
          guia = g.rows[0] as { id: string; guiaNorm: string; estado: string };
        }

        const ins = await q(
          `INSERT INTO retenciones
             (operacion_id, operacion_guia_id, alcance, unidad, cantidad, motivo,
              estado, oficio_referencia, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,'retenida',$7,$8)
           RETURNING id, estado, retenida_at AS "retenidaAt"`,
          [
            id,
            guia?.id ?? null,
            alcance,
            unidad ?? null,
            cantidad ?? null,
            motivo,
            oficioReferencia ?? null,
            userId,
          ],
        );
        const retencion = ins.rows[0] as { id: string; estado: string; retenidaAt: Date };

        let guiaEstado: string | null = guia?.estado ?? null;
        if (alcance === 'parcial' && guia) {
          const upd = await q(
            `UPDATE operacion_guias SET estado = 'retenida' WHERE id = $1 RETURNING estado`,
            [guia.id],
          );
          guiaEstado = String(upd.rows[0].estado);
        }

        const eventoId = await registrarEvento(q, {
          operacionId: operacion.id,
          mawb: operacion.mawb,
          tipo: 'RETENCION_CREADA',
          payload: {
            retencionId: retencion.id,
            alcance,
            unidad: unidad ?? null,
            cantidad: cantidad ?? null,
            motivo,
            oficioReferencia: oficioReferencia ?? null,
            operacionGuiaId: guia?.id ?? null,
            guia: guia?.guiaNorm ?? null,
            guiaEstadoAnterior: guia?.estado ?? null,
            guiaEstado,
            // The consequence the pedimento module must honour (CT-5 / §9.7).
            efecto: 'El pedimento debe declarar la carga real que sale; lo retenido queda en custodia.',
          },
          userId,
        });

        return { kind: 'ok' as const, retencion, guia, guiaEstado, eventoId, mawb: operacion.mawb };
      });

      switch (resultado.kind) {
        case 'no_encontrada':
          res.status(404).json({ error: 'Operación no encontrada' });
          return;
        case 'guia_ajena':
          res.status(400).json({ error: 'La `operacionGuiaId` indicada no pertenece a esta operación.' });
          return;
        default:
          break;
      }

      await recordAudit({
        userId,
        action: 'RETENCION_CREADA',
        entity: 'retencion',
        entityId: resultado.retencion.id,
        after: {
          operacionId: id,
          mawb: resultado.mawb,
          alcance,
          unidad: unidad ?? null,
          cantidad: cantidad ?? null,
          motivo,
          oficioReferencia: oficioReferencia ?? null,
          operacionGuiaId: resultado.guia?.id ?? null,
          guiaEstado: resultado.guiaEstado,
        },
        ip: req.ip,
      });

      res.status(201).json({
        ok: true,
        retencionId: resultado.retencion.id,
        operacionId: id,
        alcance,
        unidad: unidad ?? null,
        cantidad: cantidad ?? null,
        estado: resultado.retencion.estado,
        retenidaAt: resultado.retencion.retenidaAt,
        operacionGuiaId: resultado.guia?.id ?? null,
        guiaEstado: resultado.guiaEstado,
        eventoId: resultado.eventoId,
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /api/operaciones/:id/retenciones/:rid/liberar — the authority released the pallet.
 *
 * `admin`/`capturista` only, NO tramitador: creating a retención is reporting what you saw, releasing
 * one is asserting that the authority let the cargo go — an office act against a document. Giving the
 * field role both ends would make the whole custody trail self-certifying.
 *
 * The guía is walked back to `liberada` only when it is currently `retenida`. A guía that has since
 * been `cancelada` (or already moved on) must not be dragged backwards by the release of one pallet;
 * the retención's own `estado` is the record of the release either way.
 *
 * 409, not 200, on a retención that is not `retenida`: `destruida` and `abandonada` are terminal, and
 * quietly "releasing" cargo that was destroyed would put a fiction in the ledger.
 */
holdsRouter.post(
  '/:id/retenciones/:rid/liberar',
  requireAuth,
  requireRole('admin', 'capturista'),
  validate({ params: retencionParam }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id, rid } = req.params;
      const userId = req.user!.userId;

      const resultado = await withTransaction(async (q) => {
        const op = await q('SELECT id, mawb FROM operaciones WHERE id = $1 FOR UPDATE', [id]);
        if (!op.rows.length) return { kind: 'no_encontrada' as const };
        const operacion = op.rows[0] as { id: string; mawb: string };

        const ret = await q(
          `SELECT id, estado, alcance, operacion_guia_id AS "operacionGuiaId", motivo
             FROM retenciones WHERE id = $1 AND operacion_id = $2 FOR UPDATE`,
          [rid, id],
        );
        if (!ret.rows.length) return { kind: 'retencion_no_encontrada' as const };
        const actual = ret.rows[0] as {
          id: string;
          estado: string;
          alcance: string;
          operacionGuiaId: string | null;
          motivo: string;
        };
        if (actual.estado !== 'retenida') {
          return { kind: 'estado_invalido' as const, estado: actual.estado };
        }

        const upd = await q(
          `UPDATE retenciones
              SET estado = 'liberada', liberada_at = now()
            WHERE id = $1
            RETURNING estado, liberada_at AS "liberadaAt"`,
          [rid],
        );
        const liberada = upd.rows[0] as { estado: string; liberadaAt: Date };

        let guiaEstado: string | null = null;
        if (actual.operacionGuiaId) {
          const g = await q(
            `UPDATE operacion_guias
                SET estado = 'liberada'
              WHERE id = $1 AND estado = 'retenida'
              RETURNING estado`,
            [actual.operacionGuiaId],
          );
          if (g.rows.length) {
            guiaEstado = String(g.rows[0].estado);
          } else {
            const actualG = await q('SELECT estado FROM operacion_guias WHERE id = $1', [
              actual.operacionGuiaId,
            ]);
            guiaEstado = actualG.rows.length ? String(actualG.rows[0].estado) : null;
          }
        }

        const eventoId = await registrarEvento(q, {
          operacionId: operacion.id,
          mawb: operacion.mawb,
          tipo: 'RETENCION_LIBERADA',
          payload: {
            retencionId: actual.id,
            alcance: actual.alcance,
            motivo: actual.motivo,
            operacionGuiaId: actual.operacionGuiaId,
            guiaEstado,
            liberadaAt: liberada.liberadaAt,
            // §9.7: on release the cargo re-enters a later plan. Executing that is the engine's job.
            efecto: 'La carga liberada se reincorpora al plan.',
          },
          userId,
        });

        return { kind: 'ok' as const, retencion: actual, liberada, guiaEstado, eventoId, mawb: operacion.mawb };
      });

      switch (resultado.kind) {
        case 'no_encontrada':
          res.status(404).json({ error: 'Operación no encontrada' });
          return;
        case 'retencion_no_encontrada':
          res.status(404).json({ error: 'Retención no encontrada para esta operación' });
          return;
        case 'estado_invalido':
          res.status(409).json({
            error: `La retención está en estado '${resultado.estado}' y sólo se puede liberar una retención 'retenida'.`,
            estado: resultado.estado,
          });
          return;
        default:
          break;
      }

      await recordAudit({
        userId,
        action: 'RETENCION_LIBERADA',
        entity: 'retencion',
        entityId: resultado.retencion.id,
        after: {
          operacionId: id,
          mawb: resultado.mawb,
          alcance: resultado.retencion.alcance,
          motivo: resultado.retencion.motivo,
          operacionGuiaId: resultado.retencion.operacionGuiaId,
          guiaEstado: resultado.guiaEstado,
          liberadaAt: resultado.liberada.liberadaAt,
        },
        ip: req.ip,
      });

      res.json({
        ok: true,
        retencionId: resultado.retencion.id,
        operacionId: id,
        estado: resultado.liberada.estado,
        liberadaAt: resultado.liberada.liberadaAt,
        operacionGuiaId: resultado.retencion.operacionGuiaId,
        guiaEstado: resultado.guiaEstado,
        eventoId: resultado.eventoId,
      });
    } catch (err) {
      next(err);
    }
  },
);
