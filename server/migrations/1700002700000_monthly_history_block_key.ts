import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * F14: Add consignee_name_block_key (phonetic blocking key) to monthly_history.
 *
 * PRIVACY TRADE-OFF (MUST REVIEW BEFORE DEPLOYING):
 * ─────────────────────────────────────────────────
 * The block_key is a LOSSY, NAME-DERIVED value: token-sorted, diacritic-stripped,
 * Spanish-phonetically-folded representation of the consignee name.
 *
 *   - LESS identifying than plaintext (original name is not recoverable).
 *   - MORE exposed than the HMAC blind-index token (consignee_name_bidx) from F20.
 *
 * This column PARTIALLY RE-INTRODUCES name-derived data that F20 encrypted. The purpose
 * is to enable cross-manifest typo clustering for Ficha-124 recurrence detection:
 * two manifests submitted days apart with "Juan Perez" vs "Juan Peres" should fire bbdd.
 *
 * The block_key is ONLY used for ID-less consignees (no RFC/CURP). RFC/CURP-keyed
 * consignees are NOT stored with a block_key (column is nullable; it should only
 * be populated for rows where consignee has no valid RFC/CURP).
 *
 * If this trade-off is deemed unacceptable after review, disable via:
 *   1. SET fuzzyEntityResolution=false in admin config thresholds.
 *   2. Run the DOWN migration to drop the column.
 *
 * Schema:
 *   - Nullable text column (not every row needs a block key; RFC/CURP rows skip it).
 *   - Indexed on (consignee_name_block_key, period) for cross-manifest look-ups.
 *   - Does NOT replace the unique constraint on (consignee_name_norm, period, manifest_id).
 *
 * Down: reversible — drops the index and column.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('monthly_history', {
    consignee_name_block_key: {
      type: 'text',
      comment: 'F14: phonetic blocking key for fuzzy name clustering (ID-less consignees only). ' +
               'PRIVACY: lossy name-derived value, less identifying than plaintext but more than HMAC. ' +
               'See migration comment for trade-off discussion.',
    },
  });
  pgm.createIndex('monthly_history', ['consignee_name_block_key', 'period'], {
    name: 'monthly_history_block_key_period_idx',
    where: 'consignee_name_block_key IS NOT NULL',
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex('monthly_history', ['consignee_name_block_key', 'period'], {
    name: 'monthly_history_block_key_period_idx',
  });
  pgm.dropColumn('monthly_history', 'consignee_name_block_key');
}
