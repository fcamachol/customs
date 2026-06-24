import type { MigrationBuilder } from 'node-pg-migrate';

// A client can own many platforms. This table replaces the single embedded clients.platform jsonb
// as the source of truth. manifests.platform_id is the explicit per-manifest pick that the Reporte
// General overlays. The legacy clients.platform column is kept (untouched) for one release.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('client_platforms', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    client_id: { type: 'uuid', notNull: true, references: 'clients', onDelete: 'CASCADE' },
    commercial_name: { type: 'text' },
    country_of_origin: { type: 'text' },
    legal_name: { type: 'text' },
    email: { type: 'text' },
    created_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('client_platforms', 'client_id');

  pgm.addColumns('manifests', {
    platform_id: { type: 'uuid', references: 'client_platforms', onDelete: 'SET NULL' },
  });

  // Backfill: one platform row per client whose legacy jsonb carries at least one non-empty field.
  pgm.sql(`
    INSERT INTO client_platforms (client_id, commercial_name, country_of_origin, legal_name, email, created_by)
    SELECT id,
           NULLIF(btrim(platform->>'commercialName'),''),
           NULLIF(btrim(platform->>'countryOfOrigin'),''),
           NULLIF(btrim(platform->>'legalName'),''),
           NULLIF(btrim(platform->>'email'),''),
           created_by
    FROM clients
    WHERE platform IS NOT NULL
      AND COALESCE(
        NULLIF(btrim(platform->>'commercialName'),''),
        NULLIF(btrim(platform->>'countryOfOrigin'),''),
        NULLIF(btrim(platform->>'legalName'),''),
        NULLIF(btrim(platform->>'email'),'')) IS NOT NULL
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumns('manifests', ['platform_id']);
  pgm.dropTable('client_platforms');
}
