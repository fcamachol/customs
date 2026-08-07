import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * `operacion_guias` — the house guías (guías casa) that travel inside one guía máster (PRD-02 §8.5).
 *
 * WHY A TABLE AND NOT A DERIVED QUERY OVER `shipments`. The house guía, not the operación, is the
 * unit of everything that happens after arrival: planning loads a truck with N guías for N clients
 * (R29), a retención holds SOME guías while the rest are dispatched (CT-5), `no_transmitida` excludes
 * one guía from the plan and asks for a replacement (CT-2), and a pedimento covers a specific set of
 * them. None of those states can live in `shipments`, which is the manifest's line-item layer: a
 * guía is many lines, lines are replaced wholesale on every re-promotion (`ON CONFLICT … DO UPDATE`),
 * and a manifest may not exist at all yet. So the guía needs its own identity with its own lifecycle.
 *
 * IT IS ALSO THE PRECONDITION FOR PA-07. The cotejo rule "the same house guía appears on another open
 * operación" — one shipment declared twice, whether clerical or deliberate — needs the guías to be
 * QUERYABLE across operaciones. `prealertaIngest` was already written against this table before it
 * existed, so the rule's query failed at runtime and was swallowed by its own best-effort try/catch:
 * PA-07 silently never fired. Duplicate cargo is exactly the kind of finding that must not depend on
 * a table someone forgot to migrate.
 *
 * `guia_norm` is the compare-time normalized form (shared/pedimento/guia.ts `normGuia`), which is what
 * carries the unique constraint and what PA-07 joins on, because the same guía is routinely written
 * with different punctuation by the manifest, the AWB and the pedimento. `guia_raw` keeps what the
 * client actually sent, because that is the string a human has to reconcile against paper.
 *
 * `estado` starts at `declarada` and is advanced ONLY by observed facts. Deliberately never reset by
 * a re-ingest: a guía already marked `retenida` or `no_transmitida` must not silently return to
 * `declarada` because the client resent the manifiesto.
 *
 * `piezas`, `cartones` and `peso_kg` are denormalized from the manifest lines so planning can size a
 * load without reading the gold layer, and so a partial retención has numbers to subtract from.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('operacion_guias', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    operacion_id: { type: 'uuid', notNull: true, references: 'operaciones', onDelete: 'CASCADE' },
    guia_norm: { type: 'text', notNull: true },
    guia_raw: { type: 'text' },
    // A single guía máster can carry cargo for several clients (R29), so the client is per-guía and
    // SET NULL: losing the client must never delete the record of the cargo.
    client_id: { type: 'uuid', references: 'clients', onDelete: 'SET NULL' },
    piezas: { type: 'integer' },
    cartones: { type: 'integer' },
    peso_kg: { type: 'numeric' },
    pedimento_id: { type: 'uuid', references: 'pedimentos', onDelete: 'SET NULL' },
    estado: {
      type: 'text',
      notNull: true,
      default: 'declarada',
      check:
        "estado IN ('declarada','no_transmitida','csa_pendiente','liberada','retenida','cancelada')",
    },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // The upsert target of the manifiesto ingest: one row per guía per operación, so a resend refreshes
  // the aggregates instead of accumulating duplicate guías.
  pgm.addConstraint('operacion_guias', 'operacion_guias_operacion_guia_uq', {
    unique: ['operacion_id', 'guia_norm'],
  });

  // PA-07 asks "does this guía appear on ANY other operación", i.e. a lookup by guía across
  // operaciones — which the composite unique index above cannot serve, since guia_norm is not its
  // leading column.
  pgm.createIndex('operacion_guias', 'guia_norm');
  pgm.createIndex('operacion_guias', 'pedimento_id');
  pgm.createIndex('operacion_guias', ['operacion_id', 'estado']);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('operacion_guias');
}
