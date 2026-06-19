import type { MigrationBuilder } from 'node-pg-migrate';
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumns('audit_log', {
    ip_address: { type: 'text' },
    prev_hash: { type: 'text' },
    hash: { type: 'text' },
  });
}
export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumns('audit_log', ['ip_address', 'prev_hash', 'hash']);
}
