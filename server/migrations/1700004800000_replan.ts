import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * `replan_evaluaciones` and `replan_acciones` — the contingency engine's record
 * (PRD-02 §8.8, CT-1…CT-7; motor en shared/operaciones/replan.ts).
 *
 * WHY THE ENGINE NEEDS TABLES AT ALL, GIVEN `operacion_eventos` EXISTS. The ledger records what the
 * system DID. These two tables record what it DECIDED and on what basis — which is a different
 * question and the one an auditor actually asks. Two things live here that a timeline row cannot
 * hold:
 *
 *   1. THE INPUT. `snapshot` is the exact `EstadoOperativo` the pure engine was fed. With it plus
 *      `ruleset_version` and `ruleset_hash`, a decision taken in August is re-runnable in December
 *      and must produce the same actions — the same reproducibility contract the risk engine signs
 *      (D20). Without it, "the system excluded this shipment" is an assertion nobody can check,
 *      because the world it was reacting to has moved on.
 *   2. THE OPEN PROPOSAL. The one action class the engine may NOT perform — reassigning a contracted
 *      unit, which changes a tarifa (D6/P3/R20) — has to WAIT somewhere for a human. An append-only
 *      event cannot wait: it cannot later become confirmed or discarded. So the proposal is a row
 *      with a lifecycle, and the confirmation writes `override = true` with an obligatory motivo into
 *      the ledger, which is where the "who approved committing this money" answer belongs.
 *
 * WHY THE ENGINE MUST NOT STUTTER, AND HOW `clave` GUARANTEES IT. The tick re-evaluates every caso
 * every few minutes, and a flight stays cancelled for hours. `clave` is the engine's deterministic
 * fingerprint for an action (`claveAccion`), and the unique index below means the same decision is
 * recorded once no matter how many times it is re-derived — including after a human discarded it,
 * because re-proposing something a coordinator already ruled on is nagging, and a nagged alert is an
 * ignored alert. Getting this wrong would fill an append-only ledger with hundreds of identical rows
 * per caso, permanently and irreversibly.
 *
 * `despacho_id` IS TEXT AND HAS NO FOREIGN KEY, deliberately. The `despachos` table arrives with
 * backlog #29; the exposure it describes — a unit contracted against cargo that will not be there —
 * exists today and cannot wait for the dispatch module. The column is nullable for the interim case
 * where the engine knows a unit was committed (`estado_planeacion = 'asignada'`) but has no row to
 * point at. When #29 lands this becomes a real FK; until then a dangling text handle that a
 * coordinator can act on beats an exposure nobody sees.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('replan_evaluaciones', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    /**
     * CASCADE: an evaluation is meaningless without its caso, and the durable trace of what the
     * engine did lives in `operacion_eventos`, which is append-only and deliberately does NOT
     * cascade. Same reasoning as `operacion_holds` (migration 1700004600000).
     */
    operacion_id: { type: 'uuid', notNull: true, references: 'operaciones', onDelete: 'CASCADE' },
    ruleset_version: { type: 'text', notNull: true },
    // sha256 of the canonicalized ruleset. Version says "which edition"; the hash proves the
    // thresholds inside it were not quietly changed under the same name.
    ruleset_hash: { type: 'text', notNull: true },
    /**
     * What made us look. Distinguishes a periodic sweep from a reaction to a specific fact, which is
     * what tells a reader whether a decision was taken 4 minutes or 4 hours after the cause.
     */
    disparador: {
      type: 'text',
      notNull: true,
      check: "disparador IN ('tick','manual','vuelo','hold','guia')",
    },
    // The exact engine input. This is the reproducibility guarantee, not debug output.
    snapshot: { type: 'jsonb', notNull: true },
    // How many NEW actions this evaluation produced. Zero-action evaluations are not stored at all —
    // a row per caso every five minutes would bury the ones that decided something.
    acciones: { type: 'integer', notNull: true, default: 0 },
    created_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createIndex('replan_evaluaciones', ['operacion_id', 'created_at']);

  pgm.createTable('replan_acciones', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    evaluacion_id: {
      type: 'uuid',
      notNull: true,
      references: 'replan_evaluaciones',
      onDelete: 'CASCADE',
    },
    // Denormalized from the evaluation so the open-proposals query — the one a coordinator's screen
    // runs — never has to join, and so the partial unique index below can be keyed on the caso.
    operacion_id: { type: 'uuid', notNull: true, references: 'operaciones', onDelete: 'CASCADE' },
    contingencia: {
      type: 'text',
      notNull: true,
      check: "contingencia IN ('CT-1','CT-2','CT-3','CT-4','CT-5','CT-6','CT-7')",
    },
    tipo: {
      type: 'text',
      notNull: true,
      check:
        "tipo IN ('excluir_del_plan','reprogramar','abrir_hold'," +
        "'suspender_solicitud_unidades','notificar','reasignar_despacho')",
    },
    /** The engine's deterministic fingerprint (`claveAccion`). See the header for why it exists. */
    clave: { type: 'text', notNull: true },
    /**
     * The governance boundary, stored rather than re-derived. `automatica` is everything that costs
     * nothing to undo; `propuesta` is the money-touching reassignment. Keeping it on the row means a
     * later reader can see that an action was allowed to self-execute under the ruleset of the day,
     * even if the boundary is moved afterwards.
     */
    ejecucion: { type: 'text', notNull: true, check: "ejecucion IN ('automatica','propuesta')" },
    estado: {
      type: 'text',
      notNull: true,
      check: "estado IN ('ejecutada','propuesta','confirmada','descartada','fallida')",
    },
    payload: { type: 'jsonb', notNull: true },
    // The engine's own Spanish sentence: why this action, in terms the timeline reader understands.
    motivo: { type: 'text', notNull: true },
    /** `operacion_eventos.id` (bigserial). Plain bigint, no FK — the same reasoning that keeps
     *  `audit_log.entity_id` untyped: the ledger must never gain a dependency that could block an
     *  insert or, worse, participate in a cascade. */
    evento_id: { type: 'bigint' },
    decidida_at: { type: 'timestamptz' },
    decidida_por: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    /** WHY the human confirmed or discarded. This is the override record required by R20/N2. */
    decision_motivo: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  /**
   * Only a proposal can be pending, and only a proposal can be decided.
   *
   * `estado = 'propuesta'` with `ejecucion = 'automatica'` would be an action the engine was supposed
   * to perform sitting in a queue nobody watches — silent inaction dressed as a decision. The
   * converse, a `propuesta` action recorded as `ejecutada`, would mean the engine committed money.
   */
  pgm.addConstraint('replan_acciones', 'replan_acciones_ejecucion_estado_check', {
    check:
      "(estado IN ('propuesta','confirmada','descartada') AND ejecucion = 'propuesta') " +
      "OR (estado IN ('ejecutada','fallida') AND ejecucion = 'automatica')",
  });

  /**
   * A decision is a person, a time and a reason, or it is not a decision.
   *
   * Written as an equality between two booleans so both implications are covered by one constraint:
   * a decided row must carry `decidida_at`, and an undecided row must not pretend to. The motivo is
   * checked for non-blank because `'   '` satisfies notNull while telling a reader nothing — the same
   * trap `operacion_holds.motivo` guards against.
   */
  pgm.addConstraint('replan_acciones', 'replan_acciones_decision_check', {
    check:
      "(estado IN ('confirmada','descartada')) = (decidida_at IS NOT NULL) " +
      "AND (estado NOT IN ('confirmada','descartada') " +
      "     OR (decision_motivo IS NOT NULL AND btrim(decision_motivo) <> ''))",
  });

  /**
   * The anti-stutter guarantee, as a database invariant rather than a hope about application code.
   *
   * TOTAL, not partial. A decision is recorded once per caso per fingerprint whatever became of it:
   * re-proposing a reassignment a coordinator already discarded would be nagging, and a nagged alert
   * is an ignored alert. Genuinely different decisions carry different fingerprints by construction
   * (`claveAccion` folds in the new reprogramming date, the affected guías, the retención ids), so
   * uniqueness here costs nothing real and buys an ironclad "the ledger cannot fill with duplicates".
   */
  pgm.createIndex('replan_acciones', ['operacion_id', 'clave'], {
    name: 'replan_acciones_clave_uq',
    unique: true,
  });

  pgm.createIndex('replan_acciones', 'evaluacion_id');
  // The coordinator's queue: what is waiting for a human decision, oldest first. This is the screen
  // that prevents a flete en falso, so it has to be cheap even as executed actions accumulate.
  pgm.createIndex('replan_acciones', ['estado', 'created_at'], {
    name: 'replan_acciones_pendientes_idx',
    where: "estado = 'propuesta'",
  });

  /**
   * The engine's own cursor row, seeded like the AGORA one (migration 1700004100000).
   *
   * Without it a dead scheduler is invisible: "no contingencies today" and "nothing has evaluated
   * contingencies since Tuesday" look identical from the outside, and the second one is how a truck
   * gets contracted against cancelled cargo.
   */
  pgm.sql(`
    INSERT INTO integracion_cursores (fuente) VALUES ('replan')
    ON CONFLICT (fuente) DO NOTHING
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`DELETE FROM integracion_cursores WHERE fuente = 'replan'`);
  pgm.dropTable('replan_acciones');
  pgm.dropTable('replan_evaluaciones');
}
