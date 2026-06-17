import { beforeEach, describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import request from 'supertest';
import { createApp } from '../../src/app';
import { hashPassword } from '../../src/auth/password';
import { signToken } from '../../src/auth/token';
import { saveFile } from '../../src/storage/files';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

const app = createApp();
let token: string;

beforeEach(async () => {
  await truncateAll();
  const hash = await hashPassword('p');
  const u = await query(`INSERT INTO users (username,password_hash,role) VALUES ('c',$1,'capturista') RETURNING id`, [hash]);
  token = signToken({ userId: u.rows[0].id, role: 'capturista' });
});

describe('GET /api/files/:id', () => {
  it('streams the stored file bytes for a valid id', async () => {
    const buf = Buffer.from('downloadable content');
    const meta = await saveFile({ kind: 'pedimento_pdf', originalName: 'p.pdf', bytes: buf, uploadedBy: null });
    const res = await request(app)
      .get(`/api/files/${meta.id}`)
      .set('Authorization', `Bearer ${token}`)
      .buffer()
      .parse((r, cb) => {
        const chunks: Buffer[] = []; r.on('data', (c) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(Buffer.from(res.body).toString()).toBe('downloadable content');
  });

  it('returns 404 for an unknown id', async () => {
    const res = await request(app)
      .get('/api/files/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});
