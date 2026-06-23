import { beforeEach, describe, expect, it } from 'vitest';
import { recordNames, loadHistoryCounts, deleteManifestHistory } from '../../src/services/monthlyHistory';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

async function newManifest(): Promise<string> {
  const m = await query(`INSERT INTO manifests (mawb_reference) VALUES ('369-1') RETURNING id`);
  return m.rows[0].id as string;
}

describe('monthlyHistory', () => {
  beforeEach(truncateAll);

  it('records names and loads prior-period counts grouped by name', async () => {
    const m1 = await newManifest();
    const m2 = await newManifest();
    // 'Ana Lopez' appears twice in m1 → seen_count accumulates to 2.
    await recordNames(['Ana Lopez', 'Ana Lopez', 'Beto Ruiz'], '2025-01', m1);
    await recordNames(['Ana Lopez'], '2025-02', m2);
    const jan = await loadHistoryCounts('2025-01');
    expect(jan['ana lopez']).toBe(2);
    expect(jan['beto ruiz']).toBe(1);
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
    expect(first['carlos diaz']).toBe(3);
    expect(first['ana lopez']).toBeUndefined();
    // Re-running yields identical counts (no inflation / self-seeding).
    expect(second).toEqual(first);
  });
});
