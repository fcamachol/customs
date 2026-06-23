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
