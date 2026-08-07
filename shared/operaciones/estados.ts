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
  'VUELO_ACTUALIZADO',
  'VUELO_DEMORADO',
  'VUELO_CANCELADO',
  'ARRIBO_VUELO',
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
