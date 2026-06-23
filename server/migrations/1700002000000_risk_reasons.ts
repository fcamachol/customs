import type { MigrationBuilder } from 'node-pg-migrate';

/** Adds risk_reasons (fired ReasonCode array) and ruleset_hash (content hash of the applied ruleset) to shipments. */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumns('shipments', {
    risk_reasons: { type: 'jsonb' },
    ruleset_hash: { type: 'text' },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumns('shipments', ['risk_reasons', 'ruleset_hash']);
}
