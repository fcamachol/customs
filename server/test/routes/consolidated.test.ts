import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import * as XLSX from 'xlsx';
import { createApp } from '../../src/app';
import { hashPassword } from '../../src/auth/password';
import { signToken } from '../../src/auth/token';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

const app = createApp();

let adminToken: string;
let capturistaToken: string;
let autoridadToken: string;
const period = '2024-03';

beforeEach(async () => {
  await truncateAll();
  const hash = await hashPassword('p');

  const admin = await query(`INSERT INTO users (username,password_hash,role) VALUES ('admin',$1,'admin') RETURNING id`, [hash]);
  adminToken = signToken({ userId: admin.rows[0].id, role: 'admin' , tv: 0 });

  const cap = await query(`INSERT INTO users (username,password_hash,role) VALUES ('cap',$1,'capturista') RETURNING id`, [hash]);
  capturistaToken = signToken({ userId: cap.rows[0].id, role: 'capturista' , tv: 0 });

  const auth = await query(`INSERT INTO users (username,password_hash,role) VALUES ('aut',$1,'autoridad') RETURNING id`, [hash]);
  autoridadToken = signToken({ userId: auth.rows[0].id, role: 'autoridad' , tv: 0 });

  // Insert 2 manifests with shipments in the target period
  const m1 = await query(
    `INSERT INTO manifests (mawb_reference, client_name, created_by, created_at)
     VALUES ('369-1','Cliente A',$1,'2024-03-10T10:00:00Z') RETURNING id`,
    [admin.rows[0].id],
  );
  const m2 = await query(
    `INSERT INTO manifests (mawb_reference, client_name, created_by, created_at)
     VALUES ('369-2','Cliente B',$1,'2024-03-20T10:00:00Z') RETURNING id`,
    [admin.rows[0].id],
  );

  const makeShipment = (guideId: string, color: string) => ({
    id: crypto.randomUUID(),
    mawbReference: '369-1',
    description: 'ITEM',
    hsCode: '99010001',
    quantity: 1,
    unit: '6',
    customsValueUsd: 100,
    currency: 'USD',
    originCountry: 'CN',
    guideId,
    consignee: { name: 'Juan Perez', rfc: 'PEPJ800101XXX' },
    sender: { name: 'S' },
    platform: { commercialName: 'P' },
  });

  // 2 shipments in m1
  const s1 = makeShipment('g1', 'verde');
  const s2 = makeShipment('g2', 'rojo');
  await query('INSERT INTO shipments (id,manifest_id,data,risk_color) VALUES ($1,$2,$3,$4)',
    [s1.id, m1.rows[0].id, JSON.stringify(s1), 'verde']);
  await query('INSERT INTO shipments (id,manifest_id,data,risk_color) VALUES ($1,$2,$3,$4)',
    [s2.id, m1.rows[0].id, JSON.stringify(s2), 'rojo']);

  // 1 shipment in m2
  const s3 = makeShipment('g3', 'amarillo');
  await query('INSERT INTO shipments (id,manifest_id,data,risk_color) VALUES ($1,$2,$3,$4)',
    [s3.id, m2.rows[0].id, JSON.stringify(s3), 'amarillo']);

  // 1 shipment OUTSIDE the period (should be excluded)
  const mOut = await query(
    `INSERT INTO manifests (mawb_reference, client_name, created_by, created_at)
     VALUES ('369-9','Cliente C',$1,'2024-04-01T10:00:00Z') RETURNING id`,
    [admin.rows[0].id],
  );
  const sOut = makeShipment('gOut', 'verde');
  await query('INSERT INTO shipments (id,manifest_id,data,risk_color) VALUES ($1,$2,$3,$4)',
    [sOut.id, mOut.rows[0].id, JSON.stringify(sOut), 'verde']);
});

async function getXlsx(token: string, qs: string) {
  return request(app)
    .get(`/api/consolidated.xlsx?${qs}`)
    .set('Authorization', `Bearer ${token}`)
    .buffer()
    .parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
}

describe('GET /api/consolidated.xlsx', () => {
  it('admin: 200, xlsx content-type, 3 rows for period', async () => {
    const res = await getXlsx(adminToken, `period=${period}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    const wb = XLSX.read(res.body, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const json = XLSX.utils.sheet_to_json(sheet) as Record<string, unknown>[];
    expect(json).toHaveLength(3);
  });

  it('capturista: 403', async () => {
    const res = await getXlsx(capturistaToken, `period=${period}`);
    expect(res.status).toBe(403);
  });

  it('autoridad: 200', async () => {
    const res = await getXlsx(autoridadToken, `period=${period}`);
    expect(res.status).toBe(200);
    const wb = XLSX.read(res.body, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const json = XLSX.utils.sheet_to_json(sheet) as Record<string, unknown>[];
    expect(json).toHaveLength(3);
  });

  it('writes an EXPORT_CONSOLIDATED audit row on a successful authority download', async () => {
    const res = await getXlsx(autoridadToken, `period=${period}`);
    expect(res.status).toBe(200);
    const audit = await query(
      `SELECT action FROM audit_log WHERE action = 'EXPORT_CONSOLIDATED'`,
    );
    expect(audit.rows).toHaveLength(1);
  });

  it('Valida is true only for verde shipments', async () => {
    const res = await getXlsx(adminToken, `period=${period}`);
    const wb = XLSX.read(res.body, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const json = XLSX.utils.sheet_to_json(sheet) as Record<string, unknown>[];
    const g1Row = json.find((r) => r['Guia'] === 'g1');
    const g2Row = json.find((r) => r['Guia'] === 'g2');
    expect(g1Row?.['Valida']).toBeTruthy();  // verde → Valida true
    expect(g2Row?.['Valida']).toBeFalsy();   // rojo → Valida false
  });

  it('excludes shipments outside the period', async () => {
    const res = await getXlsx(adminToken, `period=${period}`);
    const wb = XLSX.read(res.body, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const json = XLSX.utils.sheet_to_json(sheet) as Record<string, unknown>[];
    const guias = json.map((r) => r['Guia']);
    expect(guias).not.toContain('gOut');
  });

  it('daily: ?date=2024-03-10 returns only that day\'s shipments', async () => {
    const res = await getXlsx(adminToken, `date=2024-03-10`);
    expect(res.status).toBe(200);
    const wb = XLSX.read(res.body, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const json = XLSX.utils.sheet_to_json(sheet) as Record<string, unknown>[];
    expect(json).toHaveLength(2); // m1 has 2 shipments, created 2024-03-10
  });

  it('unauthenticated: 401', async () => {
    const res = await request(app).get(`/api/consolidated.xlsx?period=${period}`);
    expect(res.status).toBe(401);
  });

  it('missing period and date: 400', async () => {
    const res = await request(app)
      .get('/api/consolidated.xlsx')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });
});
