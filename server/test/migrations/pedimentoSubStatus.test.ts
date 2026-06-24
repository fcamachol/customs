import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

async function mkManifest(): Promise<string> {
  const u = await query(`INSERT INTO users (username, password_hash, role) VALUES ('u1','x','admin') RETURNING id`);
  const m = await query(`INSERT INTO manifests (mawb_reference, client_name, created_by) VALUES ('1','C',$1) RETURNING id`, [u.rows[0].id]);
  return m.rows[0].id;
}

describe('1700003000000 sub_status backfill', () => {
  beforeEach(truncateAll);

  it('defaults to pendiente on a plain insert', async () => {
    const mid = await mkManifest();
    const res = await query(
      `INSERT INTO pedimentos (manifest_id, numero_pedimento, created_by)
       VALUES ($1, 'X', (SELECT id FROM users WHERE username='u1'))
       RETURNING sub_status`,
      [mid],
    );
    expect(res.rows[0].sub_status).toBe('pendiente');
  });

  it('derives capturado from the backfill CASE when import_data is set', async () => {
    const mid = await mkManifest();
    const userId = (await query(`SELECT id FROM users WHERE username='u1'`)).rows[0].id;
    // Insert a row with import_data set (sub_status starts as 'pendiente' due to column default)
    const ped = await query(
      `INSERT INTO pedimentos (manifest_id, import_data, created_by)
       VALUES ($1, $2::jsonb, $3) RETURNING id`,
      [mid, JSON.stringify({ patente: '3250' }), userId],
    );
    // Run the backfill CASE SQL inline on just this row
    await query(
      `UPDATE pedimentos SET sub_status = CASE
         WHEN prevalidation->>'status' = 'APPROVED' THEN 'prevalidado'
         WHEN import_data IS NOT NULL THEN 'capturado'
         ELSE 'pendiente' END
       WHERE id = $1`,
      [ped.rows[0].id],
    );
    const res = await query(`SELECT sub_status FROM pedimentos WHERE id=$1`, [ped.rows[0].id]);
    expect(res.rows[0].sub_status).toBe('capturado');
  });

  it('derives prevalidado from the backfill CASE when prevalidation status is APPROVED', async () => {
    const mid = await mkManifest();
    const userId = (await query(`SELECT id FROM users WHERE username='u1'`)).rows[0].id;
    const ped = await query(
      `INSERT INTO pedimentos (manifest_id, prevalidation, created_by)
       VALUES ($1, $2::jsonb, $3) RETURNING id`,
      [mid, JSON.stringify({ status: 'APPROVED', errors: [] }), userId],
    );
    await query(
      `UPDATE pedimentos SET sub_status = CASE
         WHEN prevalidation->>'status' = 'APPROVED' THEN 'prevalidado'
         WHEN import_data IS NOT NULL THEN 'capturado'
         ELSE 'pendiente' END
       WHERE id = $1`,
      [ped.rows[0].id],
    );
    const res = await query(`SELECT sub_status FROM pedimentos WHERE id=$1`, [ped.rows[0].id]);
    expect(res.rows[0].sub_status).toBe('prevalidado');
  });
});
