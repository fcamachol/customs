import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { hashPassword } from '../../src/auth/password';
import { signToken } from '../../src/auth/token';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

const app = createApp();
let token: string;
let userId: string;

async function addShipment(manifestId: string, guideId: string, riskColor: string | null = null) {
  await query(
    `INSERT INTO shipments (id, manifest_id, data, risk_color) VALUES (gen_random_uuid(), $1, $2::jsonb, $3)`,
    [manifestId, JSON.stringify({ guideId }), riskColor]);
}

async function addPedimento(manifestId: string, fields: {
  numero?: string; covered?: string[]; siblings?: string[]; fileId?: string; scanVerdict?: string;
} = {}) {
  await query(
    `INSERT INTO pedimentos (manifest_id, numero_pedimento, covered_guias, sibling_numeros, file_id, pedimento_scan, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      manifestId,
      fields.numero ?? null,
      fields.covered ?? null,
      fields.siblings ?? null,
      fields.fileId ?? null,
      fields.scanVerdict ? JSON.stringify({ verdict: fields.scanVerdict, findings: [] }) : null,
      userId,
    ]);
}

beforeEach(async () => {
  await truncateAll();
  const hash = await hashPassword('p');
  const u = await query(`INSERT INTO users (username,password_hash,role) VALUES ('c',$1,'capturista') RETURNING id`, [hash]);
  userId = u.rows[0].id;
  token = signToken({ userId, role: 'capturista' , tv: 0 });
  await query(`INSERT INTO manifests (mawb_reference, client_name, created_by) VALUES ('369-1','Cliente A',$1),('370-2','Cliente B',$1)`, [userId]);
});

describe('records', () => {
  it('searches by MAWB – Cliente', async () => {
    const res = await request(app).get('/api/records?q=Cliente%20A').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].clientName).toBe('Cliente A');
  });

  it('returns a single record with its 3 artifacts in Consulta', async () => {
    const list = await request(app).get('/api/records?q=369-1').set('Authorization', `Bearer ${token}`);
    const id = list.body[0].id;
    const res = await request(app).get(`/api/records/${id}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('artifacts');
    expect(res.body.artifacts).toHaveProperty('riskAnalysis');
    expect(res.body.artifacts).toHaveProperty('pedimentoPdf');
    expect(res.body.artifacts).toHaveProperty('report');
    expect(res.body).toHaveProperty('pedimentos');
    expect(res.body).toHaveProperty('coverage');
  });
});

describe('records — Consulta filters', () => {
  const auth = () => ({ Authorization: `Bearer ${token}` });

  it('filters by exact client name', async () => {
    const res = await request(app).get('/api/records?clientName=Cliente%20A').set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].clientName).toBe('Cliente A');
  });

  it('filters by risk result: verde matches manifests containing a verde shipment', async () => {
    const m = await query(`INSERT INTO manifests (mawb_reference, client_name, created_by) VALUES ('500-9','Cliente C',$1) RETURNING id`, [userId]);
    await addShipment(m.rows[0].id, 'G-VERDE', 'verde');
    const res = await request(app).get('/api/records?result=verde').set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].mawbReference).toBe('500-9');
  });

  it('filters by risk result: gris matches manifests with no scored shipments', async () => {
    const m = await query(`INSERT INTO manifests (mawb_reference, client_name, created_by) VALUES ('500-9','Cliente C',$1) RETURNING id`, [userId]);
    await addShipment(m.rows[0].id, 'G-VERDE', 'verde');
    const res = await request(app).get('/api/records?result=gris').set(auth());
    expect(res.status).toBe(200);
    // The two seeded manifests have no shipments; the verde one is excluded.
    expect(res.body).toHaveLength(2);
    expect(res.body.map((r: { mawbReference: string }) => r.mawbReference).sort()).toEqual(['369-1', '370-2']);
  });

  it('filters by platform id', async () => {
    const c = await query(`INSERT INTO clients (name, created_by) VALUES ('Cliente A',$1) RETURNING id`, [userId]);
    const p = await query(`INSERT INTO client_platforms (client_id, commercial_name, created_by) VALUES ($1,'Tienda A',$2) RETURNING id`, [c.rows[0].id, userId]);
    await query(`INSERT INTO manifests (mawb_reference, client_name, platform_id, created_by) VALUES ('600-1','Cliente A',$1,$2)`, [p.rows[0].id, userId]);
    const res = await request(app).get(`/api/records?platformId=${p.rows[0].id}`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].mawbReference).toBe('600-1');
  });

});

