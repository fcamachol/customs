// Vocabulary for the Sistema de Operaciones state machines.
//
// These arrays are the single source of truth for the app layer. The DB CHECK constraints in
// server/migrations/1700003800000_operaciones.ts and 1700003900000_operacion_eventos.ts spell the
// same values out inline (migrations stay dependency-free by house convention), so any change here
// needs a matching migration. The `estadosMatchMigration` test guards that pairing.
//
// Three axes, deliberately independent (PRD-02 §8.4). Collapsing them into one status is what makes
// the Excel this replaces unable to express "flight landed but risk unresolved, so excluded from the
// plan" — which is the single most common real state.

/** Physical progress. Monotonic: only ever advanced by an observed fact. */
export const ETAPAS = [
  'prealerta',
  'en_vuelo',
  'arribado',
  'disponible',
  'en_carga',
  'modulado',
  'reconocimiento',
  'en_transito',
  'entregado',
  'cerrada',
  'cancelada',
] as const;
export type Etapa = (typeof ETAPAS)[number];

/** Documentary progress. Mirrors the existing risk + pedimento modules. */
export const ESTADOS_DOCUMENTALES = [
  'sin_cotejar',
  'cotejado',
  'riesgo_con_hallazgos',
  'riesgo_ok',
  'riesgo_vencido',
  'pedimento_generado',
  'liberada',
] as const;
export type EstadoDocumental = (typeof ESTADOS_DOCUMENTALES)[number];

/** Planning / dispatch lifecycle. */
export const ESTADOS_PLANEACION = [
  'sin_plan',
  'planeada',
  'asignada',
  'replanificada',
  'excluida',
  'cumplida',
] as const;
export type EstadoPlaneacion = (typeof ESTADOS_PLANEACION)[number];

/**
 * Semáforo fiscal. English on purpose — the client reads this value and clients are mostly Chinese
 * (PRD-02 decision D16). Do not localize it to verde/rojo.
 */
export const SEMAFOROS = ['green', 'red'] as const;
export type Semaforo = (typeof SEMAFOROS)[number];

/** Who produced an event. Distinguishes automated advancement from human action. */
export const ORIGENES_EVENTO = [
  'sistema',
  'tramitador',
  'coordinador',
  'cliente',
  'transportista',
  'feed_vuelo',
  'feed_gps',
] as const;
export type OrigenEvento = (typeof ORIGENES_EVENTO)[number];

/**
 * Event types written to `operacion_eventos`. SCREAMING_SNAKE_CASE to match the existing
 * `recordAudit({ action })` convention, since every event is mirrored into the audit hash chain.
 * Only the ingest-path events exist so far; later phases append.
 */
