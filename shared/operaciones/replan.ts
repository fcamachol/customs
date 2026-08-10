// Motor de contingencias — replaneación automática (PRD-02 §8.8, CT-1…CT-7).
//
// THE PROBLEM THIS SOLVES, IN ONE SENTENCE: a flight slips fourteen hours and somebody has already
// contracted a truck for cargo that will not be on the ground today. That truck is a *flete en falso*
// and somebody pays for it. The paper process discovered this by phone call, hours late, one shipment
// at a time. This engine discovers it the moment the feed says so, and — the part that matters —
// **reassigns instead of cancelling** (decisión D10): the unit goes to another guía of the same day
// and only the tarifa changes.
//
// DETERMINISTIC, PURE, VERSION-STAMPED, exactly like shared/risk/ruleset.ts and
// shared/operaciones/cotejo.ts. Same snapshot in, same actions out, always, with a ruleset hash that
// lets a decision taken in August be reproduced in December in front of Anticorrupción (D20). No
// clock is read here (`estado.ahora` is an input), no database, no LLM. Nothing in this file decides
// an authoritative value on its own: it decides what SHOULD happen, and the caller records both the
// decision and its inputs.
//
// THE GOVERNANCE RULE (D6 / P3 / R20) IS THE REASON THE `ejecucion` FIELD EXISTS. The engine executes
// on its own the actions that cost nothing to undo — excluir del plan, reprogramar, abrir hold,
// suspender la solicitud de unidades, notificar. The one action that commits money — reasignar un
// despacho, which changes a tarifa — is only ever PROPOSED. A human confirms it, and that
// confirmation is written as `override = true` with an obligatory `motivo`. Alfonso asked for
// automation; nobody asked for a program with a company chequebook.
//
// SCOPE NOTE, HONESTLY STATED. CT-3/CT-4/CT-5/CT-6 already have their storage and endpoints
// (routes/holds.ts). What was missing is precisely what this file adds: the REACTION. holds.ts opens
// the freeze and says so; deciding that the caso therefore leaves the plan, that units must stop being
// requested, and that the contracted unit needs a new load, belongs here and was deliberately left
// out of there.

import { rulesetHash } from '../risk/hash';
import { GUIA_ESTADOS_NO_DESPACHABLES } from './catalogos';
import type { Etapa, EstadoDocumental, EstadoPlaneacion, TipoEvento } from './estados';

export const REPLAN_RULESET_VERSION = '2026-08a';

export const CONTINGENCIAS = ['CT-1', 'CT-2', 'CT-3', 'CT-4', 'CT-5', 'CT-6', 'CT-7'] as const;
export type ContingenciaId = (typeof CONTINGENCIAS)[number];

/** What each id means, in the words of PRD-02 §8.8. Kept next to the code so the table cannot drift. */
export const DESCRIPCION_CONTINGENCIA: Readonly<Record<ContingenciaId, string>> = {
  'CT-1': 'Vuelo demorado, cancelado o desviado: la carga no llega cuando se planeó.',
  'CT-2': 'Guía marcada como no transmitida: no puede despacharse y hay que buscar reemplazo.',
  'CT-3': 'Carga consignada a otra agencia aduanal: falta la cesión de derechos (CSA).',
  'CT-4': 'Requerimiento de riesgo vencido sin respuesta del cliente.',
  'CT-5': 'Retención de carga por la autoridad, total o parcial.',
  'CT-6': 'Hold global por auditoría de la autoridad: no se solicitan unidades.',
  'CT-7': 'Despacho contratado que se queda sin carga: se reasigna, no se cancela.',
};

export const TIPOS_ACCION = [
  'excluir_del_plan',
  'reprogramar',
  'abrir_hold',
  'suspender_solicitud_unidades',
  'notificar',
  'reasignar_despacho',
] as const;
export type TipoAccion = (typeof TIPOS_ACCION)[number];

/**
 * The five the engine performs by itself, and the one it does not.
 *
 * `reasignar_despacho` is absent on purpose and this array is the enforcement point: the service layer
 * asks `esAutomatica()` rather than re-deriving the rule, so there is exactly one place where the
 * money boundary is written down.
 */
export const ACCIONES_AUTOMATICAS: readonly TipoAccion[] = [
  'excluir_del_plan',
  'reprogramar',
  'abrir_hold',
  'suspender_solicitud_unidades',
  'notificar',
];

