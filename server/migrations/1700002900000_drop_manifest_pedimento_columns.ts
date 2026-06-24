import type { MigrationBuilder } from 'node-pg-migrate';

// Task 11: all pedimento-scoped data is now on pedimentos rows (Tasks 7–10).
// These seven manifests columns are dead — no server code reads or writes them.
// Drop them to enforce the constraint at the DB level and slim the table.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumns('manifests', [
    'file_id',
    'pedimento',
    'prevalidation',
    'pedimento_scan',
    'import_data',
    'import_data_version',
    'report_file_id',
  ]);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // Restore each column with its original type / constraints (reversible but data is lost).
  pgm.addColumns('manifests', {
    file_id:              { type: 'uuid', references: 'files', onDelete: 'SET NULL' },
    pedimento:            { type: 'jsonb' },
    prevalidation:        { type: 'jsonb' },
    pedimento_scan:       { type: 'jsonb' },
    import_data:          { type: 'jsonb' },
    import_data_version:  { type: 'integer', notNull: true, default: 0 },
    report_file_id:       { type: 'uuid', references: 'files', onDelete: 'SET NULL' },
  });
}
