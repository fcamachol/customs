import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { hashPassword } from '../../src/auth/password';
import { signToken } from '../../src/auth/token';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

const app = createApp();
let token: string;

beforeEach(async () => {
  await truncateAll();
  const hash = await hashPassword('p');
  const { rows } = await query(`INSERT INTO users (username,password_hash,role) VALUES ('cap',$1,'capturista') RETURNING id`, [hash]);
  token = signToken({ userId: rows[0].id, role: 'capturista' });
});

describe('POST /api/manifests', () => {
  it('parses rows, persists shipments, and returns unmapped headers', async () => {
    const res = await request(app)
      .post('/api/manifests')
      .set('Authorization', `Bearer ${token}`)
      .send({
        mawbReference: '369-1',
        clientName: 'Cliente A',
        rows: [{ 'RFC': 'AAA010101AAA', 'Descripción de la mercancía': 'TRAJE', 'Columna Rara': 'x' }],
      });
    expect(res.status).toBe(201);
    expect(res.body.shipmentCount).toBe(1);
    expect(res.body.unmappedHeaders).toContain('Columna Rara');
    const { rows } = await query('SELECT count(*)::int AS n FROM shipments');
    expect(rows[0].n).toBe(1);
  });
});
