import { query } from '../db/pool';
import { withTransaction } from '../db/tx';
import { recordAudit } from './audit';
import { mirrorEstadoDeOperacion, mirrorEventoToAgora } from './agoraMirror';
import type { EstadoPlaneacion } from '../../../shared/operaciones/estados';
import {
  EVENTO_POR_ACCION,
  REPLAN_RULESET,
  REPLAN_RULESET_HASH,
  REPLAN_RULESET_VERSION,
  claveAccion,
  esAutomatica,
  evaluarContingencias,
  planeacionTrasContingencia,
  type AccionPropuesta,
  type CandidataReasignacion,
  type EstadoOperativo,
} from '../../../shared/operaciones/replan';

/**
 * Contingency engine — the server half (PRD-02 §8.8, CT-1…CT-7).
 *
 * The decisions live in `shared/operaciones/replan.ts`, which is pure and knows nothing about a
 * database. This file does three things and deliberately no thinking of its own:
 *
 *   1. ASSEMBLES the snapshot. Every query here is part of the reproducibility contract — whatever it
 *      reads is stored verbatim in `replan_evaluaciones.snapshot`, so a decision can be replayed in
 *      December against the world as it was in August. That is also why the candidate query has a
 *      total ordering: a non-deterministic candidate list would make the same facts produce different
 *      records.
 *   2. EXECUTES the automatic actions, and only those. `esAutomatica` is asked, never re-derived —
 *      the money boundary (D6/P3/R20) is written down in exactly one place.
 *   3. FILES the money-touching proposal for a human, because an append-only event cannot wait for an
 *      answer and a reassignment that changes a tarifa needs one.
 *
 * THE ANTI-STUTTER RULE. The tick re-evaluates a caso every few minutes and a flight stays cancelled
 * for hours. Before anything is written, the actions already recorded for this caso are subtracted by
 * fingerprint (`claveAccion`), so a re-run over unchanged facts writes NOTHING: no evaluation row, no
 * ledger event, no audit row. `operacion_eventos` is append-only and can never be cleaned, so a
 * chatty engine would be a permanent defect.
 *
 * WHAT THIS DOES NOT DO, AND WHY THAT IS HONEST. `notificar` records that an advice is OWED
 * (NOTIFICACION_REQUERIDA); it does not send anything, because outbound email does not exist yet
 * (#22) and the fan-out is #31. `suspender_solicitud_unidades` records the suspension per caso; when
 * the `despachos` table lands (#29) it will also walk each unit to `en_espera`. Claiming either
 * happened would be exactly the "unverifiable ≠ verified" failure this platform exists to prevent.
 */

export type Disparador = 'tick' | 'manual' | 'vuelo' | 'hold' | 'guia';

export interface ResultadoReplan {
  operacionId: string;
  mawb: string;
  /** Null when nothing new was decided — the common case on a repeat tick. */
  evaluacionId: string | null;
  accionesNuevas: number;
  ejecutadas: number;
  propuestas: number;
  /** Actions the engine re-derived that were already on record. */
  omitidas: number;
  /** The planning state the caso ended in, when the engine moved it. */
  estadoPlaneacion: EstadoPlaneacion | null;
  contingencias: string[];
}

type Q = (text: string, params?: unknown[]) => Promise<any>;

interface OperacionRow {
  id: string;
  mawb: string;
  etapa: string;
  estado_planeacion: string;
  estado_documental: string;
  eta_pais: string | null;
  destino_iata: string | null;
  numero_vuelo: string | null;
  discrepancias: Array<{ codigo?: string }> | null;
  agora_conversation_id: string | null;
  vuelo_estado: string | null;
  vuelo_numero: string | null;
  vuelo_eta_programado: string | null;
  vuelo_eta_estimado: string | null;
  vuelo_arribo_real: string | null;
  vuelo_destino_iata: string | null;
}

/**
 * Which casos could absorb a unit that just lost its cargo (R16 "buscar reemplazo", D10).
 *
 * The filter IS the definition of "loadable today": cargo on the ground, nothing frozen, not already
 * committed elsewhere, and at least one guía that can actually be dispatched. Same destination first,
 * because reassigning a truck to the other side of the city is a different trip and a different
 * tarifa. The ORDER BY is total (down to `mawb`) so the proposal is reproducible.
 */
