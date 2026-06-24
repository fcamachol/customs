import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import * as XLSX from 'xlsx';
import { createApp } from '../../src/app';
import { hashPassword } from '../../src/auth/password';
import { signToken } from '../../src/auth/token';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

const app = createApp();
let token: string; let manifestId: string; let userId: string;

beforeEach(async () => {
  await truncateAll();
  const hash = await hashPassword('p');
  const u = await query(`INSERT INTO users (username,password_hash,role) VALUES ('c',$1,'capturista') RETURNING id`, [hash]);
  userId = u.rows[0].id;
  token = signToken({ userId, role: 'capturista' , tv: 0 });
  const m = await query(`INSERT INTO manifests (mawb_reference, client_name, created_by) VALUES ('369-1','Cliente A',$1) RETURNING id`, [userId]);
  manifestId = m.rows[0].id;
  const s = { id: crypto.randomUUID(), mawbReference: '369-1', description: 'TRAJE', hsCode: '99010001',
    quantity: 1, unit: '6', customsValueUsd: 120, currency: 'USD', originCountry: 'CN', guideId: 'g1',
    consignee: { name: 'Juan', rfc: 'TOMM020922D40' }, sender: { name: 'S' }, platform: { commercialName: 'P' } };
  await query('INSERT INTO shipments (id,manifest_id,data,risk_color,risk_incidences) VALUES ($1,$2,$3,$4,$5)',
    [s.id, manifestId, JSON.stringify(s), 'rojo', JSON.stringify(['valor atipico', 'destinatario nuevo'])]);
});

async function addPedimento(coveredGuias: string[] = ['g1']): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO pedimentos (manifest_id, numero_pedimento, covered_guias, created_by)
     VALUES ($1,'111',$2,$3) RETURNING id`,
    [manifestId, coveredGuias, userId],
  );
  return r.rows[0].id;
}

function fetchXlsx(path: string) {
  return request(app).get(path).set('Authorization', `Bearer ${token}`).buffer().parse((r, cb) => {
    const chunks: Buffer[] = []; r.on('data', (c) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks)));
  });
}
function sheetJson(body: Buffer): Record<string, string>[] {
  const wb = XLSX.read(body, { type: 'buffer' });
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]) as Record<string, string>[];
}

describe('exports — per-pedimento layout + report', () => {
  it('returns a parseable LayOut workbook with 35 columns over the covered subset', async () => {
    const pedimentoId = await addPedimento(['g1']);
    const res = await fetchXlsx(`/api/pedimentos/${pedimentoId}/layout.xlsx`);
    expect(res.status).toBe(200);
    const json = sheetJson(res.body);
    expect(json).toHaveLength(1);
    expect(Object.keys(json[0])).toHaveLength(35);
  });

  it('populates report Motivo from persisted risk incidences', async () => {
    const pedimentoId = await addPedimento(['g1']);
    const res = await fetchXlsx(`/api/pedimentos/${pedimentoId}/report.xlsx`);
    expect(res.status).toBe(200);
    expect(sheetJson(res.body)[0].Motivo).toBe('valor atipico; destinatario nuevo');
  });

  it('report.xlsx contains only the covered-guía subset', async () => {
    const s2 = { id: crypto.randomUUID(), mawbReference: '369-1', description: 'OTRO', hsCode: '99010002',
      quantity: 1, unit: '6', customsValueUsd: 50, currency: 'USD', originCountry: 'CN', guideId: 'g2',
      consignee: { name: 'Maria' }, sender: { name: 'S' }, platform: { commercialName: 'P' } };
    await query('INSERT INTO shipments (id,manifest_id,data) VALUES ($1,$2,$3)', [s2.id, manifestId, JSON.stringify(s2)]);
    const pedimentoId = await addPedimento(['g1']);
    const res = await fetchXlsx(`/api/pedimentos/${pedimentoId}/report.xlsx`);
    const json = sheetJson(res.body);
    expect(json).toHaveLength(1);
    expect(json[0]['No. de guía aérea']).toBe('g1');
  });
});
