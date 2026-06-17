import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { hashPassword } from '../../src/auth/password';
import { signToken } from '../../src/auth/token';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

const app = createApp();
let token: string; let manifestId: string;

async function addShipment(name: string, value: number) {
  const s = {
    id: crypto.randomUUID(), mawbReference: '369-1', description: 'camisa', hsCode: '9901000100',
    quantity: 1, unit: 'PCE', customsValueUsd: value, currency: 'USD', originCountry: 'CN', guideId: 'g',
    consignee: { name, rfc: 'PERJ800101AAA', address: 'Calle 1' }, sender: { name: 'S' }, platform: { commercialName: 'P' },
  };
  await query('INSERT INTO shipments (id, manifest_id, data) VALUES ($1,$2,$3)', [s.id, manifestId, JSON.stringify(s)]);
}

beforeEach(async () => {
  await truncateAll();
  const hash = await hashPassword('p');
  const u = await query(`INSERT INTO users (username,password_hash,role) VALUES ('c',$1,'capturista') RETURNING id`, [hash]);
  token = signToken({ userId: u.rows[0].id, role: 'capturista' });
  const m = await query(`INSERT INTO manifests (mawb_reference) VALUES ('369-1') RETURNING id`);
  manifestId = m.rows[0].id;
});

describe('POST /api/manifests/:id/risk', () => {
  it('scores shipments, persists color, returns table + summary', async () => {
    await addShipment('Ana', 100);
    await addShipment('Bad', 5000);
    const res = await request(app)
      .post(`/api/manifests/${manifestId}/risk`)
      .set('Authorization', `Bearer ${token}`)
      .send({ period: '2025-02' });
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(2);
    expect(res.body.summary.analizados).toBe(2);
    const persisted = await query('SELECT risk_color FROM shipments WHERE risk_color IS NOT NULL');
    expect(persisted.rows.length).toBe(2);
  });
});