async function buscarCandidatas(
  operacionId: string,
  destinoIata: string | null,
): Promise<CandidataReasignacion[]> {
  const { rows } = await query<{
    operacionId: string;
    mawb: string;
    destinoIata: string | null;
    mismoDestino: boolean;
  }>(
    `SELECT o.id           AS "operacionId",
            o.mawb,
            o.destino_iata AS "destinoIata",
            (o.destino_iata IS NOT DISTINCT FROM $2) AS "mismoDestino"
       FROM operaciones o
      WHERE o.id <> $1
        AND o.etapa IN ('arribado','disponible')
        AND NOT o.hold_activo
        AND o.estado_planeacion IN ('sin_plan','planeada')
        AND NOT EXISTS (
              SELECT 1 FROM operacion_guias g
               WHERE g.operacion_id = o.id
               GROUP BY g.operacion_id
              HAVING count(*) FILTER (
                       WHERE g.estado NOT IN ('no_transmitida','retenida','cancelada','csa_pendiente')
                     ) = 0)
      ORDER BY (o.destino_iata IS NOT DISTINCT FROM $2) DESC, o.arribo_vuelo_at DESC NULLS LAST, o.mawb
      LIMIT $3`,
    [operacionId, destinoIata, REPLAN_RULESET.maxCandidatas],
  );
  return rows.map((r) => ({
    operacionId: r.operacionId,
    mawb: r.mawb,
    destinoIata: r.destinoIata,
    razon: r.mismoDestino ? 'Carga en piso, sin bloqueos, mismo destino.' : 'Carga en piso, sin bloqueos.',
  }));
}

/**
 * Assemble the engine input. Returns null when the caso does not exist.
 *
 * `ahora` is captured once here and travels in the snapshot, so the stored record says exactly what
 * "now" meant to the engine.
 */
export async function construirEstado(operacionId: string): Promise<EstadoOperativo | null> {
  const { rows } = await query<OperacionRow>(
    `SELECT o.id, o.mawb, o.etapa, o.estado_planeacion, o.estado_documental,
            o.eta_pais, o.destino_iata, o.numero_vuelo, o.discrepancias, o.agora_conversation_id,
            v.estado         AS vuelo_estado,
            v.numero_vuelo   AS vuelo_numero,
            v.eta_programado AS vuelo_eta_programado,
            v.eta_estimado   AS vuelo_eta_estimado,
            v.arribo_real    AS vuelo_arribo_real,
            v.destino_iata   AS vuelo_destino_iata
       FROM operaciones o
       LEFT JOIN vuelos v ON v.id = o.vuelo_id
      WHERE o.id = $1`,
    [operacionId],
  );
  const op = rows[0];
  if (!op) return null;

  const [guias, holds, retenciones, candidatas] = await Promise.all([
    query<{ id: string; guiaNorm: string; estado: string }>(
      `SELECT id, guia_norm AS "guiaNorm", estado
         FROM operacion_guias WHERE operacion_id = $1 ORDER BY guia_norm`,
      [operacionId],
    ),
    // Global holds included: `operacion_id IS NULL` is the CT-6 freeze and the engine has to see it.
    query<{ id: string; tipo: string; alcance: string; operacionGuiaId: string | null; motivo: string }>(
      `SELECT id, tipo, alcance, operacion_guia_id AS "operacionGuiaId", motivo
         FROM operacion_holds
        WHERE activo AND (operacion_id IS NULL OR operacion_id = $1)
        ORDER BY abierto_at, id`,
      [operacionId],
    ),
    query<{ id: string; alcance: string; estado: string; operacionGuiaId: string | null }>(
      `SELECT id, alcance, estado, operacion_guia_id AS "operacionGuiaId"
         FROM retenciones
        WHERE operacion_id = $1 AND estado = 'retenida'
        ORDER BY retenida_at, id`,
      [operacionId],
    ),
    buscarCandidatas(operacionId, op.destino_iata),
  ]);

  const iso = (v: unknown): string | null =>
    v instanceof Date ? v.toISOString() : typeof v === 'string' ? v : null;

  return {
    ahora: new Date().toISOString(),
    operacion: {
      id: op.id,
      mawb: op.mawb,
      etapa: op.etapa as EstadoOperativo['operacion']['etapa'],
      estadoPlaneacion: op.estado_planeacion as EstadoPlaneacion,
      estadoDocumental: op.estado_documental as EstadoOperativo['operacion']['estadoDocumental'],
      etaPais: iso(op.eta_pais),
      discrepancias: (op.discrepancias ?? [])
        .map((d) => (typeof d?.codigo === 'string' ? d.codigo : null))
        .filter((c): c is string => c !== null),
    },
    vuelo: op.vuelo_estado
      ? {
          numeroVuelo: op.vuelo_numero ?? op.numero_vuelo,
          estado: op.vuelo_estado,
          etaProgramado: iso(op.vuelo_eta_programado),
          etaEstimado: iso(op.vuelo_eta_estimado),
          arriboReal: iso(op.vuelo_arribo_real),
          destinoIata: op.vuelo_destino_iata ?? op.destino_iata,
        }
      : null,
    holds: holds.rows as EstadoOperativo['holds'],
    retenciones: retenciones.rows as EstadoOperativo['retenciones'],
    guias: guias.rows,
    // Empty until backlog #29 creates the table. CT-7 falls back to the `asignada` signal; see
    // shared/operaciones/replan.ts.
    despachos: [],
    candidatas,
  };
}

