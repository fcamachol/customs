import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { hashPassword } from '../../src/auth/password';
import { signToken } from '../../src/auth/token';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

const app = createApp();

async function seedAdmin() {
  const hash = await hashPassword('adminpass');
  const { rows } = await query(
    `INSERT INTO users (username, password_hash, role) VALUES ('admin', $1, 'admin') RETURNING id, token_version`,
    [hash],
  );
  const user = rows[0] as { id: string; token_version: number };
  return {
    id: user.id,
    token: signToken({ userId: user.id, role: 'admin', tv: user.token_version }),
  };
}

describe('POST /api/users', () => {
  let adminToken: string;

  beforeEach(async () => {
    await truncateAll();
    const admin = await seedAdmin();
    adminToken = admin.token;
  });

  it('creates a user with valid role → 201', async () => {
    const res = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ username: 'newuser', password: 'pass123', role: 'capturista' });
    expect(res.status).toBe(201);
    expect(res.body.username).toBe('newuser');
    expect(res.body.role).toBe('capturista');
  });

  it('rejects invalid role → 400 with validation details', async () => {
    const res = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ username: 'bad', password: 'pass', role: 'superuser' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
    expect(res.body.details).toBeDefined();
  });

  it('rejects missing username → 400', async () => {
    const res = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ password: 'pass', role: 'capturista' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
  });

  it('requires auth → 401', async () => {
    const res = await request(app)
      .post('/api/users')
      .send({ username: 'x', password: 'p', role: 'capturista' });
    expect(res.status).toBe(401);
  });
});

describe('PATCH /api/users/:id/role', () => {
  let adminToken: string;
  let adminId: string;

  beforeEach(async () => {
    await truncateAll();
    const admin = await seedAdmin();
    adminToken = admin.token;
    adminId = admin.id;
  });

  it('updates role with valid value → 200', async () => {
    const res = await request(app)
      .patch(`/api/users/${adminId}/role`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: 'capturista' });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('capturista');
  });

  it('rejects invalid role → 400 with validation details', async () => {
    const res = await request(app)
      .patch(`/api/users/${adminId}/role`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: 'badRole' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
    expect(res.body.details).toBeDefined();
  });
});
