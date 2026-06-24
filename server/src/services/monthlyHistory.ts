import { query } from '../db/pool';
import { norm } from '../../../shared/risk/normalize';
import { rawBlindIndex } from '../crypto/blindIndex';
import { blockingKey } from '../../../shared/risk/nameMatch';
import { cleanId } from '../../../shared/parsing/taxId';

/**
 * Record consignee names for a given period and manifest into monthly_history.
 *
 * F20c: also writes consignee_name_bidx = rawBlindIndex(norm(name)) so that
 * loadHistoryCounts can return token-keyed counts without re-tokenizing plaintext.
 *
 * F14: also writes consignee_name_block_key = blockingKey(name) for ID-less consignees.
 * The block_key enables cross-manifest fuzzy clustering (typo variants across submissions).
 *
 * PRIVACY TRADE-OFF (F14): consignee_name_block_key is a lossy name-derived value —
 * less identifying than plaintext, more exposed than the HMAC blind-index. It is only
 * populated for rows where the consignee has NO valid RFC/CURP. Rows with a valid RFC/CURP
 * leave the block_key NULL (their identity is authoritative via the bidx/RFC key).
 *
 * Normalization is IDENTICAL to the token the engine produces:
 *   rawBlindIndex(norm(rawName)) — same as nameTokenFn(norm(rawName)) in classify.ts.
 *
 * The unique constraint remains on (consignee_name_norm, period, manifest_id) during
 * the F20c transition; consignee_name_bidx is NOT NULL only for new/updated rows.
 */
export async function recordNames(
  names: string[],
  period: string,
  manifestId: string,
  /**
   * F14: optional RFC/CURP map. When provided, block_key is NOT written for names
   * that have a valid RFC/CURP (they are identity-keyed via bidx, not fuzzy-keyed).
   * If absent, block_key is written for all names (conservative — may over-populate).
   */
  rfcMap?: Record<string, string>,
): Promise<void> {
  for (const raw of names) {
    const n = norm(raw);
    if (!n) continue;
    const bidx = rawBlindIndex(n);
    // F14: compute block_key only for ID-less consignees.
    // The rfcMap key is the norm'd name; value is the clean RFC/CURP.
    const hasId = rfcMap ? !!cleanId(rfcMap[n] ?? '') : false;
    const bkey = hasId ? null : blockingKey(raw);
    await query(
      `INSERT INTO monthly_history
         (consignee_name_norm, consignee_name_bidx, consignee_name_block_key, period, manifest_id, seen_count)
       VALUES ($1,$2,$3,$4,$5,1)
       ON CONFLICT (consignee_name_norm, period, manifest_id)
       DO UPDATE SET seen_count = monthly_history.seen_count + 1,
                    consignee_name_bidx = EXCLUDED.consignee_name_bidx,
                    consignee_name_block_key = EXCLUDED.consignee_name_block_key`,
      [n, bidx, bkey, period, manifestId],
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
 * F14: cross-manifest block-key clustering is handled in classify.ts PASS-1 via the
 * nameCanonical() function, which clusters the current manifest names + DB block-keys
 * in-memory. The DB rows returned here include block_key when present so that
 * classify.ts can include DB block-keys in the in-memory cluster map.
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

/**
 * F14: load DB block-keys for the period to enable cross-manifest fuzzy clustering
 * in classify.ts. Returns array of {blockKey, bidx} for ID-less consignees that have
 * a non-null consignee_name_block_key in monthly_history.
 *
 * classify.ts (server-side wrapper) can use this to feed DB block-keys into
 * resolveNameClusters alongside current-manifest names, so that cross-manifest typos
 * collapse to the same canonical and the bbdd count merges correctly.
 *
 * Note: This is an ADDITIVE extension. Callers that do not use cross-manifest fuzzy
 * can ignore this function (falls back to plain loadHistoryCounts behavior).
 */
export async function loadHistoryBlockKeys(
  period: string,
  excludeManifestId?: string,
): Promise<Array<{ blockKey: string; token: string }>> {
  const { rows } = excludeManifestId
    ? await query<{ block_key: string; bidx: string | null; norm_key: string }>(
        `SELECT consignee_name_block_key AS block_key,
                consignee_name_bidx AS bidx,
                consignee_name_norm AS norm_key
         FROM monthly_history
         WHERE period=$1
           AND consignee_name_block_key IS NOT NULL
           AND (manifest_id IS NULL OR manifest_id <> $2)
         GROUP BY consignee_name_block_key, consignee_name_bidx, consignee_name_norm`,
        [period, excludeManifestId])
    : await query<{ block_key: string; bidx: string | null; norm_key: string }>(
        `SELECT consignee_name_block_key AS block_key,
                consignee_name_bidx AS bidx,
                consignee_name_norm AS norm_key
         FROM monthly_history
         WHERE period=$1
           AND consignee_name_block_key IS NOT NULL
         GROUP BY consignee_name_block_key, consignee_name_bidx, consignee_name_norm`,
        [period]);

  return rows.map((r) => ({
    blockKey: r.block_key,
    token: r.bidx ?? rawBlindIndex(r.norm_key),
  }));
}