/** The ledger payload of an action, self-contained enough to be read six weeks later. */
function payloadDe(accion: AccionPropuesta): Record<string, unknown> {
  const { tipo, contingencia, motivo, ejecucion, ...resto } = accion;
  return {
    contingencia,
    accion: tipo,
    ejecucion,
    motivo,
    rulesetVersion: REPLAN_RULESET_VERSION,
    rulesetHash: REPLAN_RULESET_HASH,
    ...resto,
  };
}

/**
 * Write one ledger row.
 *
 * `origen` is 'sistema' even for a manually triggered evaluation: the coordinator asked the engine to
 * look, the engine decided. Attributing the decision to the person who pressed the button would put a
 * name on a conclusion they did not reach.
 */
async function registrarEvento(
  q: Q,
  args: { operacionId: string; mawb: string; tipo: string; payload: Record<string, unknown>; userId: string | null },
): Promise<string> {
  const { rows } = await q(
    `INSERT INTO operacion_eventos
       (operacion_id, operacion_mawb, tipo, origen, ocurrido_at, payload, created_by)
     VALUES ($1,$2,$3,'sistema',now(),$4,$5)
     RETURNING id`,
    [args.operacionId, args.mawb, args.tipo, JSON.stringify(args.payload), args.userId],
  );
  return String(rows[0].id);
}

/**
 * Open a hold the engine decided on (CT-3 csa, CT-4 riesgo) and refresh the materialized flag.
 *
 * `abierto_por` is NULL because no human opened it — that null IS the record that the system did, and
 * the `origen = 'sistema'` event next to it says the same thing in the timeline. Returns null when a
 * hold of that type is already active: the snapshot said otherwise, but between the read and this
 * write a coordinator may have opened one, and two open holds mean cargo stays frozen after the first
 * is released.
 */
async function abrirHold(
  q: Q,
  args: { operacionId: string; tipo: string; motivo: string },
): Promise<{ holdId: string; holdActivo: boolean } | null> {
  const existente = await q(
    `SELECT id FROM operacion_holds
      WHERE activo AND operacion_id = $1 AND tipo = $2 LIMIT 1`,
    [args.operacionId, args.tipo],
  );
  if (existente.rows.length) return null;

  const ins = await q(
    `INSERT INTO operacion_holds (operacion_id, tipo, alcance, activo, abierto_por, motivo)
     VALUES ($1,$2,'operacion',true,NULL,$3)
     RETURNING id`,
    [args.operacionId, args.tipo, args.motivo],
  );
  const upd = await q(
    `UPDATE operaciones o
        SET hold_activo = EXISTS (
              SELECT 1 FROM operacion_holds h
               WHERE h.activo AND (h.operacion_id IS NULL OR h.operacion_id = o.id))
      WHERE o.id = $1
      RETURNING hold_activo`,
    [args.operacionId],
  );
  return { holdId: String(ins.rows[0].id), holdActivo: Boolean(upd.rows[0]?.hold_activo) };
}

/**
 * Evaluate one caso and apply what may be applied.
 *
 * The whole write side runs inside one transaction with the operación row locked, so a tick and a
 * coordinator pressing "re-evaluar" cannot both decide the same exclusion. `recordAudit` runs AFTER
 * the commit, per the house rule (advisory-lock deadlock otherwise).
 */
