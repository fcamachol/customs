import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * F18: Seed an empty denied_parties config row if absent.
 * This ensures the key exists in the config table so:
 *   - GET /api/catalogs/config/denied_parties returns [] instead of null
 *   - The risk engine loads an empty list on first run (no screening = no false positives)
 *   - Super-admin can populate via ingestSanctions.ts without a race condition
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    INSERT INTO config (key, value, updated_by, updated_at)
    VALUES ('denied_parties', '[]'::jsonb, 'migration', now())
    ON CONFLICT (key) DO NOTHING
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`DELETE FROM config WHERE key = 'denied_parties' AND value = '[]'::jsonb`);
}