export type Ejecucion = 'automatica' | 'propuesta';

export const DESTINATARIOS = ['cliente', 'almacen', 'transportista', 'coordinacion', 'direccion'] as const;
export type Destinatario = (typeof DESTINATARIOS)[number];

/**
 * The only two hold types the engine may open by itself, and the two contingencies that own them:
 * `csa` for CT-3 and `riesgo` for CT-4. The full vocabulary lives in the migration and in the
 * validation schema; narrowing it here is deliberate, because "the system opened an
 * `auditoria_autoridad` hold" must remain impossible — the global freeze is a human decision with a
 * name attached to it (routes/holds.ts, admin only).
 */
export const HOLD_TIPOS_MOTOR = ['csa', 'riesgo'] as const;
export type HoldTipoMotor = (typeof HOLD_TIPOS_MOTOR)[number];

/**
 * Message templates the engine can ask for. Ids only — this engine never writes prose to a client and
 * never claims a notification was DELIVERED. It records the obligation; the fan-out over AGORA and
 * WhatsApp is backlog #31 and is blocked on outbound email (#22). Recording "hay que avisar" and
 * recording "se avisó" are different facts and the platform must not confuse them.
 */
export const PLANTILLAS = {
  vueloDemorado: 'vuelo_demorado',
  vueloCancelado: 'vuelo_cancelado',
  guiaNoTransmitida: 'guia_no_transmitida',
  solicitudCsa: 'solicitud_csa',
  requerimientoVencido: 'requerimiento_vencido',
  retencionParcial: 'retencion_parcial',
  retencionTotal: 'retencion_total',
  operacionCongelada: 'operacion_congelada',
} as const;
export type Plantilla = (typeof PLANTILLAS)[keyof typeof PLANTILLAS];

/**
 * The tunables, in one object so the hash covers them.
 *
 * `demoraToleranciaHoras = 4` is an ASSUMPTION, not a validated number: the meeting never fixed a
 * threshold. Four hours is the point at which a same-day dispatch stops being realistic given the
 * warehouse's own unloading window (R11 records up to seven hours between landing and availability).
 * Luis may well want it tighter — changing it changes the hash, which is exactly the audit trail a
 * threshold change should leave.
 */
export const REPLAN_RULESET = {
  version: REPLAN_RULESET_VERSION,
  /** Hours of slip against the planned arrival before the cargo is treated as out of today's plan. */
  demoraToleranciaHoras: 4,
  /** Flight states that trigger CT-1 on their own, regardless of any ETA arithmetic. */
  vueloEstadosCriticos: ['cancelado', 'desviado'] as const,
  /** Etapas where replanning is pointless: the cargo is already on the truck or the caso is finished. */
  etapasCerradas: ['en_transito', 'entregado', 'cerrada', 'cancelada'] as const,
  /** Planning states the engine may act on. `sin_plan` has nothing to exclude; `cumplida` is done. */
  planeacionAccionable: ['planeada', 'asignada', 'replanificada'] as const,
  /**
   * Guía states that cannot be loaded onto a truck today. NOT a literal any more: the same list is
   * what `routes/despachos.ts` refuses on and what `routes/planeacion.ts` publishes as exclusions, so
   * it lives once in `shared/operaciones/catalogos.ts`. Its declared order is fixed there precisely
   * because it is hashed into `REPLAN_RULESET_HASH`.
   */
  guiaNoDespachable: GUIA_ESTADOS_NO_DESPACHABLES,
  /** Despacho states that still have a unit committed and therefore can be reassigned. */
  despachoReasignable: [
    'planeado',
    'solicitado',
    'confirmado',
    'en_patio',
    'en_aduana',
    'en_espera',
  ] as const,
  /** How many replacement candidates travel with a proposal. A coordinator picks from a short list. */
  maxCandidatas: 5,
} as const;

/** sha256 of the canonicalized ruleset — the same primitive the risk engine uses (shared/risk/hash.ts). */
export const REPLAN_RULESET_HASH = rulesetHash(REPLAN_RULESET);

// =================================================================================================
// The snapshot. Everything the engine is allowed to know, assembled by the caller.
// =================================================================================================

