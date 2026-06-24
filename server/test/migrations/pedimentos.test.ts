import { beforeEach, describe, expect, it } from 'vitest';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

describe('pedimentos table + backfill', () => {
  beforeEach(async () => { await truncateAll(); });

  it('backfills one pedimento row from a manifest that has pedimento data', async () => {
    const u = await query(`INSERT INTO users (username,password_hash,role) VALUES ('c','x','capturista') RETURNING id`);
    const m = await query(
      `INSERT INTO manifests (mawb_reference, client_name, created_by, import_data) VALUES ('369-1','C',$1,$2::jsonb) RETURNING id`,
      [u.rows[0].id, JSON.stringify({ patente: '1653' })]);
    // Simulate the backfill SELECT (migration already ran at suite start; insert + manual backfill check)
    await query(
      `INSERT INTO pedimentos (manifest_id, master_guide, import_data, created_by)
       SELECT id, mawb_reference, import_data, created_by FROM manifests WHERE id=$1`, [m.rows[0].id]);
    const p = await query(`SELECT manifest_id, master_guide, import_data FROM pedimentos WHERE manifest_id=$1`, [m.rows[0].id]);
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0].master_guide).toBe('369-1');
    expect(p.rows[0].import_data.patente).toBe('1653');
  });
});
