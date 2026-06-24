import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import * as XLSX from 'xlsx';
import { createApp } from '../../src/app';
import { hashPassword } from '../../src/auth/password';
import { signToken } from '../../src/auth/token';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

const app = createApp();
let token: string; let manifestId: string;

beforeEach(async () => {
  await truncateAll();
  const hash = await hashPassword('p');
  const u = await query(`INSERT INTO users (username,password_hash,role) VALUES ('c',$1,'capturista') RETURNING id`, [hash]);
  token = signToken({ userId: u.rows[0].id, role: 'capturista' , tv: 0 });
  const m = await query(`INSERT INTO manifests (mawb_reference, client_name, created_by) VALUES ('369-1','Cliente A',$1) RETURNING id`, [u.rows[0].id]);
  manifestId = m.rows[0].id;
  const s = { id: crypto.randomUUID(), mawbReference: '369-1', description: 'TRAJE', hsCode: '99010001',
    quantity: 1, unit: '6', customsValueUsd: 120, currency: 'USD', originCountry: 'CN', guideId: 'g1',
    consignee: { name: 'Juan', rfc: 'TOMM020922D40' }, sender: { name: 'S' }, platform: { commercialName: 'P' } };
  await query('INSERT INTO shipments (id,manifest_id,data,risk_color,risk_incidences) VALUES ($1,$2,$3,$4,$5)',
    [s.id, manifestId, JSON.stringify(s), 'rojo', JSON.stringify(['valor atipico', 'destinatario nuevo'])]);
});

describe('exports', () => {
  it('returns a parseable LayOut workbook with 35 columns', async () => {
    const res = await request(app).get(`/api/records/${manifestId}/layout.xlsx`).set('Authorization', `Bearer ${token}`).buffer().parse((r, cb) => {
      const chunks: Buffer[] = []; r.on('data', (c) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    const wb = XLSX.read(res.body, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const json = XLSX.utils.sheet_to_json(sheet);
    expect(Object.keys(json[0] as object)).toHaveLength(35);
  });

  it('populates report Motivo from persisted risk incidences', async () => {
    const res = await request(app).get(`/api/records/${manifestId}/report.xlsx`).set('Authorization', `Bearer ${token}`).buffer().parse((r, cb) => {
      const chunks: Buffer[] = []; r.on('data', (c) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    const wb = XLSX.read(res.body, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const json = XLSX.utils.sheet_to_json(sheet) as Record<string, string>[];
    expect(json[0].Motivo).toBe('valor atipico; destinatario nuevo');
  });
});
