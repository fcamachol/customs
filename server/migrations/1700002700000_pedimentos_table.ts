import { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('pedimentos', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    manifest_id: { type: 'uuid', notNull: true, references: 'manifests', onDelete: 'CASCADE' },
    numero_pedimento: { type: 'text' },
    master_guide: { type: 'text' },
    subdivision_ordinal: { type: 'integer' },
    is_last_subdivision: { type: 'boolean' },
    sibling_numeros: { type: 'text[]' },
    bultos: { type: 'integer' },
    peso_bruto_kg: { type: 'numeric' },
    file_id: { type: 'uuid', references: 'files', onDelete: 'SET NULL' },
    pedimento: { type: 'jsonb' },
    prevalidation: { type: 'jsonb' },
    pedimento_scan: { type: 'jsonb' },
    import_data: { type: 'jsonb' },
    import_data_version: { type: 'integer', notNull: true, default: 0 },
    covered_guias: { type: 'text[]' },
    reconciliation: { type: 'jsonb' },
    created_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('pedimentos', 'manifest_id');

  // Backfill: one pedimento row per manifest that currently has any pedimento data.
  pgm.sql(`
    INSERT INTO pedimentos
      (manifest_id, numero_pedimento, master_guide, file_id, pedimento, prevalidation,
       pedimento_scan, import_data, import_data_version, created_by, created_at)
    SELECT m.id,
           m.pedimento->'header'->>'numeroPedimento',
           m.mawb_reference,
           m.file_id, m.pedimento, m.prevalidation, m.pedimento_scan,
           m.import_data, COALESCE(m.import_data_version, 0), m.created_by, m.created_at
    FROM manifests m
    WHERE m.file_id IS NOT NULL OR m.pedimento IS NOT NULL
       OR m.prevalidation IS NOT NULL OR m.import_data IS NOT NULL
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('pedimentos');
}