export async function evaluarOperacion(args: {
  operacionId: string;
  disparador: Disparador;
  userId?: string | null;
}): Promise<ResultadoReplan | null> {
  const estado = await construirEstado(args.operacionId);
  if (!estado) return null;

  const userId = args.userId ?? null;
  const vacio: ResultadoReplan = {
    operacionId: estado.operacion.id,
    mawb: estado.operacion.mawb,
    evaluacionId: null,
    accionesNuevas: 0,
    ejecutadas: 0,
    propuestas: 0,
    omitidas: 0,
    estadoPlaneacion: null,
    contingencias: [],
  };

  const acciones = evaluarContingencias(estado);
  if (!acciones.length) return vacio;

  const resultado = await withTransaction(async (q) => {
    // Lock the caso, and re-read the planning axis: the snapshot was assembled outside the lock and
    // the field app or another evaluation may have moved it since.
    const opRes = await q(
      'SELECT id, mawb, estado_planeacion, agora_conversation_id FROM operaciones WHERE id = $1 FOR UPDATE',
      [args.operacionId],
    );
    if (!opRes.rows.length) return null;
    const op = opRes.rows[0] as {
      id: string;
      mawb: string;
      estado_planeacion: EstadoPlaneacion;
      agora_conversation_id: string | null;
    };

    // Every fingerprint ever recorded for this caso, whatever became of it. A proposal the
    // coordinator discarded must NOT come back on the next tick: re-asking a question somebody
    // already answered is how a real alert gets ignored. A genuinely different decision — another
    // guía, a new reprogramming date — carries a different fingerprint and gets through.
    const yaRegistradas = await q(
      `SELECT clave FROM replan_acciones WHERE operacion_id = $1`,
      [args.operacionId],
    );
    const vistas = new Set<string>(yaRegistradas.rows.map((r: { clave: string }) => r.clave));
    const nuevas = acciones.filter((a) => !vistas.has(claveAccion(a)));
    const omitidas = acciones.length - nuevas.length;
    if (!nuevas.length) return { kind: 'sin_novedad' as const, omitidas };

    const evalRes = await q(
      `INSERT INTO replan_evaluaciones
         (operacion_id, ruleset_version, ruleset_hash, disparador, snapshot, acciones, created_by)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)
       RETURNING id`,
      [
        args.operacionId,
        REPLAN_RULESET_VERSION,
        REPLAN_RULESET_HASH,
        args.disparador,
        JSON.stringify(estado),
        nuevas.length,
        userId,
      ],
    );
    const evaluacionId = String(evalRes.rows[0].id);

    // ONE write to the planning axis for the whole evaluation, computed by the state-machine rule in
    // the pure module. Several actions can imply exclusion; the caso has one planning state.
    const nuevoPlan = planeacionTrasContingencia(op.estado_planeacion, nuevas);
    if (nuevoPlan) {
      await q('UPDATE operaciones SET estado_planeacion = $2 WHERE id = $1', [args.operacionId, nuevoPlan]);
    }

    let ejecutadas = 0;
    let propuestas = 0;
    const espejables: Array<{ tipo: string; payload: Record<string, unknown> }> = [];

    for (const accion of nuevas) {
      const automatica = esAutomatica(accion);
      const payload: Record<string, unknown> = { ...payloadDe(accion), evaluacionId };

      let estadoAccion: 'ejecutada' | 'propuesta' | 'fallida' = automatica ? 'ejecutada' : 'propuesta';

      if (accion.tipo === 'abrir_hold') {
        const hold = await abrirHold(q, {
          operacionId: args.operacionId,
          tipo: accion.tipoHold,
          motivo: accion.motivo,
        });
        if (!hold) {
          // Someone beat us to it. Recording it as `fallida` rather than dropping it keeps the
          // decision visible: the engine wanted this block, and it exists — just not by its hand.
          estadoAccion = 'fallida';
          payload.omitido = 'ya existía un hold activo de ese tipo';
        } else {
          payload.holdId = hold.holdId;
          payload.tipoHold = accion.tipoHold;
          payload.alcance = 'operacion';
          payload.holdActivo = hold.holdActivo;
        }
      }

      if (accion.tipo === 'excluir_del_plan' || accion.tipo === 'reprogramar') {
        payload.estadoPlaneacionAnterior = op.estado_planeacion;
        payload.estadoPlaneacion = nuevoPlan ?? op.estado_planeacion;
      }

      let eventoId: string | null = null;
      if (estadoAccion !== 'fallida') {
        eventoId = await registrarEvento(q, {
          operacionId: op.id,
          mawb: op.mawb,
          tipo: EVENTO_POR_ACCION[accion.tipo],
          payload,
          userId,
        });
        espejables.push({ tipo: EVENTO_POR_ACCION[accion.tipo], payload });
      }

      await q(
        `INSERT INTO replan_acciones
           (evaluacion_id, operacion_id, contingencia, tipo, clave, ejecucion, estado, payload, motivo, evento_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`,
        [
          evaluacionId,
          args.operacionId,
          accion.contingencia,
          accion.tipo,
          claveAccion(accion),
          automatica ? 'automatica' : 'propuesta',
          estadoAccion,
          JSON.stringify(payload),
          accion.motivo,
          eventoId,
        ],
      );

      if (estadoAccion === 'ejecutada') ejecutadas += 1;
      else if (estadoAccion === 'propuesta') propuestas += 1;
    }

    return {
      kind: 'ok' as const,
      evaluacionId,
      nuevas,
      omitidas,
      ejecutadas,
      propuestas,
      nuevoPlan,
      mawb: op.mawb,
      agoraConversationId: op.agora_conversation_id,
      espejables,
    };
  });

  if (!resultado) return null;
  if (resultado.kind === 'sin_novedad') return { ...vacio, omitidas: resultado.omitidas };

  // ONE audit row for the evaluation, not one per action: the significant act is "the engine decided
  // these things at this moment under this ruleset", and the actions are its content.
  await recordAudit({
    userId,
    action: 'REPLAN_EJECUTADO',
    entity: 'replan_evaluacion',
    entityId: resultado.evaluacionId,
    after: {
      operacionId: args.operacionId,
      mawb: resultado.mawb,
      disparador: args.disparador,
      rulesetVersion: REPLAN_RULESET_VERSION,
      rulesetHash: REPLAN_RULESET_HASH,
      estadoPlaneacion: resultado.nuevoPlan,
      acciones: resultado.nuevas.map((a) => ({ contingencia: a.contingencia, tipo: a.tipo, ejecucion: a.ejecucion })),
    },
    ip: null,
  });

  // Best-effort by contract; the mirror filters by significance and never throws. Wrapped anyway
  // because this runs inside the tick loop and decoration must never abort committed facts.
  if (resultado.agoraConversationId) {
    try {
      for (const e of resultado.espejables) {
        await mirrorEventoToAgora({
          operacionId: args.operacionId,
          agoraConversationId: resultado.agoraConversationId,
          tipo: e.tipo,
          payloadResumen: e.payload,
        });
      }
      await mirrorEstadoDeOperacion(args.operacionId);
    } catch (err) {
      console.warn('[replan] no se pudo espejar la replaneación en AGORA:', err);
    }
  }

  return {
    operacionId: args.operacionId,
    mawb: resultado.mawb,
    evaluacionId: resultado.evaluacionId,
    accionesNuevas: resultado.nuevas.length,
    ejecutadas: resultado.ejecutadas,
    propuestas: resultado.propuestas,
    omitidas: resultado.omitidas,
    estadoPlaneacion: resultado.nuevoPlan,
    contingencias: [...new Set(resultado.nuevas.map((a) => a.contingencia))].sort(),
  };
}

