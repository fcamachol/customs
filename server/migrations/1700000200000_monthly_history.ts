import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('monthly_history', {
    id: { type: 'bigserial', primaryKey: true },
    consignee_name_norm: { type: 'text', notNull: true },
    period: { type: 'text', notNull: true },
    seen_count: { type: 'integer', notNull: true, default: 1 },
  });
  pgm.addConstraint('monthly_history', 'monthly_history_uniq', { unique: ['consignee_name_norm', 'period'] });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('monthly_history');
}