export interface VueloObservadoReplan {
  numeroVuelo: string | null;
  /** shared/operaciones/vuelo.ts EstadoVuelo; widened to string so a new provider state cannot crash. */
  estado: string;
  etaProgramado: string | null;
  etaEstimado: string | null;
  arriboReal: string | null;
  destinoIata: string | null;
}

export interface GuiaEstado {
  id: string;
  guiaNorm: string;
  estado: string;
}

export interface HoldActivo {
  id: string;
  tipo: string;
  alcance: 'global' | 'operacion' | 'guia';
  operacionGuiaId: string | null;
  motivo: string;
}

export interface RetencionActiva {
  id: string;
  alcance: 'total' | 'parcial';
  estado: string;
  operacionGuiaId: string | null;
}

/**
 * A unit already committed against this caso.
 *
 * The `despachos` table now exists (#29) and `services/replanService.ts` fills this array with the
 * real, non-cancelled trips carrying this caso's cargo, so CT-7 names actual folios instead of
 * inferring one. `destinoIata` stays null in practice: a trip's destination is a client address, not
 * an airport, and the engine does not read the field — see the service for why it is not guessed.
 */
export interface DespachoContratado {
  id: string;
  estado: string;
  fechaOperacion: string | null;
  destinoIata: string | null;
}

export interface CandidataReasignacion {
  operacionId: string;
  mawb: string;
  destinoIata: string | null;
  /** Why this caso can absorb the unit, in Spanish, for the coordinator who has to choose. */
  razon: string;
}

export interface EstadoOperativo {
  /** ISO instant. An INPUT, never `new Date()`: the engine has to be replayable. */
  ahora: string;
  operacion: {
    id: string;
    mawb: string;
    etapa: Etapa;
    estadoPlaneacion: EstadoPlaneacion;
    estadoDocumental: EstadoDocumental;
    /** Declared ETA from the prealerta; the fallback baseline when the feed has no schedule. */
    etaPais: string | null;
    /** Live cotejo codes (PA-xx). PA-09 is what turns into CT-3. */
    discrepancias: string[];
  };
  vuelo: VueloObservadoReplan | null;
  /** ACTIVE holds only, global ones included. */
  holds: HoldActivo[];
  /** Retenciones still in custody (`estado = 'retenida'`). */
  retenciones: RetencionActiva[];
  guias: GuiaEstado[];
  /** Units committed against this caso — real `despachos` rows since #29. */
  despachos: DespachoContratado[];
  /** Casos that could absorb a freed unit today, pre-filtered by the caller. */
  candidatas: CandidataReasignacion[];
}

// =================================================================================================
// The actions.
// =================================================================================================

interface AccionBase {
  contingencia: ContingenciaId;
  /**
   * Self-contained Spanish. This string lands in the timeline and in the AGORA note, and six weeks
   * later it has to answer "why didn't guía X go out on Tuesday?" without the reader holding the
   * snapshot in their head.
   */
  motivo: string;
  ejecucion: Ejecucion;
  /**
   * Extra fingerprint material for actions whose identity depends on WHICH rows triggered them.
   *
   * A decision is recorded once per caso and never re-raised, so "avísale al cliente que una guía no
   * se transmitió" must not silently cover the SECOND guía that fails a week later. Carrying the
   * affected ids here makes that a different decision, while everything else — an exclusion, a
   * suspension — stays one decision about the whole caso.
   */
  discriminante?: string;
}

export type AccionPropuesta =
  | (AccionBase & { tipo: 'excluir_del_plan'; operacionId: string })
  | (AccionBase & { tipo: 'reprogramar'; operacionId: string; nuevaFecha: string })
  | (AccionBase & {
      tipo: 'abrir_hold';
      operacionId: string;
      alcance: 'global' | 'operacion';
      tipoHold: HoldTipoMotor;
    })
  | (AccionBase & { tipo: 'suspender_solicitud_unidades'; operacionId: string })
  | (AccionBase & {
      tipo: 'notificar';
      operacionId: string;
      destinatario: Destinatario;
      plantilla: Plantilla;
    })
  | (AccionBase & {
      tipo: 'reasignar_despacho';
      operacionId: string;
      /** Null on the `asignada` safety net: a unit is known to be committed but cannot be named. */
      despachoId: string | null;
      candidatas: CandidataReasignacion[];
    });

