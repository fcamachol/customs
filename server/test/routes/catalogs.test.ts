import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { hashPassword } from '../../src/auth/password';
import { signToken } from '../../src/auth/token';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

const app = createApp();
let adminToken: string;
let capturistaToken: string;
let autoridadToken: string;

beforeEach(async () => {
  await truncateAll();
  const hash = await hashPassword('p');
  const { rows: adminRows } = await query(
    `INSERT INTO users (username, password_hash, role) VALUES ('admin1', $1, 'admin') RETURNING id`,
    [hash],
  );
  const { rows: capRows } = await query(
    `INSERT INTO users (username, password_hash, role) VALUES ('cap1', $1, 'capturista') RETURNING id`,
    [hash],
  );
  const { rows: autRows } = await query(
    `INSERT INTO users (username, password_hash, role) VALUES ('aut1', $1, 'autoridad') RETURNING id`,
    [hash],
  );
  adminToken = signToken({ userId: adminRows[0].id, role: 'admin' });
  capturistaToken = signToken({ userId: capRows[0].id, role: 'capturista' });
  autoridadToken = signToken({ userId: autRows[0].id, role: 'autoridad' });
});

describe('POST /api/catalogs/clients', () => {
  it('capturista can create a client → 201 and verifies persistence including platform jsonb', async () => {
    const platform = { name: 'DHL', code: 'DHL01' };
    const res = await request(app)
      .post('/api/catalogs/clients')
      .set('Authorization', `Bearer ${capturistaToken}`)
      .send({
        name: 'Acme Corp',
        tax_id: 'ACM010101AAA',
        address: '123 Main St',
        phone: '555-1234',
        email: 'acme@example.com',
        platform,
      });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.name).toBe('Acme Corp');

    // Verify in DB
    const { rows } = await query('SELECT * FROM clients WHERE id = $1', [res.body.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Acme Corp');
    expect(rows[0].tax_id).toBe('ACM010101AAA');
    expect(rows[0].platform).toEqual(platform);
  });

  it('autoridad POST → 403', async () => {
    const res = await request(app)
      .post('/api/catalogs/clients')
      .set('Authorization', `Bearer ${autoridadToken}`)
      .send({ name: 'Bad Actor' });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/catalogs/clients', () => {
  it('lists clients for any authenticated role', async () => {
    // Insert a client directly
    await query(
      `INSERT INTO clients (name, tax_id) VALUES ('Test Client', 'TST010101TST')`,
    );

    const res = await request(app)
      .get('/api/catalogs/clients')
      .set('Authorization', `Bearer ${autoridadToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    expect(res.body[0].name).toBe('Test Client');
  });
});

describe('PUT /api/catalogs/clients/:id', () => {
  it('capturista can update a client and verifies change in DB', async () => {
    // Create a client first
    const { rows } = await query(
      `INSERT INTO clients (name, tax_id) VALUES ('Old Name', 'OLD010101OLD') RETURNING id`,
    );
    const clientId = rows[0].id;

    const res = await request(app)
      .put(`/api/catalogs/clients/${clientId}`)
      .set('Authorization', `Bearer ${capturistaToken}`)
      .send({ name: 'New Name', tax_id: 'NEW010101NEW' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('New Name');

    // Verify in DB
    const { rows: updated } = await query('SELECT * FROM clients WHERE id = $1', [clientId]);
    expect(updated[0].name).toBe('New Name');
    expect(updated[0].tax_id).toBe('NEW010101NEW');
  });

  it('returns 404 for non-existent client', async () => {
    const res = await request(app)
      .put('/api/catalogs/clients/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Ghost' });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/catalogs/clients/:id', () => {
  it('capturista DELETE → 403', async () => {
    const { rows } = await query(
      `INSERT INTO clients (name) VALUES ('ToDelete') RETURNING id`,
    );
    const res = await request(app)
      .delete(`/api/catalogs/clients/${rows[0].id}`)
      .set('Authorization', `Bearer ${capturistaToken}`);
    expect(res.status).toBe(403);
  });

  it('admin DELETE → 200 and row is gone from DB', async () => {
    const { rows } = await query(
      `INSERT INTO clients (name) VALUES ('ToDelete') RETURNING id`,
    );
    const clientId = rows[0].id;

    const res = await request(app)
      .delete(`/api/catalogs/clients/${clientId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);

    // Verify row gone
    const { rows: remaining } = await query('SELECT * FROM clients WHERE id = $1', [clientId]);
    expect(remaining).toHaveLength(0);
  });
});

describe('PUT /api/catalogs/config/:key', () => {
  it('admin can save branding config and it persists', async () => {
    const branding = { logoUrl: 'https://example.com/logo.png', rfc: 'CAP010101CAP', companyName: 'Capital Centennials' };
    const res = await request(app)
      .put('/api/catalogs/config/branding')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ value: branding });
    expect(res.status).toBe(200);
    expect(res.body.key).toBe('branding');

    // Verify in DB
    const { rows } = await query(`SELECT value FROM config WHERE key='branding'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toEqual(branding);
  });

  it('admin can upsert the same key twice', async () => {
    await request(app)
      .put('/api/catalogs/config/prohibited')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ value: ['faro', 'llanta'] });

    const res = await request(app)
      .put('/api/catalogs/config/prohibited')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ value: ['faro', 'llanta', 'freno'] });
    expect(res.status).toBe(200);

    const { rows } = await query(`SELECT value FROM config WHERE key='prohibited'`);
    expect(rows[0].value).toEqual(['faro', 'llanta', 'freno']);
  });

  it('capturista PUT → 403', async () => {
    const res = await request(app)
      .put('/api/catalogs/config/branding')
      .set('Authorization', `Bearer ${capturistaToken}`)
      .send({ value: { companyName: 'Hack Attempt' } });
    expect(res.status).toBe(403);
  });

  it('unknown key → 400', async () => {
    const res = await request(app)
      .put('/api/catalogs/config/unknown_key')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ value: 'x' });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/catalogs/config/:key', () => {
  it('returns null for an unset key', async () => {
    const res = await request(app)
      .get('/api/catalogs/config/branding')
      .set('Authorization', `Bearer ${autoridadToken}`);
    expect(res.status).toBe(200);
    expect(res.body.value).toBeNull();
  });

  it('returns the stored value after PUT', async () => {
    await request(app)
      .put('/api/catalogs/config/piracy_brands')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ value: ['TestBrand'] });

    const res = await request(app)
      .get('/api/catalogs/config/piracy_brands')
      .set('Authorization', `Bearer ${autoridadToken}`);
    expect(res.status).toBe(200);
    expect(res.body.value).toEqual(['TestBrand']);
  });

  it('unknown key → 400', async () => {
    const res = await request(app)
      .get('/api/catalogs/config/bad_key')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });
});
