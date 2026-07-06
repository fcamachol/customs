import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * Entity catalogs: multiple agentes aduanales & importadores, auto-registered from pedimentos.
 *
 * Replaces the single-entity config keys (importer_of_record / customs_agent) with catalog tables
 * keyed by their natural identity (patente / RFC). Rows are auto-registered (verified=false) from
 * uploaded pedimentos and can be promoted to verified via the admin catalog API.
 *
 * Data migration: if the legacy config keys hold usable values, seed them as verified=true rows.
 * The config rows are left in place (now unused) so nothing else breaks mid-cutover.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('agentes_aduanales', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    patente: { type: 'text', notNull: true, unique: true },
    name: { type: 'text' },
    agent_rfc: { type: 'text' },
    agency_rfc: { type: 'text' },
    verified: { type: 'boolean', notNull: true, default: false },
    created_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createTable('importadores', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    rfc: { type: 'text', notNull: true, unique: true },
    name: { type: 'text' },
    fiscal_address: { type: 'text' },
    verified: { type: 'boolean', notNull: true, default: false },
    created_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // Data-migrate the legacy single-entity config keys as verified rows when they hold a usable
  // natural key. Extra keys on the JSON (or a missing key) simply produce no row.
  pgm.sql(`
    INSERT INTO agentes_aduanales (patente, name, agent_rfc, agency_rfc, verified)
    SELECT value->>'patente', value->>'name', value->>'agentRfc', value->>'agencyRfc', true
    FROM config
    WHERE key = 'customs_agent'
      AND COALESCE(value->>'patente', '') <> ''
    ON CONFLICT (patente) DO NOTHING
  `);

  pgm.sql(`
    INSERT INTO importadores (rfc, name, fiscal_address, verified)
    SELECT value->>'rfc', value->>'name', value->>'fiscalAddress', true
    FROM config
    WHERE key = 'importer_of_record'
      AND COALESCE(value->>'rfc', '') <> ''
    ON CONFLICT (rfc) DO NOTHING
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('importadores');
  pgm.dropTable('agentes_aduanales');
}