export function esAutomatica(accion: AccionPropuesta): boolean {
  return ACCIONES_AUTOMATICAS.includes(accion.tipo);
}

/**
 * The idempotency fingerprint, and the reason the timeline does not stutter.
 *
 * The tick re-evaluates every caso every few minutes while a flight stays cancelled. Without a stable
 * key, each cycle would append another "excluida del plan" event and a caso would accumulate hundreds
 * of identical rows in an append-only table that can never be cleaned. A decision is therefore
 * recorded ONCE per caso per fingerprint, whatever the human later did with it — re-proposing a
 * reassignment a coordinator already discarded would be nagging, and nagging is how a real alert gets
 * ignored.
 *
 * So the key carries exactly what makes an action a DIFFERENT decision, and nothing volatile: not the
 * candidate list, not the wording of the motivo, but yes the new reprogramming date, and yes the
 * `discriminante` for actions that are about specific rows.
 */
export function claveAccion(a: AccionPropuesta): string {
  const extra = a.discriminante ? `|${a.discriminante}` : '';
  switch (a.tipo) {
    case 'excluir_del_plan':
      return `${a.contingencia}|excluir_del_plan|${a.operacionId}${extra}`;
    case 'reprogramar':
      return `${a.contingencia}|reprogramar|${a.operacionId}|${a.nuevaFecha}${extra}`;
    case 'abrir_hold':
      return `${a.contingencia}|abrir_hold|${a.alcance}|${a.operacionId}|${a.tipoHold}${extra}`;
    case 'suspender_solicitud_unidades':
      return `${a.contingencia}|suspender_solicitud_unidades|${a.operacionId}${extra}`;
    case 'notificar':
      return `${a.contingencia}|notificar|${a.operacionId}|${a.destinatario}|${a.plantilla}${extra}`;
    case 'reasignar_despacho':
      return `${a.contingencia}|reasignar_despacho|${a.operacionId}|${a.despachoId ?? 'sin_despacho'}${extra}`;
  }
}

/**
 * Ledger vocabulary per action type (Spanish UPPER_SNAKE, like VUELO_DEMORADO and HOLD_ABIERTO).
 *
 * `abrir_hold` reuses HOLD_ABIERTO rather than inventing a parallel name: a hold opened by the engine
 * and a hold opened by a coordinator are the same fact about the cargo, and the timeline must not make
 * a reader learn two words for it. `origen` on the row is what says who opened it.
 */
export const EVENTO_POR_ACCION: Readonly<Record<TipoAccion, TipoEvento>> = {
  excluir_del_plan: 'OPERACION_EXCLUIDA_DEL_PLAN',
  reprogramar: 'OPERACION_REPROGRAMADA',
  abrir_hold: 'HOLD_ABIERTO',
  suspender_solicitud_unidades: 'SOLICITUD_UNIDADES_SUSPENDIDA',
  notificar: 'NOTIFICACION_REQUERIDA',
  reasignar_despacho: 'REASIGNACION_PROPUESTA',
};

// =================================================================================================
// Helpers.
// =================================================================================================

