import type { MigrationBuilder } from 'node-pg-migrate';

// Phase A: bronze/silver staging for manifest ingestion.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumns('files', { content_hash: { type: 'text' } });

  pgm.addColumns('manifests', {
    ingestion_status: { type: 'text', notNull: true, default: 'draft' },
    source_file_id: { type: 'uuid', references: 'files', onDelete: 'SET NULL' },
    source_header: { type: 'jsonb' },
    file_content_hash: { type: 'text' },
  });
  pgm.addConstraint('manifests', 'manifests_ingestion_status_check', {
    check: "ingestion_status IN ('draft','staged','promoted')",
  });

  pgm.createTable('manifest_staging_rows', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    manifest_id: { type: 'uuid', notNull: true, references: 'manifests', onDelete: 'CASCADE' },
    row_index: { type: 'integer', notNull: true },
    idempotency_key: { type: 'text', notNull: true },
    data: { type: 'jsonb', notNull: true },
    status: { type: 'text', notNull: true },
    errors: { type: 'jsonb', notNull: true, default: '[]' },
    warnings: { type: 'jsonb', notNull: true, default: '[]' },
    promoted_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('manifest_staging_rows', 'manifest_staging_rows_status_check', {
    check: "status IN ('valid','warning','error')",
  });
  pgm.addConstraint('manifest_staging_rows', 'manifest_staging_rows_idem_uq', {
    unique: ['manifest_id', 'idempotency_key'],
  });
  pgm.createIndex('manifest_staging_rows', 'manifest_id');

  pgm.addColumns('shipments', { idempotency_key: { type: 'text' } });
  pgm.addConstraint('shipments', 'shipments_manifest_idem_uq', {
    unique: ['manifest_id', 'idempotency_key'],
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint('shipments', 'shipments_manifest_idem_uq');
  pgm.dropColumns('shipments', ['idempotency_key']);
  pgm.dropTable('manifest_staging_rows');
  pgm.dropConstraint('manifests', 'manifests_ingestion_status_check');
  pgm.dropColumns('manifests', ['ingestion_status', 'source_file_id', 'source_header', 'file_content_hash']);
  pgm.dropColumns('files', ['content_hash']);
}
