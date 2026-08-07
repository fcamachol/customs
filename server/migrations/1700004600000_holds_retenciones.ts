import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * `operacion_holds` and `retenciones` — the blocking layer of the operations state machine
 * (PRD-02 §8.4 "ortogonal a los tres ejes", §8.5, contingencies CT-3/CT-4/CT-5/CT-6).
 *
 * WHY A FOURTH AXIS INSTEAD OF MORE STATES. The three axes of §8.4 (etapa física, estado documental,
 * estado de planeación) all describe what HAS happened to the cargo. A hold describes something that
 * has not: a reason the system must NOT act. Folding it into `etapa` would be a lie about the physical
 * world — an authority audit of the warehouse does not un-land the aircraft — and folding it into
 * `estado_planeacion` would destroy the information needed to resume, because `excluida` remembers
 * that the operación was pulled from the plan but not why, who pulled it, or when it can go back.
 * So a hold is its OWN row with its own open/close lifecycle, and the state machines stay honest:
 * a hold never changes the etapa, it inhibits PLANNING transitions (§8.4).
 *
 * WHY IT MUST BE A LEDGER AND NOT A FLAG. `operaciones.hold_activo` already exists as a materialized
 * boolean because the control-tower board filters on it on every poll. That boolean cannot answer the
 * only questions that matter after the fact: why did this shipment not go out on Tuesday, who decided
 * that, and when was it released. These two tables are the answer, and that is why `motivo` is
 * notNull on both: a block without a stated reason is indistinguishable from someone quietly sitting
 * on a shipment, which is precisely the behaviour this platform exists to make impossible.
 *
 * THE GLOBAL HOLD (CT-6) is `operacion_id IS NULL`, and it is the most consequential row in the
 * schema. From the source meeting, verbatim: "un botón que dice auditoría de autoridad, track, y todo
 * está parado". When the authority audits the warehouse, nothing moves — and critically the system
 * must STOP REQUESTING TRUCKS, because a truck contracted against cargo that cannot be loaded is a
 * *flete en falso* that somebody pays for. Modelling it as a nullable FK on the same table (rather
 * than a separate `system_holds` table or a config flag) means the single query "is anything frozen
 * for this operación?" is `EXISTS(SELECT 1 FROM operacion_holds WHERE activo AND (operacion_id IS NULL
 * OR operacion_id = $1))` — one index, one read, no second concept to forget about.
 *
 * OPERACIÓN-LEVEL HOLDS are CT-3 and CT-4. `csa`: the cargo turns out to be consigned to another
 * agencia aduanal (cotejo rule PA-09), so nothing can be dispatched until the cesión letter arrives.
 * `riesgo`: the risk engine raised findings, the client was given a hard deadline, and the deadline
 * passed with no answer (the meeting's example: the shipper is away for Chinese New Year). Both are
 * blocks whose resolution is *external*, which is exactly why they need a visible open/close record
 * rather than an inferred state.
 *
 * `alcance = 'guia'` exists because a guía máster routinely carries cargo for several clients (R29).
 * One house guía missing its transmission must not freeze the other four; the hold names the guía it
 * belongs to and the planner excludes only that line.
 *
 * `retenciones` is CT-5, the case the pedimento module cannot be allowed to get wrong. The authority
 * pulls ONE pallet for inspection and the rest of the shipment ships the same day. Two hard
 * consequences follow. First, the pedimento must declare the cargo that ACTUALLY LEFT, contrasted
 * against the manifiesto — declaring the full manifest for a truck that carried less is a false
 * declaration. Second, the detained pallet does not disappear: it stays in custody with its own
 * lifecycle (`retenida → liberada`, or the endings nobody wants — `destruida`, `abandonada`) and, on
 * release, is reincorporated into a later plan (§9.7). `unidad` + `cantidad` are how much was pulled
 * in the terms the tramitador actually used on the dock ("un pallet"), not a recomputed piece count,
 * because the figure that has to match the authority's oficio is the one on the oficio.
 *
 * `evidencia_file_id` and `oficio_referencia` are SET NULL / plain text on purpose: the retención
 * record must survive the loss of its paperwork, since the fact that cargo was held is the part that
 * must never become unprovable.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('operacion_holds', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    /**
     * NULLABLE ON PURPOSE: a NULL `operacion_id` is the GLOBAL hold of CT-6 — the authority-audit
     * button that freezes every open caso at once and stops the system from requesting units. Any
     * non-null value scopes the hold to that single caso (CT-3/CT-4). CASCADE because a hold has no
     * meaning without its caso; the durable record of the freeze lives in `operacion_eventos`, which
     * is append-only and deliberately does NOT cascade (§8.5, decisión #2).
     */
    operacion_id: { type: 'uuid', references: 'operaciones', onDelete: 'CASCADE' },
    tipo: {
      type: 'text',
      notNull: true,
      check:
        "tipo IN ('riesgo','csa','no_transmitida','auditoria_autoridad'," +
        "'documental','cliente_sin_respuesta','otro')",
    },
    alcance: { type: 'text', notNull: true, check: "alcance IN ('global','operacion','guia')" },
    /**
     * Which house guía is blocked when `alcance = 'guia'`. SET NULL, not CASCADE: if the guía row is
     * later removed (a re-ingest that drops a line, a cancellation), the hold and its motivo must
     * remain readable — losing the reason a shipment was frozen is worse than a dangling reference.
     */
    operacion_guia_id: { type: 'uuid', references: 'operacion_guias', onDelete: 'SET NULL' },
    // Holds are closed, never deleted. `activo = false` + `cerrado_at` is the release record.
    activo: { type: 'boolean', notNull: true, default: true },
    abierto_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    cerrado_at: { type: 'timestamptz' },
    abierto_por: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    cerrado_por: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    // notNull with no default: a hold without a stated reason is not auditable, and "the system
    // blocked it" is not an answer anyone can give to the authority.
    motivo: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  /**
   * The two facts must agree, in both directions, or the global hold becomes unqueryable.
   *
   * `alcance = 'global'` REQUIRES `operacion_id IS NULL`: a "global" hold pinned to one caso would
   * freeze the board for everyone while pretending to belong to a single shipment. And the converse —
   * `operacion_id IS NULL` REQUIRES `alcance = 'global'` — matters just as much: an orphan hold with
   * `alcance = 'operacion'` and no operación would be invisible to the per-caso query AND to the
   * global one, i.e. a freeze nobody can find or close. Written as an equality between two booleans
   * so a single constraint covers both implications.
   */
  pgm.addConstraint('operacion_holds', 'operacion_holds_alcance_global_check', {
    check: "(alcance = 'global') = (operacion_id IS NULL)",
  });

  /**
   * PARTIAL index. "¿Hay algo congelado?" runs on every board poll and on every planning decision,
   * and the answer is almost always no — closed holds accumulate forever while the active set stays
   * tiny. `WHERE activo` keeps the index proportional to what is open rather than to history.
   */
  pgm.createIndex('operacion_holds', 'activo', {
    name: 'operacion_holds_activo_idx',
    where: 'activo',
  });
  // The per-caso lookup behind `hold_activo` and behind the operación detail screen.
  pgm.createIndex('operacion_holds', 'operacion_id');
  pgm.createIndex('operacion_holds', 'operacion_guia_id');

  pgm.createTable('retenciones', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    // notNull, unlike a hold: cargo is always retained FROM a specific caso. There is no such thing
    // as a global retención — that is what the global hold is for.
    operacion_id: { type: 'uuid', notNull: true, references: 'operaciones', onDelete: 'CASCADE' },
    // Which house guía the detained cargo belongs to. Null for a total retención of the whole caso.
    operacion_guia_id: { type: 'uuid', references: 'operacion_guias', onDelete: 'SET NULL' },
    alcance: { type: 'text', notNull: true, check: "alcance IN ('total','parcial')" },
    /**
     * The unit the authority actually used in its oficio, and the unit the tramitador saw on the
     * dock: "detuvieron un pallet". Not converted to pieces — the number that has to reconcile
     * against the authority's paperwork is the number on the paperwork.
     */
    unidad: { type: 'text', check: "unidad IN ('pallet','carton','pieza')" },
    cantidad: { type: 'integer' },
    motivo: { type: 'text', notNull: true },
    /**
     * The pallet's own lifecycle (§9.7). `liberada` reincorporates it into a later plan; `destruida`
     * and `abandonada` are the two endings where the cargo never comes back and the client has to be
     * told. Kept as an explicit state instead of a nullable `liberada_at` precisely so those two
     * outcomes are representable at all.
     */
    estado: {
      type: 'text',
      notNull: true,
      default: 'retenida',
      check: "estado IN ('retenida','liberada','destruida','abandonada')",
    },
    retenida_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    liberada_at: { type: 'timestamptz' },
    evidencia_file_id: { type: 'uuid', references: 'files', onDelete: 'SET NULL' },
    // The authority's document number, free text: it is transcribed from paper by whoever is standing
    // in front of the paper, and no format can be assumed.
    oficio_referencia: { type: 'text' },
    created_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createIndex('retenciones', 'operacion_id');
  pgm.createIndex('retenciones', 'operacion_guia_id');
  // The custody list: what is still held, oldest first. Cargo sitting in custody is a liability, so
  // the open set has to be cheap to enumerate.
  pgm.createIndex('retenciones', ['estado', 'retenida_at']);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('retenciones');
  pgm.dropTable('operacion_holds');
}