function ms(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

/** ISO calendar date (UTC) of an instant. Dates, not instants, are what a daily plan is keyed by. */
function fechaDe(iso: string): string | null {
  const t = ms(iso);
  return t === null ? null : new Date(t).toISOString().slice(0, 10);
}

function incluye<T extends string>(lista: readonly T[], v: string): boolean {
  return (lista as readonly string[]).includes(v);
}

/**
 * Hours of slip between the arrival we planned against and the arrival the feed now expects.
 *
 * Baseline preference — the feed's own scheduled ETA first, the client's declared `eta_pais` second —
 * matters: comparing an AeroAPI estimate against a client's rounded declaration would manufacture
 * "delays" out of the cotejo discrepancy PA-05 already reports, and CT-1 would fire on paperwork
 * instead of on the world. Returns null when either side is unknown, which the caller reads as "no
 * evidence of a delay" rather than as "no delay".
 */
export function demoraHoras(vuelo: VueloObservadoReplan, etaDeclarada: string | null): number | null {
  const base = ms(vuelo.etaProgramado) ?? ms(etaDeclarada);
  const nuevo = ms(vuelo.arriboReal) ?? ms(vuelo.etaEstimado);
  if (base === null || nuevo === null) return null;
  return (nuevo - base) / 3_600_000;
}

/**
 * Which contingency an active hold belongs to.
 *
 * The three named mappings are from the PRD table. The fallback to CT-4 for `documental`,
 * `cliente_sin_respuesta` and `otro` is a judgement call: those are all "blocked pending something the
 * client owes us", which is CT-4's shape, and inventing a CT-8 would put an id in the ledger that no
 * requirement document defines.
 */
export function contingenciaPorHold(tipo: string): ContingenciaId {
  switch (tipo) {
    case 'auditoria_autoridad':
      return 'CT-6';
    case 'csa':
      return 'CT-3';
    case 'no_transmitida':
      return 'CT-2';
    default:
      return 'CT-4';
  }
}

const ORDEN_TIPO: Readonly<Record<TipoAccion, number>> = {
  suspender_solicitud_unidades: 0,
  abrir_hold: 1,
  reprogramar: 2,
  excluir_del_plan: 3,
  notificar: 4,
  reasignar_despacho: 5,
};

/**
 * Stable ordering: contingency id, then action kind, then the fingerprint.
 *
 * Not cosmetic. The output is hashed into an evaluation record and compared against the previous run,
 * so two runs over identical facts must produce byte-identical arrays or every tick would look like a
 * change.
 */
function ordenar(acciones: AccionPropuesta[]): AccionPropuesta[] {
  return [...acciones].sort((a, b) => {
    if (a.contingencia !== b.contingencia) return a.contingencia < b.contingencia ? -1 : 1;
    if (a.tipo !== b.tipo) return ORDEN_TIPO[a.tipo] - ORDEN_TIPO[b.tipo];
    const ka = claveAccion(a);
    const kb = claveAccion(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

// =================================================================================================
// The engine.
// =================================================================================================

/**
 * Evaluate the whole CT-1…CT-7 catalogue against one caso.
 *
 * Returns an ordered, de-duplicated list of what should happen. It performs nothing and persists
 * nothing; the caller executes the `automatica` ones and files the `propuesta` ones for a human.
 */
export function evaluarContingencias(estado: EstadoOperativo): AccionPropuesta[] {
  const op = estado.operacion;
  // Cargo already on a truck or a caso already closed has nothing left to replan, and acting on it
  // would rewrite a plan that has already been executed.
  if (incluye(REPLAN_RULESET.etapasCerradas, op.etapa)) return [];

  const acciones: AccionPropuesta[] = [];
  const enPlan = incluye(REPLAN_RULESET.planeacionAccionable, op.estadoPlaneacion);

  const holdGlobal = estado.holds.find((h) => h.alcance === 'global') ?? null;
  const holdsPropios = estado.holds.filter((h) => h.alcance !== 'global');
  const retenciones = estado.retenciones.filter((r) => r.estado === 'retenida');
  const retencionTotal = retenciones.some((r) => r.alcance === 'total');
  const retencionesParciales = retenciones.filter((r) => r.alcance === 'parcial');
  const guiasNoTransmitidas = estado.guias.filter((g) => g.estado === 'no_transmitida');
  // No guías at all means the manifiesto has not been ingested yet — an absence of evidence, not
  // evidence that there is nothing to load. Excluding on that basis would pull healthy casos from the
  // plan for the entirely normal window between the prealerta and the manifest.
  const hayCargaDespachable =
    estado.guias.length === 0 ||
    estado.guias.some((g) => !incluye(REPLAN_RULESET.guiaNoDespachable, g.estado));

  // ---- CT-6 · global freeze. First, because it is the most consequential and because its whole
  // purpose is to stop units from being requested BEFORE anything else is decided.
  if (holdGlobal) {
    acciones.push({
      tipo: 'suspender_solicitud_unidades',
      contingencia: 'CT-6',
      operacionId: op.id,
      ejecucion: 'automatica',
      motivo:
        `Hold global activo (${holdGlobal.tipo}): se suspende la solicitud de unidades para evitar ` +
        `flete en falso. Motivo del hold: ${holdGlobal.motivo}`,
    });
    if (enPlan) {
      acciones.push({
        tipo: 'excluir_del_plan',
        contingencia: 'CT-6',
        operacionId: op.id,
        ejecucion: 'automatica',
        motivo: `Hold global activo (${holdGlobal.tipo}): la operación sale del plan mientras dure el bloqueo.`,
      });
    }
    acciones.push({
      tipo: 'notificar',
      contingencia: 'CT-6',
      operacionId: op.id,
      destinatario: 'transportista',
      plantilla: PLANTILLAS.operacionCongelada,
      ejecucion: 'automatica',
      motivo: 'Hold global activo: hay que avisar al transportista que no se solicitan unidades.',
    });
  }

  // ---- CT-1 · the flight.
  const vuelo = estado.vuelo;
  let ct1 = false;
  if (vuelo) {
    const critico = incluye(REPLAN_RULESET.vueloEstadosCriticos, vuelo.estado);
    const demora = demoraHoras(vuelo, op.etaPais);
    const demorado = demora !== null && demora >= REPLAN_RULESET.demoraToleranciaHoras;
    ct1 = critico || demorado;

    if (ct1) {
      const etiqueta = critico
        ? `El vuelo ${vuelo.numeroVuelo ?? ''} está ${vuelo.estado}`.trim()
        : `El vuelo ${vuelo.numeroVuelo ?? ''} se demoró ${(demora as number).toFixed(1)} h`.trim();

      // A new date exists only when a new arrival is expected. A cancelled flight has none, and
      // inventing one would put a promise in the ledger that nothing supports.
      const nuevoInstante = vuelo.arriboReal ?? vuelo.etaEstimado;
      const nuevaFecha = !critico && nuevoInstante ? fechaDe(nuevoInstante) : null;
      const fechaBase = vuelo.etaProgramado ?? op.etaPais;
      const fechaPrevia = fechaBase ? fechaDe(fechaBase) : null;
      if (nuevaFecha && nuevaFecha !== fechaPrevia) {
        acciones.push({
          tipo: 'reprogramar',
          contingencia: 'CT-1',
          operacionId: op.id,
          nuevaFecha,
          ejecucion: 'automatica',
          motivo: `${etiqueta}: la operación se reprograma al ${nuevaFecha}.`,
        });
      }
      if (enPlan) {
        acciones.push({
          tipo: 'excluir_del_plan',
          contingencia: 'CT-1',
          operacionId: op.id,
          ejecucion: 'automatica',
          motivo: `${etiqueta}: la carga no llega a tiempo y sale del plan del día.`,
        });
      }
      const plantilla = critico ? PLANTILLAS.vueloCancelado : PLANTILLAS.vueloDemorado;
      for (const destinatario of ['almacen', 'cliente'] as const) {
        acciones.push({
          tipo: 'notificar',
          contingencia: 'CT-1',
          operacionId: op.id,
          destinatario,
          plantilla,
          ejecucion: 'automatica',
          motivo: `${etiqueta}: hay que avisar a ${destinatario}.`,
        });
      }
      if (estado.despachos.length) {
        acciones.push({
          tipo: 'notificar',
          contingencia: 'CT-1',
          operacionId: op.id,
          destinatario: 'transportista',
          plantilla,
          ejecucion: 'automatica',
          motivo: `${etiqueta}: hay unidad comprometida y hay que avisar al transportista.`,
        });
      }
    }
  }

  // ---- CT-2 · guías not transmitted.
  if (guiasNoTransmitidas.length) {
    const lista = guiasNoTransmitidas.map((g) => g.guiaNorm).join(', ');
    acciones.push({
      tipo: 'notificar',
      contingencia: 'CT-2',
      operacionId: op.id,
      destinatario: 'cliente',
      plantilla: PLANTILLAS.guiaNoTransmitida,
      ejecucion: 'automatica',
      // The guías themselves are part of the identity: a second guía failing next week is a second
      // thing the client has to be told, not a repeat of the first.
      discriminante: [...guiasNoTransmitidas.map((g) => g.id)].sort().join(','),
      motivo: `Guía(s) no transmitida(s): ${lista}. No pueden despacharse hasta su transmisión.`,
    });
    if (!hayCargaDespachable && enPlan) {
      acciones.push({
        tipo: 'excluir_del_plan',
        contingencia: 'CT-2',
        operacionId: op.id,
        ejecucion: 'automatica',
        motivo: `Ninguna guía de la operación puede despacharse hoy (no transmitidas: ${lista}).`,
      });
    }
  }

  // ---- CT-3 · consigned to another agencia (PA-09). The rule is written even though PA-09 cannot
  // fire yet — no artefact we receive declares the consignee patente (see cotejo.ts). The day the
  // manifiesto or the AWB carries it, the block opens by itself instead of waiting for this file.
  if (op.discrepancias.includes('PA-09') && !holdsPropios.some((h) => h.tipo === 'csa')) {
    acciones.push({
      tipo: 'abrir_hold',
      contingencia: 'CT-3',
      operacionId: op.id,
      alcance: 'operacion',
      tipoHold: 'csa',
      ejecucion: 'automatica',
      motivo: 'Cotejo PA-09: la carga aparece consignada a otra agencia aduanal y falta la cesión (CSA).',
    });
    acciones.push({
      tipo: 'notificar',
      contingencia: 'CT-3',
      operacionId: op.id,
      destinatario: 'cliente',
      plantilla: PLANTILLAS.solicitudCsa,
      ejecucion: 'automatica',
      motivo: 'Hay que pedir al cliente la carta de cesión de derechos (CSA).',
    });
  }

  // ---- CT-4 · the risk requirement expired. `riesgo_vencido` is set by the deadline sweep (#23);
  // the engine owns the consequence, which is why this fires on the STATE and not on a timer.
  if (op.estadoDocumental === 'riesgo_vencido' && !holdsPropios.some((h) => h.tipo === 'riesgo')) {
    acciones.push({
      tipo: 'abrir_hold',
      contingencia: 'CT-4',
      operacionId: op.id,
      alcance: 'operacion',
      tipoHold: 'riesgo',
      ejecucion: 'automatica',
      motivo: 'El requerimiento de riesgo venció sin respuesta del cliente: se bloquea la operación.',
    });
    for (const destinatario of ['cliente', 'direccion'] as const) {
      acciones.push({
        tipo: 'notificar',
        contingencia: 'CT-4',
        operacionId: op.id,
        destinatario,
        plantilla: PLANTILLAS.requerimientoVencido,
        ejecucion: 'automatica',
        motivo: `Requerimiento de riesgo vencido: hay que avisar a ${destinatario}.`,
      });
    }
  }

  // ---- CT-3/CT-4 consequence · any active own hold takes the caso out of the plan. This is the half
  // routes/holds.ts deliberately does not do: it records the freeze, this decides what the freeze
  // costs. One exclusion per distinct contingency, so two holds of the same family do not double up.
  if (enPlan) {
    const vistas = new Set<ContingenciaId>();
    for (const h of holdsPropios) {
      const c = contingenciaPorHold(h.tipo);
      if (vistas.has(c)) continue;
      vistas.add(c);
      acciones.push({
        tipo: 'excluir_del_plan',
        contingencia: c,
        operacionId: op.id,
        ejecucion: 'automatica',
        motivo: `Hold activo (${h.tipo}): la operación no se programa. Motivo: ${h.motivo}`,
      });
    }
  }

  // ---- CT-5 · retenciones.
  if (retencionesParciales.length) {
    acciones.push({
      tipo: 'notificar',
      contingencia: 'CT-5',
      operacionId: op.id,
      destinatario: 'cliente',
      plantilla: PLANTILLAS.retencionParcial,
      ejecucion: 'automatica',
      // Same reasoning as CT-2: a second pallet pulled tomorrow is a second thing to tell the client.
      discriminante: [...retencionesParciales.map((r) => r.id)].sort().join(','),
      motivo:
        `Retención parcial (${retencionesParciales.length}): hay que informar qué carga sale hoy y ` +
        'qué queda en custodia.',
    });
  }
  if (retencionTotal) {
    acciones.push({
      tipo: 'notificar',
      contingencia: 'CT-5',
      operacionId: op.id,
      destinatario: 'cliente',
      plantilla: PLANTILLAS.retencionTotal,
      ejecucion: 'automatica',
      motivo: 'Retención total: la autoridad retuvo toda la carga de la operación.',
    });
    if (enPlan) {
      acciones.push({
        tipo: 'excluir_del_plan',
        contingencia: 'CT-5',
        operacionId: op.id,
        ejecucion: 'automatica',
        motivo: 'Retención total: no hay carga que despachar; la operación sale del plan.',
      });
    }
  }

  // ---- CT-7 · the unit that lost its cargo. THE ANTI-FLETE-EN-FALSO RULE (D10).
  //
  // Never `cancelar`. A cancelled truck is a truck somebody still bills for; a reassigned truck is a
  // tarifa adjustment. So the action is always a reassignment proposal, and it is a PROPOSAL because
  // it changes a price (D6/R20) — the engine is not allowed to commit money.
  //
  // An EMPTY candidate list is still emitted, deliberately. "No encontré a dónde mandarla" is
  // information the coordinator needs within minutes; swallowing the proposal because the engine could
  // not solve it would hide the exposure entirely.
  const sinCarga =
    ct1 || !hayCargaDespachable || Boolean(holdGlobal) || holdsPropios.length > 0 || retencionTotal;
  if (sinCarga) {
    const candidatas = estado.candidatas.slice(0, REPLAN_RULESET.maxCandidatas);
    const reasignables = estado.despachos.filter((d) =>
      incluye(REPLAN_RULESET.despachoReasignable, d.estado),
    );
    if (reasignables.length) {
      for (const d of reasignables) {
        acciones.push({
          tipo: 'reasignar_despacho',
          contingencia: 'CT-7',
          operacionId: op.id,
          despachoId: d.id,
          candidatas,
          ejecucion: 'propuesta',
          motivo:
            `El despacho ${d.id} se queda sin carga. Se propone reasignarlo (no cancelarlo): sin ` +
            `reasignación es flete en falso, con ella sólo cambia la tarifa. ` +
            (candidatas.length
              ? `${candidatas.length} candidata(s) elegible(s).`
              : 'No se encontró candidata automática; requiere decisión del coordinador.'),
        });
      }
    } else if (op.estadoPlaneacion === 'asignada') {
      // THE SAFETY NET, KEPT ON PURPOSE. #29 has landed and the caller now passes real `despachos`
      // rows, so the branch above is the normal path. This one survives because the two facts can
      // still disagree: `asignada` MEANS a unit and a carrier were committed (§8.4 eje 3), and a caso
      // carrying that state with no live trip row — a despacho cancelled outside this engine, a
      // planning axis moved by an import or by hand, a partida deleted — is still an exposure. The
      // honest reading is "we know a unit is committed, we cannot name it": the proposal is raised
      // with a null despachoId and the coordinator identifies the unit. Silently dropping it because
      // the join came back empty would hide exactly the flete en falso the rule exists to catch.
      acciones.push({
        tipo: 'reasignar_despacho',
        contingencia: 'CT-7',
        operacionId: op.id,
        despachoId: null,
        candidatas,
        ejecucion: 'propuesta',
        motivo:
          'La operación tiene unidad asignada y se queda sin carga. Se propone reasignar la unidad ' +
          '(no cancelar) para evitar flete en falso. ' +
          (candidatas.length
            ? `${candidatas.length} candidata(s) elegible(s).`
            : 'No se encontró candidata automática; requiere decisión del coordinador.'),
      });
    }
  }

  // De-duplicate by fingerprint, keeping the first (highest-priority) wording, then order stably.
  const porClave = new Map<string, AccionPropuesta>();
  for (const a of acciones) {
    const k = claveAccion(a);
    if (!porClave.has(k)) porClave.set(k, a);
  }
  return ordenar([...porClave.values()]);
}

/**
 * The planning state an evaluation lands on, given the current one.
 *
 * Kept here rather than in the service because it is a rule of the state machine (§8.4 eje 3), not a
 * database detail. The distinction it encodes: a caso that had a unit assigned goes to
 * `replanificada` (its plan must be redone, and the state diagram has no `asignada → excluida` edge),
 * while a merely programmed caso goes to `excluida`. Returns null when nothing should be written —
 * `sin_plan` has nothing to exclude and `cumplida` is already loaded.
 */
export function planeacionTrasContingencia(
  actual: EstadoPlaneacion,
  acciones: AccionPropuesta[],
): EstadoPlaneacion | null {
  const afecta = acciones.some((a) => a.tipo === 'excluir_del_plan' || a.tipo === 'reprogramar');
  if (!afecta) return null;
  if (actual === 'asignada' || actual === 'replanificada') {
    return actual === 'replanificada' ? null : 'replanificada';
  }
  if (actual === 'planeada') return 'excluida';
  return null;
}
