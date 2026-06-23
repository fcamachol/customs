import type { MigrationBuilder } from 'node-pg-migrate';

// On-screen reports + edit-before-lock support:
//  - risk_stale: set true when import_data changes after a risk run, so the UI can flag that the
//    persisted risk score no longer matches the current data and transmission must be blocked.
//  - import_data_version: monotonic token for optimistic concurrency on import-data edits.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumns('manifests', {
    risk_stale: { type: 'boolean', notNull: true, default: false },
    import_data_version: { type: 'integer', notNull: true, default: 0 },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumns('manifests', ['risk_stale', 'import_data_version']);
}
