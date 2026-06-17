import { beforeEach, describe, expect, it } from 'vitest';
import { recordNames, loadHistoryNames } from '../../src/services/monthlyHistory';
import { truncateAll } from '../helpers/db';

describe('monthlyHistory', () => {
  beforeEach(truncateAll);
  it('records names and loads prior-period names as a set', async () => {
    await recordNames(['Ana Lopez', 'Beto Ruiz'], '2025-01');
    await recordNames(['Ana Lopez'], '2025-02');
    const jan = await loadHistoryNames('2025-01');
    expect(jan.has('ana lopez')).toBe(true);
    expect(jan.has('beto ruiz')).toBe(true);
  });
});
