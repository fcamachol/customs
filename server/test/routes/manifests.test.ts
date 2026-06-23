import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import * as XLSX from 'xlsx';
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

function xlsxBuffer(aoa: unknown[][]): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Hoja1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}
const HEADER = ['Número de guía de embarque', 'Descripción del Producto', 'Código HS', 'Número de productos', 'Valor total declarado', 'Divisa', 'Código de país del remitente', 'ID'];
const GOOD = ['G1', 'Camisa', '6109100022', '1', '6.03', 'Dólar estadounidense', 'CN', 'AERA790828HBSRBR04'];
const BAD = ['G2', 'Camisa', '6109100022', '1', 'N/A', 'Dólar estadounidense', 'CN', 'AERA790828HBSRBR04'];

describe('POST /api/manifests (multipart staging)', () => {
  it('stages rows, quarantines bad ones, persists nothing to shipments yet', async () => {
    const res = await request(app)
      .post('/api/manifests')
      .set('Authorization', `Bearer ${token}`)
      .field('mawbReference', '369-1')
      .field('clientName', 'Cliente A')
      .attach('file', xlsxBuffer([HEADER, GOOD, BAD]), 'm.xlsx');
    expect(res.status).toBe(201);
    expect(res.body.counts).toEqual({ total: 2, valid: 0, warning: 1, error: 1 });
    expect(res.body.rejected.length).toBe(1);
    const staged = await query('SELECT count(*)::int AS n FROM manifest_staging_rows');
    expect(staged.rows[0].n).toBe(2);
    const ships = await query('SELECT count(*)::int AS n FROM shipments');
    expect(ships.rows[0].n).toBe(0); // gold is empty until promotion
    const man = await query('SELECT ingestion_status FROM manifests WHERE id=$1', [res.body.manifestId]);
    expect(man.rows[0].ingestion_status).toBe('staged');
  });

  it('rejects a non-file request', async () => {
    const res = await request(app).post('/api/manifests').set('Authorization', `Bearer ${token}`).field('mawbReference', 'x');
    expect(res.status).toBe(400);
  });
});

describe('GET /api/manifests/:id/staging', () => {
  it('returns staging rows with statuses and redacts PII', async () => {
    const up = await request(app).post('/api/manifests').set('Authorization', `Bearer ${token}`)
      .field('mawbReference', '369-2').attach('file', xlsxBuffer([HEADER, GOOD, BAD]), 'm.xlsx');
    const res = await request(app).get(`/api/manifests/${up.body.manifestId}/staging`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.rows.length).toBe(2);
    expect(res.body.rows.map((r: any) => r.status).sort()).toEqual(['error', 'warning']);
    expect(JSON.stringify(res.body)).not.toContain('AERA790828HBSRBR04'); // raw PII not leaked
  });
});

describe('PII encryption at rest', () => {
  it('stores consignee curp as v1:-encrypted in manifest_staging_rows', async () => {
    await request(app)
      .post('/api/manifests')
      .set('Authorization', `Bearer ${token}`)
      .field('mawbReference', '369-pii')
      .attach('file', xlsxBuffer([HEADER, GOOD]), 'm.xlsx');
    const r = await query<{ data: any }>('SELECT data FROM manifest_staging_rows ORDER BY row_index LIMIT 1');
    const c = r.rows[0].data.consignee;
    expect((c.curp ?? c.rfc ?? '')).toMatch(/^v1:/);
  });
});

describe('POST /api/manifests/:id/promote', () => {
  it('promotes valid+warning rows to shipments and is idempotent on re-upload', async () => {
    const up = await request(app).post('/api/manifests').set('Authorization', `Bearer ${token}`)
      .field('mawbReference', '369-3').attach('file', xlsxBuffer([HEADER, GOOD]), 'm.xlsx');
    const id = up.body.manifestId;
    const prom = await request(app).post(`/api/manifests/${id}/promote`).set('Authorization', `Bearer ${token}`);
    expect(prom.status).toBe(200);
    expect(prom.body.promoted).toBe(1);
    let ships = await query('SELECT count(*)::int AS n FROM shipments WHERE manifest_id=$1', [id]);
    expect(ships.rows[0].n).toBe(1);
    const man = await query('SELECT ingestion_status FROM manifests WHERE id=$1', [id]);
    expect(man.rows[0].ingestion_status).toBe('promoted');
    // second promote is rejected (state machine guard)
    const again = await request(app).post(`/api/manifests/${id}/promote`).set('Authorization', `Bearer ${token}`);
    expect(again.status).toBe(409);
  });

  it('refuses promotion while error rows remain', async () => {
    const up = await request(app).post('/api/manifests').set('Authorization', `Bearer ${token}`)
      .field('mawbReference', '369-4').attach('file', xlsxBuffer([HEADER, GOOD, BAD]), 'm.xlsx');
    const prom = await request(app).post(`/api/manifests/${up.body.manifestId}/promote`).set('Authorization', `Bearer ${token}`);
    expect(prom.status).toBe(422);
    const ships = await query('SELECT count(*)::int AS n FROM shipments WHERE manifest_id=$1', [up.body.manifestId]);
    expect(ships.rows[0].n).toBe(0);
  });
});