export const TIPOS_EVENTO = [
  'PREALERTA_RECIBIDA',
  'PREALERTA_VERSIONADA',
  'PREALERTA_RECHAZADA',
  'PREALERTA_ADJUNTO_BLOQUEADO',
  'PREALERTA_RECUPERADA_POR_BARRIDO',
  'EVIDENCIA_ARCHIVADA',
  'COTEJO_EJECUTADO',
  'OPERACION_CREADA',
  'RIESGO_EVALUADO',
  'VUELO_ACTUALIZADO',
  'VUELO_DEMORADO',
  'VUELO_CANCELADO',
  'ARRIBO_VUELO',
  // Field capture by the tramitador (PRD-02 R11, R30–R35). These seven are the seven buttons of
  // CampoView, in the order a real operation walks them. They exist as events and not merely as
  // etapa changes because most of them do not move `etapa` at all: INGRESO_PATIO, INGRESO_ADUANA and
  // FIN_CARGA are pure ledger facts whose value is the TIMESTAMP (cité 10:00, entró 10:05 — R30),
  // and an etapa column can hold only the latest state, never the delta.
  'CARGA_DISPONIBLE',
  'INGRESO_PATIO',
  'INGRESO_ADUANA',
  'INICIO_CARGA',
  'FIN_CARGA',
  'MODULACION',
  'SALIDA_ROJO',
  /** A photo/PDF filed from the field. Distinct from EVIDENCIA_ARCHIVADA, which is prealerta mail. */
  'EVIDENCIA_CAPTURADA',
  // Freeze layer — holds inhibit planning, never the physical etapa; see routes/holds.ts.
  'HOLD_ABIERTO',
  'HOLD_CERRADO',
  'HOLD_GLOBAL_ABIERTO',
  'HOLD_GLOBAL_CERRADO',
  'RETENCION_CREADA',
  'RETENCION_LIBERADA',
  /**
   * Contingency engine — the replanning layer (shared/operaciones/replan.ts, CT-1…CT-7).
   *
   * These are the CONSEQUENCES of the facts above, and they are separate event types precisely
   * because a reader must be able to tell "the flight was cancelled" from "and therefore the caso
   * left today's plan". The first is the world; the second is a decision this platform took, and
   * only the second can be argued with.
   *
   * NOTIFICACION_REQUERIDA says an advice is OWED, never that one was sent — the fan-out is #31 and
   * is blocked on outbound email (#22). Recording "hay que avisar" as if it were "se avisó" is the
   * exact failure the hard-deadline rule R18 cannot survive.
   *
   * REASIGNACION_PROPUESTA is the money boundary (D6/R20): the engine proposes, a human confirms with
   * `override = true` and an obligatory motivo, and REASIGNACION_CONFIRMADA/DESCARTADA records who.
   * Opening a hold reuses HOLD_ABIERTO — an engine-opened block and a coordinator-opened block are
   * the same fact about the cargo, distinguished by `origen`.
   */
  'GUIA_NO_TRANSMITIDA',
  'OPERACION_EXCLUIDA_DEL_PLAN',
  'OPERACION_REPROGRAMADA',
  'SOLICITUD_UNIDADES_SUSPENDIDA',
  'NOTIFICACION_REQUERIDA',
  'REASIGNACION_PROPUESTA',
  'REASIGNACION_CONFIRMADA',
  'REASIGNACION_DESCARTADA',
  /**
   * Despacho — one truck, one trip (R21–R29). These land on the timeline of EVERY caso riding on
   * the unit, not on a trip-level log, for the same reason the global hold does: six weeks later the
   * question arrives one shipment at a time ("why did guía X leave on Thursday and not Tuesday?"),
   * and each timeline has to answer it without the reader knowing which trip to look up first.
   *
   * DESPACHO_ASIGNADO is separate from DESPACHO_CREADO because of decision D7. Creating the trip
   * fixes the UNIT TYPE; assigning it names the carrier, the plates and the agreed rate. Those are
   * two decisions taken at different moments by different people, and collapsing them into one event
   * would erase the ordering the decision exists to enforce.
   */
  'DESPACHO_CREADO',
  'DESPACHO_ASIGNADO',
  'DESPACHO_ACTUALIZADO',
  'DESPACHO_ESTADO',
  'DESPACHO_PARTIDA_AGREGADA',
  'DESPACHO_PARTIDA_RETIRADA',
  /** CT-7 / D10: the contracted unit moved to other cargo instead of being cancelled. */
  'DESPACHO_REASIGNADO',
  'DESPACHO_CANCELADO',
  /** R36 / D14: the calculated arrival. Distinct from ARRIBO_DESTINO, which is the observed one. */
  'ETA_CALCULADA',
  'ARRIBO_DESTINO',
  /** R19 / P4: a new version of the day's plan went out, with its diff. */
  'PLAN_PUBLICADO',
  /**
   * A post-commit step of the ingest failed — manifest parse, risk scoring, flight lookup, the
   * operation-level cotejo, or the AGORA mirror.
   *
   * Every one of those steps is deliberately best-effort: the caso and its archived evidence must
   * survive a malformed spreadsheet or a provider outage (PRD-02 principle P1). But "best-effort" was
   * implemented as console.warn, which means the operational complaint that produced this event type —
   * "no hay un log de errores claro" — was literally true: a caso could sit there missing its manifest
   * with nothing anywhere to say why. This makes the failure a first-class, append-only timeline row
   * mirrored into the audit chain, so the gap is visible to the same people who see the caso.
   */
  'INGESTA_INCIDENCIA',
] as const;
export type TipoEvento = (typeof TIPOS_EVENTO)[number];

const ETAPA_ORDER = new Map<Etapa, number>(ETAPAS.map((e, i) => [e, i]));

/**
 * Guard for the monotonicity rule: `etapa` may advance but never regress. `cancelada` is reachable
 * from anywhere (a client can cancel at any point) and is terminal, so it is exempt from ordering.
 *
 * Returns false for equal etapas — re-recording the same etapa is a no-op the caller should skip
 * rather than a transition, which keeps duplicate webhook deliveries from emitting duplicate events.
 */
export function canAdvanceEtapa(from: Etapa, to: Etapa): boolean {
  if (from === to) return false;
  if (from === 'cerrada' || from === 'cancelada') return false;
  if (to === 'cancelada') return true;
  return (ETAPA_ORDER.get(to) ?? -1) > (ETAPA_ORDER.get(from) ?? -1);
}
