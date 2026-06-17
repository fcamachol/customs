import { query } from '../db/pool';
import { norm } from '../../../shared/risk/signals';

export async function recordNames(names: string[], period: string): Promise<void> {
  for (const raw of names) {
    const n = norm(raw);
    if (!n) continue;
    await query(
      `INSERT INTO monthly_history (consignee_name_norm, period, seen_count)
       VALUES ($1,$2,1)
       ON CONFLICT (consignee_name_norm, period)
       DO UPDATE SET seen_count = monthly_history.seen_count + 1`,
      [n, period],
    );
  }
}

export async function loadHistoryNames(period: string): Promise<Set<string>> {
  const { rows } = await query<{ consignee_name_norm: string }>(
    `SELECT consignee_name_norm FROM monthly_history WHERE period=$1`, [period]);
  return new Set(rows.map((r) => r.consignee_name_norm));
}
