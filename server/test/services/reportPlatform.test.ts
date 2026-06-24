import { beforeEach, describe, expect, it } from 'vitest';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';
import { buildReportRowsForManifest, loadShipments } from '../../src/services/reportData';

beforeEach(truncateAll);

async function seedManifestWithShipment(): Promise<{ manifestId: string; clientId: string }> {
  const u = await query(`INSERT INTO users (username,password_hash,role) VALUES ('a','x','admin') RETURNING id`);
  const c = await query(`INSERT INTO clients (name) VALUES ('ACME') RETURNING id`);
  const m = await query(`INSERT INTO manifests (mawb_reference, client_id, created_by) VALUES ('369-1',$1,$2) RETURNING id`,
    [c.rows[0].id, u.rows[0].id]);
  const s = { id: crypto.randomUUID(), mawbReference: '369-1', description: 'X', hsCode: '99010001',
    quantity: 1, unit: '6', customsValueUsd: 10, currency: 'USD', originCountry: 'CN', guideId: 'g1',
    consignee: { name: 'Juan' }, sender: { name: 'S' }, platform: { commercialName: 'shipP' } };
  await query('INSERT INTO shipments (id,manifest_id,data) VALUES ($1,$2,$3)',
    [s.id, m.rows[0].id, JSON.stringify(s)]);
  return { manifestId: m.rows[0].id, clientId: c.rows[0].id };
}

describe('report platform overlay', () => {
  it('overlays the selected platform into the Plataforma columns', async () => {
    const { manifestId, clientId } = await seedManifestWithShipment();
    const p = await query(
      `INSERT INTO client_platforms (client_id, commercial_name, country_of_origin, url) VALUES ($1,'Tienda','CN','https://tienda.com') RETURNING id`,
      [clientId]);
    await query('UPDATE manifests SET platform_id=$1 WHERE id=$2', [p.rows[0].id, manifestId]);

    const loaded = await loadShipments(manifestId);
    const rows = await buildReportRowsForManifest(manifestId, loaded);
    expect(rows[0]['Plataforma Nombre comercial']).toBe('Tienda');
    // country_of_origin is stored as the ANAM clave ('CN') but rendered as the display name.
    expect(rows[0]['Plataforma País de origen']).toBe('China');
    expect(rows[0]['Plataforma URL']).toBe('https://tienda.com');
  });

  it('leaves the Plataforma block blank when no platform is selected', async () => {
    const { manifestId } = await seedManifestWithShipment();
    const loaded = await loadShipments(manifestId);
    const rows = await buildReportRowsForManifest(manifestId, loaded);
    expect(rows[0]['Plataforma Nombre comercial'] ?? '').toBe('');
  });
});
