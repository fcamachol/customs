import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * Per-client header mappings: teach the manifest parser a client's column naming without a code
 * change. Each row maps a NORMALIZED spreadsheet header (headerSynonyms.normalize()) to one of the
 * canonical paths. client_id NULL = a global mapping that applies to every client; a client-specific
 * row overrides the global one at resolve time.
 *
 * Uniqueness must treat NULL client_id as a single distinct "global" bucket (a plain UNIQUE would
 * let duplicate global rows through, since NULL <> NULL). We index COALESCE(client_id, sentinel) so
 * the global bucket collapses to one value — and, because the expression is written identically in
 * the upsert, ON CONFLICT can infer this index.
 */
const GLOBAL_SENTINEL = '00000000-0000-0000-0000-000000000000';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('client_header_mappings', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    client_id: { type: 'uuid', references: 'clients', onDelete: 'CASCADE' }, // NULL = global mapping
    header_normalized: { type: 'text', notNull: true },
    canonical_path: { type: 'text', notNull: true },
    created_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('client_header_mappings', 'client_id');
  pgm.sql(`
    CREATE UNIQUE INDEX client_header_mappings_client_header_uq
    ON client_header_mappings (COALESCE(client_id, '${GLOBAL_SENTINEL}'::uuid), header_normalized)
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('client_header_mappings');
}
