import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('clients', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    name: { type: 'text', notNull: true },
    tax_id: { type: 'text' },
    address: { type: 'text' },
    phone: { type: 'text' },
    email: { type: 'text' },
    platform: { type: 'jsonb' },
    created_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createTable('config', {
    key: { type: 'text', primaryKey: true },
    value: { type: 'jsonb' },
    updated_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('config');
  pgm.dropTable('clients');
}
