import { MigrationBuilder } from 'node-pg-migrate';

// Task 10: reports/exports are per-pedimento (each subdivisión is its own customs submission with
// its own Reporte General). The cached report.xlsx artifact moves from manifests.report_file_id onto
// the pedimentos row it belongs to, so a capture edit on one subdivision busts only its own report.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('pedimentos', {
    report_file_id: { type: 'uuid', references: 'files', onDelete: 'SET NULL' },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn('pedimentos', 'report_file_id');
}
