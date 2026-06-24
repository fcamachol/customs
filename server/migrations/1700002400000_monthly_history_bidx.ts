import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * F20c: Add consignee_name_bidx (HMAC blind-index token) to monthly_history.
 *
 * - Adds nullable `consignee_name_bidx text` column.
 * - Adds an index on (consignee_name_bidx, period, manifest_id) for token-keyed lookups.
 * - Does NOT add a NOT NULL constraint here because backfill (server/scripts/backfill-pii-encryption.ts)
 *   must run with the app's BLIND_INDEX_PEPPER before the column can be made required.
 * - The existing unique constraint on (consignee_name_norm, period, manifest_id) is KEPT so that
 *   existing records continue to upsert correctly until all rows have been backfilled.
 *   After backfill, a follow-up migration can promote the unique constraint to the bidx column.
 * - `consignee_name_norm` is retained (deprecated but not dropped) so that the COALESCE
 *   fallback in loadHistoryCounts works for un-backfilled rows.
 *
 * Down: drops the index and column, reverting to the pre-F20c schema.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('monthly_history', {
    consignee_name_bidx: { type: 'text' },
  });
  pgm.createIndex('monthly_history', ['consignee_name_bidx', 'period', 'manifest_id'], {
    name: 'monthly_history_bidx_period_manifest_idx',
    where: 'consignee_name_bidx IS NOT NULL',
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex('monthly_history', ['consignee_name_bidx', 'period', 'manifest_id'], {
    name: 'monthly_history_bidx_period_manifest_idx',
  });
  pgm.dropColumn('monthly_history', 'consignee_name_bidx');
}
