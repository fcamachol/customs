import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { hashPassword } from '../../src/auth/password';
import { signToken } from '../../src/auth/token';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

const app = createApp();
let token: string; let manifestId: string;

async function addShipment(name: string, value: number, guideId = name) {
  const s = {
    id: crypto.randomUUID(), mawbReference: '369-1', description: 'camisa', hsCode: '9901000100',
    quantity: 1, unit: 'PCE', customsValueUsd: value, currency: 'USD', originCountry: 'CN', guideId,
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

  it('summary exposes 3-bucket PRD shape: analizados, aprobados, noIdentificados, validarEnPrevio', async () => {
    await addShipment('Verde', 100, 'g-verde');
    const res = await request(app)
      .post(`/api/manifests/${manifestId}/risk`)
      .set('Authorization', `Bearer ${token}`)
      .send({ period: '2025-02' });
    expect(res.status).toBe(200);
    const s = res.body.summary;
    expect(s).toHaveProperty('analizados');
    expect(s).toHaveProperty('aprobados');
    expect(s).toHaveProperty('noIdentificados');
    expect(s).toHaveProperty('validarEnPrevio');
    expect(s).not.toHaveProperty('rojos');
  });

  it('persists ruleset_version on the manifest', async () => {
    await addShipment('Ana', 100);
    await request(app)
      .post(`/api/manifests/${manifestId}/risk`)
      .set('Authorization', `Bearer ${token}`)
      .send({ period: '2025-02' });
    const { rows } = await query<{ ruleset_version: string }>(
      'SELECT ruleset_version FROM manifests WHERE id=$1', [manifestId]);
    expect(rows[0].ruleset_version).toBe('2026-06');
  });
});
