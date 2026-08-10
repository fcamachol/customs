import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * `despachos` and `despacho_partidas` — one truck, one trip (PRD-02 §8.5, R21, R22/D7, R29, R36/D14,
 * CT-7/D10).
 *
 * WHAT A DESPACHO IS, AND WHY IT IS NOT A COLUMN ON `operaciones`. R29, stated in the meeting as
 * "una unidad, un destino, N guías, N clientes": a single tracto leaves the aduana carrying house
 * guías belonging to several different importers, all bound for the same physical warehouse. The
 * trip is therefore its own object with a cardinality nothing else in the schema has — many-to-many
 * between casos and trips — and every attempt to hang it off `operaciones` ends with either one row
 * per guía (so the truck is invisible) or one caso per truck (so the cargo is). `despacho_partidas`
 * is that join, and it is where the loading consecutive the warehouse asks for lives (R14).
 *
 * `estado` IS THE ANSWER TO "REUSE THE EXCEL FORMULA" (R21). The twelve values are an explicit state
 * machine (shared/operaciones/catalogos.ts, `canAdvanceEstadoDespacho`), monotonic along the happy
 * path, with `cancelado` reachable from anywhere and `en_espera` only reachable BEFORE loading
 * starts — because once cargo is moving onto the unit the flete is owed and "on hold" would be a
 * fiction hiding a cost.
 *
 * THE TIMESTAMP COLUMNS ARE NOT REDUNDANT WITH THE STATE. `cita_at` against `ingreso_patio_at` is
 * the entire point of R30 — cité 10:00, entró 10:05 — and a state column can only ever hold the
 * latest value, never the delta. Same reason `inicio_carga_at`/`fin_carga_at` exist beside
 * `cargando`/`cargado`: the dwell time is the KPI, the state is just where the row is now.
 *
 * `eta_calculado` AND `arribo_real` SIT SIDE BY SIDE ON PURPOSE (D14). Fernando proposed and Roberto
 * approved separating the calculated arrival from the observed one. An estimate that gets overwritten
 * by reality is not an estimate; the number that has to be explained to a client is the GAP, so both
 * are stored and neither is ever written over the other.
 *
 * `reasignado_de_despacho_id` IS THE FOOTPRINT OF CT-7 / D10 — the anti-flete-en-falso move. When a
 * flight slips, the contracted tracto is REASSIGNED to other cargo for the same destination rather
 * than cancelled, because a cancelled truck is still billed. The self-reference records which trip
 * this one inherited, so the money question ("what did we actually pay for, and against which
 * cargo?") stays answerable. §8.8's governance rule applies: the engine may PROPOSE a reassignment,
 * a human confirms it, and the confirmation lands in `operacion_eventos` with `override = true` and a
 * mandatory `motivo`.
 *
 * Also widens `operacion_eventos` with `despacho_id` (PRD-02 §8.5). A trip event has to be readable
 * from both ends — the caso's timeline and the trip's — and the ledger is append-only, so the link
 * must be a column on the row rather than something attached later. SET NULL for the same reason
 * `operacion_id` is: deleting a despacho must never become a way to erase its history. Adding a
 * column is DDL, so the row-level append-only trigger does not fire and existing rows are untouched.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('despachos', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    /**
     * The human handle. UNIQUE and notNull: the folio is what goes on the published plan, on the
     * transportista's request and on the POD, and it is how three organisations that do not share a
     * database refer to the same trip.
     */
    folio: { type: 'text', notNull: true, unique: true },
    fecha_operacion: { type: 'date', notNull: true },
    /**
     * D7, structurally. notNull with NO default — a despacho cannot exist without its unit type, so
     * the type is decided before a carrier can even be named. The glossary is R23/D8 in full; the
     * app-side copy is shared/operaciones/catalogos.ts and a test pins the two together.
     */
    tipo_unidad: {
      type: 'text',
      notNull: true,
      check: "tipo_unidad IN ('tracto','torton','rabon','t3_5','silverado','cargo_van')",
    },
    // Nullable and SET NULL: a trip is planned before a carrier is called (that is D7), and the trip
    // record must outlive a carrier we stopped working with.
    transportista_id: { type: 'uuid', references: 'transportistas', onDelete: 'SET NULL' },
    unidad_id: { type: 'uuid', references: 'transportista_unidades', onDelete: 'SET NULL' },
    /**
     * Denormalized AT THE MOMENT OF THE TRIP, and that is the point. Plates get reassigned and unit
     * rows get retired; the question "which vehicle carried this cargo on the 14th" must be
     * answerable from the trip itself, not from whatever the fleet catalog says today.
     */
    placas: { type: 'text' },
    operador_nombre: { type: 'text' },
    // ONE destination per trip (R29). Many guías and many clients, one address.
    direccion_entrega_id: { type: 'uuid', references: 'client_direcciones', onDelete: 'SET NULL' },
    estado: {
      type: 'text',
      notNull: true,
      default: 'planeado',
      check:
        "estado IN ('planeado','solicitado','confirmado','en_patio','en_aduana','cargando'," +
        "'cargado','modulado','en_transito','entregado','cancelado','en_espera')",
    },
    // The appointment given to the transportista. R30 measures reality against it.
    cita_at: { type: 'timestamptz' },
    ingreso_patio_at: { type: 'timestamptz' },
    ingreso_aduana_at: { type: 'timestamptz' },
    inicio_carga_at: { type: 'timestamptz' },
    fin_carga_at: { type: 'timestamptz' },
    modulacion_at: { type: 'timestamptz' },
    salida_at: { type: 'timestamptz' },
    // D14 — calculated and observed, never one overwriting the other. See the file header.
    eta_calculado: { type: 'timestamptz' },
    arribo_real: { type: 'timestamptz' },
    /**
     * How the estimate was produced: ruleset version, method, distance, assumptions
     * (shared/operaciones/eta.ts). Stored beside the number because an estimate whose basis cannot be
     * inspected is not auditable, and because when a real routing provider replaces the deterministic
     * ruleset the old rows must still explain themselves.
     */
    eta_calculo: { type: 'jsonb' },
    // What this trip costs and under which agreed rate. SET NULL: the trip's own `tarifa_monto` is
    // the amount that was agreed, and it must survive the tariff row being superseded.
    tarifa_id: { type: 'uuid', references: 'transportista_tarifas', onDelete: 'SET NULL' },
    tarifa_monto: { type: 'numeric' },
    moneda: { type: 'text' },
    // CT-7 / D10 — see the file header.
    reasignado_de_despacho_id: { type: 'uuid', references: 'despachos', onDelete: 'SET NULL' },
    comentarios: { type: 'text' },
    created_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  /**
   * A unit may not be assigned without its carrier. The reverse is fine and is the normal flow (a
   * carrier is engaged, the plates come later), but a `unidad_id` with no `transportista_id` would
   * be a vehicle belonging to nobody — unanswerable when the question is who to call.
   */
  pgm.addConstraint('despachos', 'despachos_unidad_requiere_transportista_check', {
    check: 'unidad_id IS NULL OR transportista_id IS NOT NULL',
  });
  // A trip cannot be its own predecessor: the CT-7 chain has to terminate.
  pgm.addConstraint('despachos', 'despachos_reasignacion_no_circular_check', {
    check: 'reasignado_de_despacho_id IS NULL OR reasignado_de_despacho_id <> id',
  });

  // The day's board — the single most frequent read (`GET /api/planeacion?fecha=`).
  pgm.createIndex('despachos', ['fecha_operacion', 'estado']);
  pgm.createIndex('despachos', 'transportista_id');
  pgm.createIndex('despachos', 'unidad_id');
  pgm.createIndex('despachos', 'direccion_entrega_id');
  pgm.createIndex('despachos', 'reasignado_de_despacho_id');

  pgm.createTable('despacho_partidas', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    despacho_id: { type: 'uuid', notNull: true, references: 'despachos', onDelete: 'CASCADE' },
    // CASCADE from the caso as well: a partida is meaningless without the cargo it names. The durable
    // record of what travelled is the ledger event, which does not cascade.
    operacion_id: { type: 'uuid', notNull: true, references: 'operaciones', onDelete: 'CASCADE' },
    /**
     * The house guía. SET NULL rather than CASCADE so a re-ingest that drops a line cannot silently
     * delete the record that the line was loaded onto a truck.
     */
    operacion_guia_id: { type: 'uuid', references: 'operacion_guias', onDelete: 'SET NULL' },
    pedimento_id: { type: 'uuid', references: 'pedimentos', onDelete: 'SET NULL' },
    /**
     * Planned versus actually loaded. Two columns, not one, because the difference is a fact somebody
     * has to explain — a truck that left with fewer cartons than the plan said is either a retención
     * (CT-5), a short manifest, or cargo left on the dock, and collapsing the two numbers into one
     * erases the question.
     */
    cartones_planeados: { type: 'integer' },
    cartones_cargados: { type: 'integer' },
    piezas: { type: 'integer' },
    // R14: the consecutive the warehouse stages by. Unique within a trip (constraint below) because
    // two lines sharing position 3 is an instruction nobody can follow.
    orden_carga: { type: 'integer' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  /**
   * One line per guía per trip. NULLS NOT DISTINCT is essential and easy to miss: by default
   * Postgres treats every NULL as unique, so without it a whole-caso partida (`operacion_guia_id IS
   * NULL`) could be added to the same truck any number of times and the constraint would never fire
   * — the exact duplicate-loading error this is here to prevent. Requires PostgreSQL 15+.
   */
  pgm.sql(`
    ALTER TABLE despacho_partidas
      ADD CONSTRAINT despacho_partidas_unica_uq
      UNIQUE NULLS NOT DISTINCT (despacho_id, operacion_id, operacion_guia_id)
  `);
  pgm.addConstraint('despacho_partidas', 'despacho_partidas_orden_carga_uq', {
    unique: ['despacho_id', 'orden_carga'],
  });
  pgm.addConstraint('despacho_partidas', 'despacho_partidas_orden_carga_positivo_check', {
    check: 'orden_carga IS NULL OR orden_carga >= 1',
  });
  pgm.addConstraint('despacho_partidas', 'despacho_partidas_cantidades_check', {
    check:
      '(cartones_planeados IS NULL OR cartones_planeados >= 0) AND ' +
      '(cartones_cargados IS NULL OR cartones_cargados >= 0) AND ' +
      '(piezas IS NULL OR piezas >= 0)',
  });

  pgm.createIndex('despacho_partidas', 'despacho_id');
  // "Which trucks did this caso go out on?" — the operación detail screen and the financial link.
  pgm.createIndex('despacho_partidas', 'operacion_id');
  pgm.createIndex('despacho_partidas', 'operacion_guia_id');

  /**
   * Link trip events into the ledger. See the file header for why this is a column and not a side
   * table. Not indexed on `despacho_id` alone but paired with `ocurrido_at`, because the only query
   * that uses it is "this trip's timeline, in order".
   */
  pgm.addColumn('operacion_eventos', {
    despacho_id: { type: 'uuid', references: 'despachos', onDelete: 'SET NULL' },
  });
  pgm.createIndex('operacion_eventos', ['despacho_id', 'ocurrido_at']);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex('operacion_eventos', ['despacho_id', 'ocurrido_at']);
  pgm.dropColumn('operacion_eventos', 'despacho_id');
  pgm.dropTable('despacho_partidas');
  pgm.dropTable('despachos');
}
