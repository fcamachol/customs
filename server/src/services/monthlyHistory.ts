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

export async function loadHistoryNames(period: string, excludeManifestId?: string): Promise<Set<string>> {
  const { rows } = excludeManifestId
    ? await query<{ consignee_name_norm: string }>(
        `SELECT consignee_name_norm FROM monthly_history WHERE period=$1 AND (manifest_id IS NULL OR manifest_id <> $2)`,
        [period, excludeManifestId])
    : await query<{ consignee_name_norm: string }>(
        `SELECT consignee_name_norm FROM monthly_history WHERE period=$1`, [period]);
  return new Set(rows.map((r) => r.consignee_name_norm));
}
