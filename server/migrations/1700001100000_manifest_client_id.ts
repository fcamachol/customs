import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumns('manifests', {
    client_id: {
      type: 'uuid',
      references: 'clients',
      onDelete: 'SET NULL',
    },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumns('manifests', ['client_id']);
}
