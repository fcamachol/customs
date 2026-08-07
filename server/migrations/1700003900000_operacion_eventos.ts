import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * `operacion_eventos` — the logistics timeline. Append-only, enforced by trigger, exactly like
 * `audit_log` (migration 1700000400000). This table IS the tamper-evidence argument the platform
 * makes to the authority, so it must be structurally impossible to rewrite history.
 *
 * TWO DESIGN POINTS THAT LOOK LIKE MISTAKES AND ARE NOT:
 *
 * 1. `operacion_id` is ON DELETE SET NULL, not CASCADE, and `operacion_mawb` is denormalized
 *    alongside it. A CASCADE would (a) always fail, because the append-only trigger rejects the
 *    row-level DELETE the cascade issues, and (b) far worse, if it did work, deleting an operación
 *    would delete its history — turning row deletion into a laundering path, which is precisely the
 *    hole this module exists to close. `audit_log.entity_id` already follows the same reasoning by
 *    being plain text with no FK. Events therefore outlive their operación: orphaned but verifiable.
 *
 * 2. `ocurrido_at` (when the fact happened) is separate from `registrado_at` (when we learned).
 *    Non-negotiable for modulación: phones are not allowed at the semáforo, so the tramitador
 *    captures ~5 minutes late and must be able to record the real event time (PRD-02 R33).
 *
 * Every insert here is ALSO written to `audit_log` via recordAudit(), so one hash chain and one
 * `GET /api/audit/verify` cover both documentary and logistics history. A second parallel chain
 * would be a weaker story in front of an auditor, not a stronger one.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('operacion_eventos', {
    id: { type: 'bigserial', primaryKey: true },
    operacion_id: { type: 'uuid', references: 'operaciones', onDelete: 'SET NULL' },
    operacion_mawb: { type: 'text', notNull: true },
    tipo: { type: 'text', notNull: true },
    origen: {
      type: 'text',
      notNull: true,
      default: 'sistema',
      check:
        "origen IN ('sistema','tramitador','coordinador','cliente','transportista','feed_vuelo','feed_gps')",
    },
    ocurrido_at: { type: 'timestamptz', notNull: true },
    registrado_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    payload: { type: 'jsonb' },
    override: { type: 'boolean', notNull: true, default: false },
    // Enforced at the validation layer too, but stated here so the invariant survives any writer:
    // a human overriding the system must say why (PRD-02 N2 / R20).
    motivo: { type: 'text' },
    lat: { type: 'numeric' },
    lng: { type: 'numeric' },
    evidencia_file_id: { type: 'uuid', references: 'files', onDelete: 'SET NULL' },
    created_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('operacion_eventos', 'operacion_eventos_override_motivo_check',
    "CHECK (override = false OR (motivo IS NOT NULL AND btrim(motivo) <> ''))");

  pgm.createIndex('operacion_eventos', ['operacion_id', 'ocurrido_at']);
  pgm.createIndex('operacion_eventos', 'operacion_mawb');
  pgm.createIndex('operacion_eventos', 'tipo');

  pgm.sql(`
    CREATE OR REPLACE FUNCTION operacion_eventos_block_mutation() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'operacion_eventos is append-only'; END;
    $$ LANGUAGE plpgsql;
  `);
  pgm.sql(`
    CREATE TRIGGER operacion_eventos_no_update_delete
    BEFORE UPDATE OR DELETE ON operacion_eventos
    FOR EACH ROW EXECUTE FUNCTION operacion_eventos_block_mutation();
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`DROP TRIGGER IF EXISTS operacion_eventos_no_update_delete ON operacion_eventos;`);
  pgm.sql(`DROP FUNCTION IF EXISTS operacion_eventos_block_mutation();`);
  pgm.dropTable('operacion_eventos');
}
