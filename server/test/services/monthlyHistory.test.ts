import { beforeEach, describe, expect, it } from 'vitest';
import { recordNames, loadHistoryCounts, deleteManifestHistory } from '../../src/services/monthlyHistory';
import { rawBlindIndex } from '../../src/crypto/blindIndex';
import { norm } from '../../../shared/risk/normalize';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

/** Compute the expected token the same way recordNames does: rawBlindIndex(norm(name)) */
const tok = (name: string) => rawBlindIndex(norm(name));

async function newManifest(): Promise<string> {
  const m = await query(`INSERT INTO manifests (mawb_reference) VALUES ('369-1') RETURNING id`);
  return m.rows[0].id as string;
}

describe('monthlyHistory (F20c: token-keyed)', () => {
  beforeEach(truncateAll);

  it('records names and loads prior-period counts keyed by blind-index token', async () => {
    const m1 = await newManifest();
    const m2 = await newManifest();
    // 'Ana Lopez' appears twice in m1 → seen_count accumulates to 2.
    await recordNames(['Ana Lopez', 'Ana Lopez', 'Beto Ruiz'], '2025-01', m1);
    await recordNames(['Ana Lopez'], '2025-02', m2);
    const jan = await loadHistoryCounts('2025-01');
    // Keys are tokens, NOT plaintext norm
    expect(jan[tok('Ana Lopez')]).toBe(2);
    expect(jan[tok('Beto Ruiz')]).toBe(1);
    // Plaintext keys must NOT appear
    expect(jan['ana lopez']).toBeUndefined();
  });

  it('sums counts across manifests, excludes the current one, and is idempotent', async () => {
    const other = await newManifest();
    const mine = await newManifest();
    // Prior history from a different manifest in the same period: Carlos seen 3×.
    await recordNames(['Carlos Diaz', 'Carlos Diaz', 'Carlos Diaz'], '2025-03', other);

    const cycle = async () => {
      await deleteManifestHistory(mine);
      const history = await loadHistoryCounts('2025-03', mine);
      await recordNames(['Ana Lopez', 'Carlos Diaz'], '2025-03', mine);
      return history;
    };

    const first = await cycle();
    const second = await cycle();

    // Only the other manifest's counts are seen; the current manifest is excluded.
    expect(first[tok('Carlos Diaz')]).toBe(3);
    expect(first[tok('Ana Lopez')]).toBeUndefined();
    // Re-running yields identical counts (no inflation / self-seeding).
    expect(second).toEqual(first);
  });

  it('token consistency: norm variants of same name collapse to same token', async () => {
    const m1 = await newManifest();
    // 'Ana López' and 'ANA LOPEZ' normalize to same key → same token
    await recordNames(['Ana López', 'ANA LOPEZ'], '2025-04', m1);
    const counts = await loadHistoryCounts('2025-04');
    // Both map to same token: count should be 2
    expect(counts[tok('Ana Lopez')]).toBe(2);
  });

  it('COALESCE fallback: legacy rows with no bidx column are returned via rawBlindIndex(consignee_name_norm)', async () => {
    // Simulate a pre-backfill row: insert directly with only consignee_name_norm, no bidx
    const m1 = await newManifest();
    await query(
      `INSERT INTO monthly_history (consignee_name_norm, consignee_name_bidx, period, manifest_id, seen_count)
       VALUES ('old client', NULL, '2025-05', $1, 5)`,
      [m1],
    );
    const counts = await loadHistoryCounts('2025-05');
    // Must resolve via COALESCE: token = rawBlindIndex('old client')
    expect(counts[rawBlindIndex('old client')]).toBe(5);
    // Plaintext key must NOT appear
    expect(counts['old client']).toBeUndefined();
  });
});
