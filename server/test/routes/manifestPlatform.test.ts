import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { hashPassword } from '../../src/auth/password';
import { signToken } from '../../src/auth/token';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

const app = createApp();
let token: string; let manifestId: string; let clientId: string; let platformId: string;

beforeEach(async () => {
  await truncateAll();
  const hash = await hashPassword('p');
  const u = await query(`INSERT INTO users (username,password_hash,role) VALUES ('a',$1,'admin') RETURNING id`, [hash]);
  token = signToken({ userId: u.rows[0].id, role: 'admin', tv: 0 });
  const m = await query(`INSERT INTO manifests (mawb_reference, created_by) VALUES ('M-1', $1) RETURNING id`, [u.rows[0].id]);
  manifestId = m.rows[0].id;
  const c = await query(`INSERT INTO clients (name) VALUES ('ACME') RETURNING id`);
  clientId = c.rows[0].id;
  const p = await query(`INSERT INTO client_platforms (client_id, commercial_name) VALUES ($1,'Shop A') RETURNING id`, [clientId]);
  platformId = p.rows[0].id;
});

describe('manifest client+platform bind', () => {
  it('binds client and platform together', async () => {
    const res = await request(app).post(`/api/manifests/${manifestId}/client`)
      .set('Authorization', `Bearer ${token}`).send({ clientId, platformId });
    expect(res.status).toBe(200);
    const { rows } = await query('SELECT client_id, platform_id FROM manifests WHERE id=$1', [manifestId]);
    expect(rows[0].client_id).toBe(clientId);
    expect(rows[0].platform_id).toBe(platformId);
  });

  it('rejects a platform that does not belong to the client', async () => {
    const other = await query(`INSERT INTO clients (name) VALUES ('Other') RETURNING id`);
    const otherP = await query(`INSERT INTO client_platforms (client_id, commercial_name) VALUES ($1,'X') RETURNING id`, [other.rows[0].id]);
    const res = await request(app).post(`/api/manifests/${manifestId}/client`)
      .set('Authorization', `Bearer ${token}`).send({ clientId, platformId: otherP.rows[0].id });
    expect(res.status).toBe(400);
  });

  it('allows binding a client without a platform', async () => {
    const res = await request(app).post(`/api/manifests/${manifestId}/client`)
      .set('Authorization', `Bearer ${token}`).send({ clientId });
    expect(res.status).toBe(200);
    const { rows } = await query('SELECT platform_id FROM manifests WHERE id=$1', [manifestId]);
    expect(rows[0].platform_id).toBeNull();
  });
});
