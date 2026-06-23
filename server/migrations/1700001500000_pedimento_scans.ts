import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('pedimento_scans', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    manifest_id: { type: 'uuid', notNull: true, references: 'manifests', onDelete: 'CASCADE' },
    file_id: { type: 'uuid', references: 'files', onDelete: 'SET NULL' },
    verdict: { type: 'text', notNull: true },
    result: { type: 'jsonb' },
    created_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('pedimento_scans', 'manifest_id');
  pgm.addColumn('manifests', { pedimento_scan: { type: 'jsonb' } });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn('manifests', 'pedimento_scan');
  pgm.dropTable('pedimento_scans');
}
