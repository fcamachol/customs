import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('pedimentos', { pedimento_reconciliation: { type: 'jsonb' } });
}
export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn('pedimentos', 'pedimento_reconciliation');
}
