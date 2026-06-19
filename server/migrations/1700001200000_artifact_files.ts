import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Widen the files.kind CHECK constraint to include 'risk_analysis'
  pgm.dropConstraint('files', 'files_kind_check');
  pgm.addConstraint('files', 'files_kind_check',
    "CHECK (kind IN ('manifest','pedimento_pdf','report','risk_analysis'))");

  // Add artifact file-id columns to manifests
  pgm.addColumns('manifests', {
    risk_file_id: { type: 'uuid', references: 'files', onDelete: 'SET NULL' },
    report_file_id: { type: 'uuid', references: 'files', onDelete: 'SET NULL' },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumns('manifests', ['risk_file_id', 'report_file_id']);
  pgm.dropConstraint('files', 'files_kind_check');
  pgm.addConstraint('files', 'files_kind_check',
    "CHECK (kind IN ('manifest','pedimento_pdf','report'))");
}
