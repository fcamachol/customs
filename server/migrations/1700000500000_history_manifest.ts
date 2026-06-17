import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumns('monthly_history', {
    manifest_id: { type: 'uuid', references: 'manifests', onDelete: 'CASCADE' },
  });
  pgm.dropConstraint('monthly_history', 'monthly_history_uniq');
  pgm.addConstraint('monthly_history', 'monthly_history_uniq', {
    unique: ['consignee_name_norm', 'period', 'manifest_id'],
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint('monthly_history', 'monthly_history_uniq');
  pgm.addConstraint('monthly_history', 'monthly_history_uniq', {
    unique: ['consignee_name_norm', 'period'],
  });
  pgm.dropColumns('monthly_history', ['manifest_id']);
}
