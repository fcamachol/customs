import type { MigrationBuilder } from 'node-pg-migrate';
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumns('manifests', {
    pedimento: { type: 'jsonb' },
    prevalidation: { type: 'jsonb' },
  });
}
export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumns('manifests', ['pedimento', 'prevalidation']);
}
