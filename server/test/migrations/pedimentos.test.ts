import { beforeEach, describe, expect, it } from 'vitest';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

describe('pedimentos table + backfill', () => {
  beforeEach(async () => { await truncateAll(); });

  it('pedimentos rows carry import_data and master_guide', async () => {
    // Task 11: manifests.import_data was dropped; data lives on pedimentos.
    const u = await query(`INSERT INTO users (username,password_hash,role) VALUES ('c','x','capturista') RETURNING id`);
    const m = await query(
      `INSERT INTO manifests (mawb_reference, client_name, created_by) VALUES ('369-1','C',$1) RETURNING id`,
      [u.rows[0].id]);
    await query(
      `INSERT INTO pedimentos (manifest_id, master_guide, import_data, created_by)
       VALUES ($1, $2, $3::jsonb, $4)`,
      [m.rows[0].id, '369-1', JSON.stringify({ patente: '1653' }), u.rows[0].id]);
    const p = await query(`SELECT manifest_id, master_guide, import_data FROM pedimentos WHERE manifest_id=$1`, [m.rows[0].id]);
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0].master_guide).toBe('369-1');
    expect(p.rows[0].import_data.patente).toBe('1653');
  });
});
