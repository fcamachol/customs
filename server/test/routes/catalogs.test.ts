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
let superAdminToken: string;

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
  const { rows: saRows } = await query(
    `INSERT INTO users (username, password_hash, role) VALUES ('sa1', $1, 'super_admin') RETURNING id`,
    [hash],
  );
  adminToken = signToken({ userId: adminRows[0].id, role: 'admin' , tv: 0 });
  capturistaToken = signToken({ userId: capRows[0].id, role: 'capturista' , tv: 0 });
  autoridadToken = signToken({ userId: autRows[0].id, role: 'autoridad' , tv: 0 });
  superAdminToken = signToken({ userId: saRows[0].id, role: 'super_admin', tv: 0 });
});

describe('POST /api/catalogs/clients', () => {
  it('capturista can create a client → 201 and verifies persistence; platform goes to client_platforms', async () => {
    const platform = { commercialName: 'DHL Shop', countryOfOrigin: 'MX' };
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
    expect(res.body.platforms).toHaveLength(1);
    expect(res.body.platforms[0].commercialName).toBe('DHL Shop');

    // Verify in DB — client row exists; platform is in client_platforms (not jsonb)
    const { rows } = await query('SELECT * FROM clients WHERE id = $1', [res.body.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Acme Corp');
    expect(rows[0].tax_id).toBe('ACM010101AAA');
    const { rows: pRows } = await query('SELECT * FROM client_platforms WHERE client_id = $1', [res.body.id]);
    expect(pRows).toHaveLength(1);
    expect(pRows[0].commercial_name).toBe('DHL Shop');
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

describe('PUT /api/catalogs/config/importer_of_record', () => {
  it('super_admin can PUT a valid importer_of_record; non-super_admin is 403; bad shape is 400', async () => {
    const importer = { rfc: 'ADM130509UQ0', name: 'ADMERCE SA DE CV', fiscalAddress: 'PONIENTE 150, CDMX' };
    // non-super_admin (admin) → 403
    const adminRes = await request(app).put('/api/catalogs/config/importer_of_record')
      .set('Authorization', `Bearer ${adminToken}`).send({ value: importer });
    expect(adminRes.status).toBe(403);
    // super_admin valid → 200 and round-trips via GET
    const ok = await request(app).put('/api/catalogs/config/importer_of_record')
      .set('Authorization', `Bearer ${superAdminToken}`).send({ value: importer });
    expect(ok.status).toBe(200);
    const get = await request(app).get('/api/catalogs/config/importer_of_record')
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(get.body.value).toMatchObject(importer);
    // super_admin bad shape (missing fiscalAddress) → 400
    const bad = await request(app).put('/api/catalogs/config/importer_of_record')
      .set('Authorization', `Bearer ${superAdminToken}`).send({ value: { rfc: 'X', name: 'Y' } });
    expect(bad.status).toBe(400);
  });
});

describe('PUT /api/catalogs/config/customs_agent', () => {
  it('customs_agent validates the four-field shape', async () => {
    const agent = { patente: '1653', name: 'MIGUEL ANDRES GUZMAN MORENO', agentRfc: 'GUMM710831UYA', agencyRfc: 'GLG1502247K9' };
    const ok = await request(app).put('/api/catalogs/config/customs_agent')
      .set('Authorization', `Bearer ${superAdminToken}`).send({ value: agent });
    expect(ok.status).toBe(200);
    const bad = await request(app).put('/api/catalogs/config/customs_agent')
      .set('Authorization', `Bearer ${superAdminToken}`).send({ value: { patente: '1653' } });
    expect(bad.status).toBe(400);
  });
});

describe('GET /api/catalogs/agentes-aduanales', () => {
  it('admin and super_admin can list; capturista and autoridad are 403', async () => {
    await query(
      `INSERT INTO agentes_aduanales (patente, name, agent_rfc, agency_rfc, verified)
       VALUES ('1653','GUZMOR','GUMM710831UYA','GLG1502247K9', true)`,
    );
    const admin = await request(app).get('/api/catalogs/agentes-aduanales').set('Authorization', `Bearer ${adminToken}`);
    expect(admin.status).toBe(200);
    expect(admin.body).toHaveLength(1);
    // camelCase contract, no snake_case leakage.
    expect(admin.body[0]).toMatchObject({
      patente: '1653', name: 'GUZMOR', agentRfc: 'GUMM710831UYA', agencyRfc: 'GLG1502247K9', verified: true,
    });
    expect(admin.body[0].id).toBeTruthy();
    expect(admin.body[0].createdAt).toBeTruthy();
    expect(admin.body[0].updatedAt).toBeTruthy();
    expect(admin.body[0].agent_rfc).toBeUndefined();

    const sa = await request(app).get('/api/catalogs/agentes-aduanales').set('Authorization', `Bearer ${superAdminToken}`);
    expect(sa.status).toBe(200);
    const cap = await request(app).get('/api/catalogs/agentes-aduanales').set('Authorization', `Bearer ${capturistaToken}`);
    expect(cap.status).toBe(403);
    const aut = await request(app).get('/api/catalogs/agentes-aduanales').set('Authorization', `Bearer ${autoridadToken}`);
    expect(aut.status).toBe(403);
  });
});

describe('PUT /api/catalogs/agentes-aduanales/:id', () => {
  it('admin can edit fields + verified, writes an audit row', async () => {
    const { rows } = await query(
      `INSERT INTO agentes_aduanales (patente, name, verified) VALUES ('1653','OLD', false) RETURNING id`,
    );
    const id = rows[0].id;
    const res = await request(app)
      .put(`/api/catalogs/agentes-aduanales/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'GESTORES ADUANALES', agentRfc: 'GUMM710831UYA', verified: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'GESTORES ADUANALES', agentRfc: 'GUMM710831UYA', verified: true });

    const db = await query<{ name: string; verified: boolean }>(`SELECT name, verified FROM agentes_aduanales WHERE id=$1`, [id]);
    expect(db.rows[0].name).toBe('GESTORES ADUANALES');
    expect(db.rows[0].verified).toBe(true);

    const audit = await query(`SELECT action FROM audit_log WHERE action='UPDATE_AGENTE_ADUANAL'`);
    expect(audit.rows).toHaveLength(1);
  });

  it('capturista PUT → 403', async () => {
    const { rows } = await query(`INSERT INTO agentes_aduanales (patente) VALUES ('1653') RETURNING id`);
    const res = await request(app)
      .put(`/api/catalogs/agentes-aduanales/${rows[0].id}`)
      .set('Authorization', `Bearer ${capturistaToken}`)
      .send({ verified: true });
    expect(res.status).toBe(403);
  });

  it('returns 404 for a non-existent agente', async () => {
    const res = await request(app)
      .put('/api/catalogs/agentes-aduanales/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ verified: true });
    expect(res.status).toBe(404);
  });
});

describe('GET /api/catalogs/importadores', () => {
  it('admin lists in camelCase; autoridad is 403', async () => {
    await query(
      `INSERT INTO importadores (rfc, name, fiscal_address, verified)
       VALUES ('ADM130509UQ0','ADMERCE SA DE CV','CDMX', false)`,
    );
    const admin = await request(app).get('/api/catalogs/importadores').set('Authorization', `Bearer ${adminToken}`);
    expect(admin.status).toBe(200);
    expect(admin.body[0]).toMatchObject({
      rfc: 'ADM130509UQ0', name: 'ADMERCE SA DE CV', fiscalAddress: 'CDMX', verified: false,
    });
    expect(admin.body[0].fiscal_address).toBeUndefined();

    const aut = await request(app).get('/api/catalogs/importadores').set('Authorization', `Bearer ${autoridadToken}`);
    expect(aut.status).toBe(403);
  });
});

describe('PUT /api/catalogs/importadores/:id', () => {
  it('admin can edit fields + verified, writes an audit row', async () => {
    const { rows } = await query(
      `INSERT INTO importadores (rfc, name, verified) VALUES ('ADM130509UQ0','OLD', false) RETURNING id`,
    );
    const id = rows[0].id;
    const res = await request(app)
      .put(`/api/catalogs/importadores/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'ADMERCE SA DE CV', fiscalAddress: 'PONIENTE 150, CDMX', verified: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'ADMERCE SA DE CV', fiscalAddress: 'PONIENTE 150, CDMX', verified: true });

    const audit = await query(`SELECT action FROM audit_log WHERE action='UPDATE_IMPORTADOR'`);
    expect(audit.rows).toHaveLength(1);
  });

  it('capturista PUT → 403', async () => {
    const { rows } = await query(`INSERT INTO importadores (rfc) VALUES ('ADM130509UQ0') RETURNING id`);
    const res = await request(app)
      .put(`/api/catalogs/importadores/${rows[0].id}`)
      .set('Authorization', `Bearer ${capturistaToken}`)
      .send({ verified: true });
    expect(res.status).toBe(403);
  });
});
