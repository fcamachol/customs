import { beforeEach, describe, expect, it } from 'vitest';
import { recordNames, loadHistoryNames, deleteManifestHistory } from '../../src/services/monthlyHistory';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

async function newManifest(): Promise<string> {
  const m = await query(`INSERT INTO manifests (mawb_reference) VALUES ('369-1') RETURNING id`);
  return m.rows[0].id as string;
}

describe('monthlyHistory', () => {
  beforeEach(truncateAll);

  it('records names and loads prior-period names as a set', async () => {
    const m1 = await newManifest();
    const m2 = await newManifest();
    await recordNames(['Ana Lopez', 'Beto Ruiz'], '2025-01', m1);
    await recordNames(['Ana Lopez'], '2025-02', m2);
    const jan = await loadHistoryNames('2025-01');
    expect(jan.has('ana lopez')).toBe(true);
    expect(jan.has('beto ruiz')).toBe(true);
  });

  it('excludes a manifest\'s own names and is idempotent across re-runs', async () => {
    const other = await newManifest();
    const mine = await newManifest();
    // Prior history from a different manifest in the same period.
    await recordNames(['Carlos Diaz'], '2025-03', other);

    const cycle = async () => {
      await deleteManifestHistory(mine);
      const history = await loadHistoryNames('2025-03', mine);
      await recordNames(['Ana Lopez', 'Carlos Diaz'], '2025-03', mine);
      return history;
    };

    const first = await cycle();
    const second = await cycle();

    // The manifest's own consignees are excluded; only the other manifest's name is seen.
    expect(first.has('carlos diaz')).toBe(true);
    expect(first.has('ana lopez')).toBe(false);
    // Re-running yields identical membership (no inflation / self-seeding).
    expect([...second].sort()).toEqual([...first].sort());
  });
});
