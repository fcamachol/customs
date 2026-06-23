import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { hashPassword } from '../../src/auth/password';
import { signToken } from '../../src/auth/token';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

const app = createApp();
let capToken: string;
let autToken: string;
let manifestId: string;
let capId: string;

const RFC = 'TOMM020922D40';

beforeEach(async () => {
  await truncateAll();
  const hash = await hashPassword('p');
  const cap = await query(`INSERT INTO users (username,password_hash,role) VALUES ('c',$1,'capturista') RETURNING id`, [hash]);
  const aut = await query(`INSERT INTO users (username,password_hash,role) VALUES ('a',$1,'autoridad') RETURNING id`, [hash]);
  capId = cap.rows[0].id;
  capToken = signToken({ userId: capId, role: 'capturista' });
  autToken = signToken({ userId: aut.rows[0].id, role: 'autoridad' });
  const m = await query(`INSERT INTO manifests (mawb_reference, client_name, created_by) VALUES ('369-1','Cliente A',$1) RETURNING id`, [capId]);
  manifestId = m.rows[0].id;
  const s = { id: crypto.randomUUID(), mawbReference: '369-1', description: 'TRAJE', hsCode: '99010001',
    quantity: 1, unit: '6', customsValueUsd: 120, currency: 'USD', originCountry: 'CN', guideId: 'g1',
    consignee: { name: 'Juan', rfc: RFC, address: 'Calle 1' }, sender: { name: 'S' }, platform: { commercialName: 'P', countryOfOrigin: 'CN' } };
  await query('INSERT INTO shipments (id,manifest_id,data,risk_color,risk_incidences) VALUES ($1,$2,$3,$4,$5)',
    [s.id, manifestId, JSON.stringify(s), 'rojo', JSON.stringify(['valor atipico'])]);
});

function get(token: string, qs = '') {
  return request(app).get(`/api/records/${manifestId}/reports.json${qs}`).set('Authorization', `Bearer ${token}`);
}

describe('GET /api/records/:id/reports.json', () => {
  it('returns the three report row sets with no-store and full PII for capturista', async () => {
    const res = await get(capToken);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.body.layout).toHaveLength(1);
    expect(Object.keys(res.body.layout[0])).toHaveLength(34);
    expect(Object.keys(res.body.report[0])).toHaveLength(36);
    expect(res.body.risk[0]).toMatchObject({ guide: 'g1', consignee: 'Juan', resultado: 'rojo', motivo: 'valor atipico' });
    // capturista sees full PII
    expect(res.body.layout[0]['Consignatario RFC']).toBe(RFC);
    expect(res.body.masked).toBe(false);
  });

  it('masks identity PII for autoridad and reveals it on ?reveal=all (audited)', async () => {
    const masked = await get(autToken);
    expect(masked.status).toBe(200);
    expect(masked.body.masked).toBe(true);
    expect(masked.body.layout[0]['Consignatario RFC']).not.toBe(RFC);
    expect(masked.body.report[0]['Consignatario RFC']).not.toBe(RFC);

    const revealed = await get(autToken, '?reveal=all');
    expect(revealed.body.layout[0]['Consignatario RFC']).toBe(RFC);

    const audit = await query(`SELECT action FROM audit_log WHERE action IN ('VIEW_REPORTS','REVEAL_PII')`);
    const actions = audit.rows.map((r) => r.action);
    expect(actions).toContain('VIEW_REPORTS');
    expect(actions).toContain('REVEAL_PII');
  });

  it('reflects lock state from pedimento finalization', async () => {
    await query(`UPDATE manifests SET prevalidation=$1 WHERE id=$2`, [JSON.stringify({ status: 'APPROVED' }), manifestId]);
    const res = await get(capToken);
    expect(res.body.lock.editable).toBe(false);
  });
});

describe('import-data edit-before-lock + concurrency + cache coherence', () => {
  const DATA = { cveT1: 'A1', patente: '3250', tasaImportacion: '17.50', fechaEntrada: '2024-01-15', claveAduanaEntrada: '460', claveAduanaDespacho: '461' };

  function postImport(body: object) {
    return request(app).post(`/api/manifests/${manifestId}/import-data`).set('Authorization', `Bearer ${capToken}`).send(body);
  }

  it('rejects edits with 409 once the pedimento is locked', async () => {
    await query(`UPDATE manifests SET prevalidation=$1 WHERE id=$2`, [JSON.stringify({ status: 'APPROVED' }), manifestId]);
    const res = await postImport(DATA);
    expect(res.status).toBe(409);
    expect(res.body.locked).toBe(true);
  });

  it('bumps version and rejects a stale optimistic write', async () => {
    const first = await postImport({ ...DATA, version: 0 });
    expect(first.status).toBe(200);
    expect(first.body.version).toBe(1);
    const stale = await postImport({ ...DATA, version: 0 });
    expect(stale.status).toBe(409);
    expect(stale.body.conflict).toBe(true);
  });

  it('busts the cached report and flags risk stale on edit', async () => {
    const f = await query(
      `INSERT INTO files (kind, original_name, storage_path, size_bytes, uploaded_by) VALUES ('risk_analysis','r.xlsx','/x',1,$1) RETURNING id`, [capId]);
    await query(`UPDATE manifests SET risk_file_id=$1, report_file_id=$1 WHERE id=$2`, [f.rows[0].id, manifestId]);

    const res = await postImport({ ...DATA, version: 0 });
    expect(res.status).toBe(200);

    const m = await query(`SELECT report_file_id, risk_stale FROM manifests WHERE id=$1`, [manifestId]);
    expect(m.rows[0].report_file_id).toBeNull();
    expect(m.rows[0].risk_stale).toBe(true);

    const bundle = await get(capToken);
    expect(bundle.body.riskStale).toBe(true);
  });
});