describe('records — coverage status (list)', () => {
  const auth = () => ({ Authorization: `Bearer ${token}` });

  it('reports sin_pedimento with 0 uploaded for a bare manifest', async () => {
    const res = await request(app).get('/api/records?q=369-1').set(auth());
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ coverageStatus: 'sin_pedimento', uploadedCount: 0 });
  });

  it('reports completo when the single pedimento covers every manifest guía', async () => {
    const m = await query(`INSERT INTO manifests (mawb_reference, client_name, created_by) VALUES ('800-1','Cliente G',$1) RETURNING id`, [userId]);
    const id = m.rows[0].id;
    await addShipment(id, 'GUIA-A');
    await addShipment(id, 'GUIA-B');
    await addPedimento(id, { numero: '111', covered: ['GUIA-A', 'GUIA-B'], fileId: undefined });
    const res = await request(app).get('/api/records?q=800-1').set(auth());
    expect(res.body[0]).toMatchObject({ coverageStatus: 'completo', uploadedCount: 1 });
  });

  it('reports parcial when a manifest guía is left uncovered', async () => {
    const m = await query(`INSERT INTO manifests (mawb_reference, client_name, created_by) VALUES ('801-1','Cliente H',$1) RETURNING id`, [userId]);
    const id = m.rows[0].id;
    await addShipment(id, 'GUIA-A');
    await addShipment(id, 'GUIA-B');
    await addPedimento(id, { numero: '111', covered: ['GUIA-A'] });
    const res = await request(app).get('/api/records?q=801-1').set(auth());
    expect(res.body[0]).toMatchObject({ coverageStatus: 'parcial', uploadedCount: 1 });
  });

  it('reports parcial with an expectedCount when a sibling pedimento is still missing', async () => {
    const m = await query(`INSERT INTO manifests (mawb_reference, client_name, created_by) VALUES ('802-1','Cliente I',$1) RETURNING id`, [userId]);
    const id = m.rows[0].id;
    await addShipment(id, 'GUIA-A');
    // One uploaded pedimento that declares a sibling → expected = 2, uploaded = 1.
    await addPedimento(id, { numero: '258516535001684', covered: ['GUIA-A'], siblings: ['258516535001685'] });
    const res = await request(app).get('/api/records?q=802-1').set(auth());
    expect(res.body[0]).toMatchObject({ coverageStatus: 'parcial', expectedCount: 2, uploadedCount: 1 });
  });
});

describe('records — detail pedimentos[]', () => {
  const auth = () => ({ Authorization: `Bearer ${token}` });

  it('returns per-pedimento rows with lock + scan + own PDF artifact', async () => {
    const m = await query(`INSERT INTO manifests (mawb_reference, client_name, created_by) VALUES ('900-1','Cliente J',$1) RETURNING id`, [userId]);
    const id = m.rows[0].id;
    await addShipment(id, 'GUIA-A');
    const f = await query(`INSERT INTO files (kind, original_name, storage_path, size_bytes, uploaded_by) VALUES ('pedimento_pdf','p.pdf','/p.pdf',1,$1) RETURNING id`, [userId]);
    await addPedimento(id, { numero: '111', covered: ['GUIA-A'], fileId: f.rows[0].id, scanVerdict: 'clean' });

    const res = await request(app).get(`/api/records/${id}`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.pedimentos).toHaveLength(1);
    const p = res.body.pedimentos[0];
    expect(p.numeroPedimento).toBe('111');
    expect(p.fileId).toBe(f.rows[0].id);
    expect(p.scanVerdict).toBe('clean');
    expect(p.pedimentoPdf).toBe(`/api/files/${f.rows[0].id}`);
    // A pedimento with an attached file is locked (computeLock on the row).
    expect(p.lock).toMatchObject({ editable: false });
    expect(p.coveredGuias).toEqual(['GUIA-A']);
    // Coverage is complete (single guía covered).
    expect(res.body.coverage.status).toBe('completo');
    // Top-level pedimentoPdf is sourced from the pedimento's file.
    expect(res.body.artifacts.pedimentoPdf).toBe(`/api/files/${f.rows[0].id}`);
  });

  it('returns an empty pedimentos list and null pedimentoPdf for a bare manifest', async () => {
    const list = await request(app).get('/api/records?q=370-2').set(auth());
    const id = list.body[0].id;
    const res = await request(app).get(`/api/records/${id}`).set(auth());
    expect(res.body.pedimentos).toEqual([]);
    expect(res.body.artifacts.pedimentoPdf).toBeNull();
    expect(res.body.coverage.status).toBe('sin_pedimento');
  });
});

describe('records — Consulta filters (cont.)', () => {
  const auth = () => ({ Authorization: `Bearer ${token}` });

  it('ignores malformed filter values and a future dateFrom returns nothing', async () => {
    // Non-uuid platformId is ignored (no SQL error); future dateFrom excludes today's records.
    const ignored = await request(app).get('/api/records?platformId=not-a-uuid').set(auth());
    expect(ignored.status).toBe(200);
    expect(ignored.body.length).toBeGreaterThanOrEqual(2);

    const future = await request(app).get('/api/records?dateFrom=2099-01-01').set(auth());
    expect(future.status).toBe(200);
    expect(future.body).toHaveLength(0);
  });
});
