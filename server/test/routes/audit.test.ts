import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { hashPassword } from '../../src/auth/password';
import { signToken } from '../../src/auth/token';
import { query } from '../../src/db/pool';
import { recordAudit } from '../../src/services/audit';
import { truncateAll } from '../helpers/db';

const app = createApp();
let capToken: string;
let authToken: string;
let userId: string;

beforeEach(async () => {
  await truncateAll();
  const hash = await hashPassword('p');
  const cap = await query(`INSERT INTO users (username,password_hash,role) VALUES ('cap',$1,'capturista') RETURNING id`, [hash]);
  const aut = await query(`INSERT INTO users (username,password_hash,role) VALUES ('aut',$1,'autoridad') RETURNING id`, [hash]);
  userId = cap.rows[0].id;
  capToken = signToken({ userId, role: 'capturista' });
  authToken = signToken({ userId: aut.rows[0].id, role: 'autoridad' });
});

describe('audit query endpoint', () => {
  it('forbids capturista', async () => {
    const res = await request(app).get('/api/audit').set('Authorization', `Bearer ${capToken}`);
    expect(res.status).toBe(403);
  });

  it('returns rows newest first for autoridad', async () => {
    await recordAudit({ userId, action: 'LOGIN', entity: 'session' });
    await recordAudit({ userId, action: 'EXPORT_RISK', entity: 'manifest', entityId: 'm1' });
    const res = await request(app).get('/api/audit').set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(2);
    expect(res.body[0].action).toBe('EXPORT_RISK');
    expect(res.body[0]).toHaveProperty('userId', userId);
    expect(res.body[0]).toHaveProperty('entityId', 'm1');
    expect(res.body[0]).toHaveProperty('createdAt');
  });

  it('honors the limit param', async () => {
    await recordAudit({ userId, action: 'A', entity: 'x' });
    await recordAudit({ userId, action: 'B', entity: 'x' });
    await recordAudit({ userId, action: 'C', entity: 'x' });
    const res = await request(app).get('/api/audit?limit=2').set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(2);
  });

  it('filters by action (exact)', async () => {
    await recordAudit({ userId, action: 'LOGIN', entity: 'session' });
    await recordAudit({ userId, action: 'EXPORT_RISK', entity: 'manifest', entityId: 'm1' });
    const res = await request(app).get('/api/audit?action=LOGIN').set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].action).toBe('LOGIN');
  });
});
