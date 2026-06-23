import { query } from '../db/pool';
import { norm } from '../../../shared/risk/signals';

export async function recordNames(names: string[], period: string, manifestId: string): Promise<void> {
  for (const raw of names) {
    const n = norm(raw);
    if (!n) continue;
    await query(
      `INSERT INTO monthly_history (consignee_name_norm, period, manifest_id, seen_count)
       VALUES ($1,$2,$3,1)
       ON CONFLICT (consignee_name_norm, period, manifest_id)
       DO UPDATE SET seen_count = monthly_history.seen_count + 1`,
      [n, period, manifestId],
    );
  }
}

export async function deleteManifestHistory(manifestId: string): Promise<void> {
  await query(`DELETE FROM monthly_history WHERE manifest_id=$1`, [manifestId]);
}

/**
 * Sum of prior monthly operations per consignee for the period, grouped by
 * normalized name. When `excludeManifestId` is given, the current manifest's own
 * rows are excluded (so it is counted once, via `nameCounts`, during scoring).
 * Drives the `bbdd` signal's Ficha 124 ">3 ops/consignee/month" trigger.
 */
export async function loadHistoryCounts(period: string, excludeManifestId?: string): Promise<Record<string, number>> {
  const { rows } = excludeManifestId
    ? await query<{ consignee_name_norm: string; total: string }>(
        `SELECT consignee_name_norm, SUM(seen_count) AS total FROM monthly_history
         WHERE period=$1 AND (manifest_id IS NULL OR manifest_id <> $2)
         GROUP BY consignee_name_norm`,
        [period, excludeManifestId])
    : await query<{ consignee_name_norm: string; total: string }>(
        `SELECT consignee_name_norm, SUM(seen_count) AS total FROM monthly_history
         WHERE period=$1 GROUP BY consignee_name_norm`, [period]);
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.consignee_name_norm] = Number(r.total);
  return counts;
}
