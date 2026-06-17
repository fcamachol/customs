import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION audit_block_mutation() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'audit_log is append-only'; END;
    $$ LANGUAGE plpgsql;
  `);
  pgm.sql(`
    CREATE TRIGGER audit_no_update_delete
    BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION audit_block_mutation();
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`DROP TRIGGER IF EXISTS audit_no_update_delete ON audit_log;`);
  pgm.sql(`DROP FUNCTION IF EXISTS audit_block_mutation();`);
}