/**
 * Which casos are worth evaluating on a tick.
 *
 * A pre-filter, not a second engine: it asks only "is there any known reason a contingency could
 * fire?", and every branch mirrors a rule in the pure module. Evaluating every open caso every five
 * minutes would burn the database for nothing, since the overwhelming majority are flying normally.
 * The delay branch reads its threshold from the ruleset so the number exists once.
 */
export async function evaluarPendientes(limit = 100): Promise<ResultadoReplan[]> {
  const { rows } = await query<{ id: string }>(
    `SELECT o.id
       FROM operaciones o
       LEFT JOIN vuelos v ON v.id = o.vuelo_id
      WHERE o.etapa NOT IN ('en_transito','entregado','cerrada','cancelada')
        AND (
             o.hold_activo
          OR o.estado_documental = 'riesgo_vencido'
          OR v.estado IN ('cancelado','desviado')
          OR (COALESCE(v.eta_programado, o.eta_pais) IS NOT NULL
              AND COALESCE(v.arribo_real, v.eta_estimado) IS NOT NULL
              AND COALESCE(v.arribo_real, v.eta_estimado)
                  >= COALESCE(v.eta_programado, o.eta_pais) + make_interval(hours => $2))
          OR o.discrepancias @> '[{"codigo":"PA-09"}]'::jsonb
          OR EXISTS (SELECT 1 FROM operacion_guias g
                      WHERE g.operacion_id = o.id AND g.estado = 'no_transmitida')
          OR EXISTS (SELECT 1 FROM retenciones r
                      WHERE r.operacion_id = o.id AND r.estado = 'retenida')
        )
      ORDER BY o.created_at ASC
      LIMIT $1`,
    [limit, REPLAN_RULESET.demoraToleranciaHoras],
  );

  const out: ResultadoReplan[] = [];
  for (const r of rows) {
    try {
      const res = await evaluarOperacion({ operacionId: r.id, disparador: 'tick' });
      if (res) out.push(res);
    } catch (err) {
      // One bad caso must not cost the sweep the rest of them: the whole point is that the freeze on
      // caso B is discovered even if caso A has a malformed row.
      console.error(`[replan] falló la evaluación de la operación ${r.id}:`, err);
    }
  }
  return out;
}
