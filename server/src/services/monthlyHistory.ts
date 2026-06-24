import { query } from '../db/pool';
import { norm } from '../../../shared/risk/normalize';
import { rawBlindIndex } from '../crypto/blindIndex';

/**
 * Record consignee names for a given period and manifest into monthly_history.
 *
 * F20c: also writes consignee_name_bidx = rawBlindIndex(norm(name)) so that
 * loadHistoryCounts can return token-keyed counts without re-tokenizing plaintext.
 *
 * Normalization is IDENTICAL to the token the engine produces:
 *   rawBlindIndex(norm(rawName)) — same as nameTokenFn(norm(rawName)) in classify.ts.
 *
 * The unique constraint remains on (consignee_name_norm, period, manifest_id) during
 * the F20c transition; consignee_name_bidx is NOT NULL only for new/updated rows.
 *
 * NOTE (F14 scope): cross-manifest fuzzy recurrence is a DEFERRED enhancement.
 * In-manifest fuzzy clustering (detect typo variants within a single submission)
 * is fully operational via classify.ts PASS-1 + resolveNameClusters. Cross-manifest
 * fuzzy would require a privacy-reviewed comparable key (the consignee_name_block_key
 * column was removed because it partially re-introduced PII that F20 encrypted).
 */
export async function recordNames(
  names: string[],
  period: string,
  manifestId: string,
): Promise<void> {
  for (const raw of names) {
    const n = norm(raw);
    if (!n) continue;
    const bidx = rawBlindIndex(n);
    await query(
      `INSERT INTO monthly_history
         (consignee_name_norm, consignee_name_bidx, period, manifest_id, seen_count)
       VALUES ($1,$2,$3,$4,1)
       ON CONFLICT (consignee_name_norm, period, manifest_id)
       DO UPDATE SET seen_count = monthly_history.seen_count + 1,
                    consignee_name_bidx = EXCLUDED.consignee_name_bidx`,
      [n, bidx, period, manifestId],
    );
  }
}

export async function deleteManifestHistory(manifestId: string): Promise<void> {
  await query(`DELETE FROM monthly_history WHERE manifest_id=$1`, [manifestId]);
}

/**
 * Sum of prior monthly operations per consignee for the period, grouped by
 * blind-index token. Returns Record<token, count> where:
 *   - token = consignee_name_bidx  (for rows written by F20c or backfilled)
 *   - token = rawBlindIndex(consignee_name_norm)  (COALESCE fallback for legacy rows)
 *
 * This makes the key-space exactly match what the engine produces:
 *   nameTokenFn(norm(name)) = rawBlindIndex(norm(name))
 *
 * When `excludeManifestId` is given, the current manifest's own rows are excluded
 * (so it is counted once via `nameCounts`, during scoring).
 */
export async function loadHistoryCounts(
  period: string,
  excludeManifestId?: string,
): Promise<Record<string, number>> {
  // Resolve the dedup token in JS (SQL cannot call the Node HMAC): query both columns
  // and use consignee_name_bidx when populated (F20c rows), otherwise derive the token
  // from consignee_name_norm via rawBlindIndex (legacy/not-yet-backfilled rows). Both
  // paths yield rawBlindIndex(norm(name)), so counts merge cleanly across the cutover.
  const { rows } = excludeManifestId
    ? await query<{ bidx: string | null; norm_key: string; total: string }>(
        `SELECT consignee_name_bidx AS bidx, consignee_name_norm AS norm_key, SUM(seen_count) AS total
         FROM monthly_history
         WHERE period=$1 AND (manifest_id IS NULL OR manifest_id <> $2)
         GROUP BY consignee_name_bidx, consignee_name_norm`,
        [period, excludeManifestId])
    : await query<{ bidx: string | null; norm_key: string; total: string }>(
        `SELECT consignee_name_bidx AS bidx, consignee_name_norm AS norm_key, SUM(seen_count) AS total
         FROM monthly_history
         WHERE period=$1
         GROUP BY consignee_name_bidx, consignee_name_norm`,
        [period]);

  const counts: Record<string, number> = {};
  for (const r of rows) {
    // Use the stored bidx if present; fall back to computing rawBlindIndex(norm_key)
    const token = r.bidx ?? rawBlindIndex(r.norm_key);
    counts[token] = (counts[token] ?? 0) + Number(r.total);
  }
  return counts;
}
