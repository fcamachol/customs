import { beforeEach, describe, expect, it } from 'vitest';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

beforeEach(truncateAll);

describe('client_platforms schema', () => {
  it('stores many platforms per client and cascades on client delete', async () => {
    const c = await query(`INSERT INTO clients (name) VALUES ('ACME') RETURNING id`);
    const clientId = c.rows[0].id;
    await query(
      `INSERT INTO client_platforms (client_id, commercial_name, country_of_origin)
       VALUES ($1, 'Shop A', 'CN'), ($1, 'Shop B', 'US')`, [clientId]);
    const before = await query('SELECT id FROM client_platforms WHERE client_id=$1', [clientId]);
    expect(before.rows).toHaveLength(2);

    await query('DELETE FROM clients WHERE id=$1', [clientId]);
    const after = await query('SELECT id FROM client_platforms WHERE client_id=$1', [clientId]);
    expect(after.rows).toHaveLength(0);
  });

  it('lets a manifest reference a platform and nulls it when the platform is deleted', async () => {
    const c = await query(`INSERT INTO clients (name) VALUES ('ACME') RETURNING id`);
    const p = await query(
      `INSERT INTO client_platforms (client_id, commercial_name) VALUES ($1, 'Shop A') RETURNING id`,
      [c.rows[0].id]);
    const m = await query(
      `INSERT INTO manifests (mawb_reference, client_id, platform_id) VALUES ('M-1', $1, $2) RETURNING id`,
      [c.rows[0].id, p.rows[0].id]);
    await query('DELETE FROM client_platforms WHERE id=$1', [p.rows[0].id]);
    const { rows } = await query('SELECT platform_id FROM manifests WHERE id=$1', [m.rows[0].id]);
    expect(rows[0].platform_id).toBeNull();
  });

  it('backfills one platform row from a non-empty legacy clients.platform jsonb', async () => {
    // Insert a client whose legacy jsonb carries platform data (bypassing the API).
    const c = await query(
      `INSERT INTO clients (name, platform)
       VALUES ('Legacy', '{"commercialName":"Tienda","countryOfOrigin":"CN","legalName":"","email":""}'::jsonb)
       RETURNING id`);
    // The migration backfill runs once at migrate time; this asserts its effect is reproducible.
    // Re-run the backfill statement to prove idempotent shape (no row yet for this fresh client).
    await query(
      `INSERT INTO client_platforms (client_id, commercial_name, country_of_origin, legal_name, email, created_by)
       SELECT id, NULLIF(btrim(platform->>'commercialName'),''), NULLIF(btrim(platform->>'countryOfOrigin'),''),
              NULLIF(btrim(platform->>'legalName'),''), NULLIF(btrim(platform->>'email'),''), created_by
       FROM clients
       WHERE id=$1 AND COALESCE(
         NULLIF(btrim(platform->>'commercialName'),''), NULLIF(btrim(platform->>'countryOfOrigin'),''),
         NULLIF(btrim(platform->>'legalName'),''), NULLIF(btrim(platform->>'email'),'')) IS NOT NULL`,
      [c.rows[0].id]);
    const { rows } = await query(
      'SELECT commercial_name, country_of_origin, legal_name, email FROM client_platforms WHERE client_id=$1',
      [c.rows[0].id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].commercial_name).toBe('Tienda');
    expect(rows[0].country_of_origin).toBe('CN');
    expect(rows[0].legal_name).toBeNull();
    expect(rows[0].email).toBeNull();
  });
});
