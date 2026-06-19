import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { hashPassword } from '../../src/auth/password';
import { signToken } from '../../src/auth/token';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

const app = createApp();

let autoridadToken: string;
let capturistaAToken: string;
let capturistaBToken: string;
let manifestId: string;

beforeEach(async () => {
  await truncateAll();
  const hash = await hashPassword('p');

  const [autoridad, capA, capB] = await Promise.all([
    query(`INSERT INTO users (username,password_hash,role) VALUES ('autoridad1',$1,'autoridad') RETURNING id`, [hash]),
    query(`INSERT INTO users (username,password_hash,role) VALUES ('capA',$1,'capturista') RETURNING id`, [hash]),
    query(`INSERT INTO users (username,password_hash,role) VALUES ('capB',$1,'capturista') RETURNING id`, [hash]),
  ]);

  autoridadToken = signToken({ userId: autoridad.rows[0].id, role: 'autoridad' });
  capturistaAToken = signToken({ userId: capA.rows[0].id, role: 'capturista' });
  capturistaBToken = signToken({ userId: capB.rows[0].id, role: 'capturista' });

  // Create a manifest owned by capturista A
  const m = await query(
    `INSERT INTO manifests (mawb_reference, client_name, created_by) VALUES ('TEST-999','Cliente Test',$1) RETURNING id`,
    [capA.rows[0].id],
  );
  manifestId = m.rows[0].id;
});

// RF-22: autoridad is read-only — mutating routes must return 403
describe('RF-22: autoridad write routes → 403', () => {
  it('POST /api/manifests returns 403 for autoridad', async () => {
    const res = await request(app)
      .post('/api/manifests')
      .set('Authorization', `Bearer ${autoridadToken}`)
      .send({ mawbReference: '000-1', rows: [] });
    expect(res.status).toBe(403);
  });

  it('POST /api/manifests/:id/pedimento-pdf returns 403 for autoridad', async () => {
    const res = await request(app)
      .post(`/api/manifests/${manifestId}/pedimento-pdf`)
      .set('Authorization', `Bearer ${autoridadToken}`)
      .attach('file', Buffer.from('dummy'), 'test.pdf');
    expect(res.status).toBe(403);
  });

  it('POST /api/manifests/:id/risk returns 403 for autoridad', async () => {
    const res = await request(app)
      .post(`/api/manifests/${manifestId}/risk`)
      .set('Authorization', `Bearer ${autoridadToken}`);
    expect(res.status).toBe(403);
  });
});

// PRD shared visibility: all capturistas can read each other's records
describe('PRD shared visibility: capturista B can see capturista A records', () => {
  it('GET /api/records/:id returns 200 for a record created by a different capturista', async () => {
    // manifestId was created by capturista A — capturista B should be able to read it
    const res = await request(app)
      .get(`/api/records/${manifestId}`)
      .set('Authorization', `Bearer ${capturistaBToken}`);
    expect(res.status).toBe(200);
    expect(res.body.mawbReference).toBe('TEST-999');
  });

  it('GET /api/records (list) shows records from other capturistas', async () => {
    const res = await request(app)
      .get('/api/records?q=TEST-999')
      .set('Authorization', `Bearer ${capturistaBToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].mawbReference).toBe('TEST-999');
  });
});
