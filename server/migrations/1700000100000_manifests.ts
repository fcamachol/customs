import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('manifests', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    mawb_reference: { type: 'text', notNull: true },
    client_name: { type: 'text' },
    file_id: { type: 'uuid', references: 'files', onDelete: 'SET NULL' },
    created_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('manifests', ['mawb_reference', 'client_name']);

  pgm.createTable('shipments', {
    id: { type: 'uuid', primaryKey: true },
    manifest_id: { type: 'uuid', notNull: true, references: 'manifests', onDelete: 'CASCADE' },
    data: { type: 'jsonb', notNull: true },
    risk_score: { type: 'integer' },
    risk_color: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('shipments', 'manifest_id');
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('shipments');
  pgm.dropTable('manifests');
}
