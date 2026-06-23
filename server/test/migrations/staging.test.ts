import { beforeEach, describe, expect, it } from 'vitest';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

beforeEach(truncateAll);

describe('manifest staging schema', () => {
  it('persists a staging row and enforces the per-manifest idempotency uniqueness', async () => {
    const m = await query(`INSERT INTO manifests (mawb_reference) VALUES ('M-1') RETURNING id`);
    const manifestId = m.rows[0].id;
    await query(
      `INSERT INTO manifest_staging_rows (manifest_id, row_index, idempotency_key, data, status)
       VALUES ($1, 0, 'k1', '{}'::jsonb, 'valid')`, [manifestId]);
    await expect(
      query(`INSERT INTO manifest_staging_rows (manifest_id, row_index, idempotency_key, data, status)
             VALUES ($1, 1, 'k1', '{}'::jsonb, 'valid')`, [manifestId]),
    ).rejects.toThrow();
    const { rows } = await query(`SELECT ingestion_status FROM manifests WHERE id=$1`, [manifestId]);
    expect(rows[0].ingestion_status).toBe('draft');
  });
});
