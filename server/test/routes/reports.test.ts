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
  capToken = signToken({ userId: capId, role: 'capturista' , tv: 0 });
  autToken = signToken({ userId: aut.rows[0].id, role: 'autoridad' , tv: 0 });
  const m = await query(`INSERT INTO manifests (mawb_reference, client_name, created_by) VALUES ('369-1','Cliente A',$1) RETURNING id`, [capId]);
  manifestId = m.rows[0].id;
  const s = { id: crypto.randomUUID(), mawbReference: '369-1', description: 'TRAJE', hsCode: '99010001',
    quantity: 1, unit: '6', customsValueUsd: 120, currency: 'USD', originCountry: 'CN', guideId: 'g1',
    consignee: { name: 'Juan', rfc: RFC, address: 'Calle 1' }, sender: { name: 'S' }, platform: { commercialName: 'P', countryOfOrigin: 'CN' } };
  await query('INSERT INTO shipments (id,manifest_id,data,risk_color,risk_incidences) VALUES ($1,$2,$3,$4,$5)',
    [s.id, manifestId, JSON.stringify(s), 'rojo', JSON.stringify(['valor atipico'])]);
});

/** Create a pedimento (subdivisión) covering the given guías. */
async function addPedimento(
  coveredGuias: string[] = ['g1'],
  fields: { fileId?: string | null; prevalidation?: object | null } = {},
): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO pedimentos (manifest_id, numero_pedimento, covered_guias, file_id, prevalidation, created_by)
     VALUES ($1,'111',$2,$3,$4,$5) RETURNING id`,
    [manifestId, coveredGuias, fields.fileId ?? null, fields.prevalidation ? JSON.stringify(fields.prevalidation) : null, capId],
  );
  return r.rows[0].id;
}

function getRisk(token: string) {
  return request(app).get(`/api/records/${manifestId}/reports.json`).set('Authorization', `Bearer ${token}`);
}
function getPedReports(pedimentoId: string, token: string, qs = '') {
  return request(app).get(`/api/pedimentos/${pedimentoId}/reports.json${qs}`).set('Authorization', `Bearer ${token}`);
}

describe('GET /api/records/:id/reports.json — per-manifest risk', () => {
  it('returns only the risk screen + stale banner with no-store (no report/layout, no PII)', async () => {
    const res = await getRisk(capToken);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.body.risk[0]).toMatchObject({ guide: 'g1', consignee: 'Juan', resultado: 'rojo', motivo: 'valor atipico' });
    expect(res.body.riskStale).toBe(false);
    // Report + layout (and their PII) are NOT served from the manifest endpoint anymore.
    expect(res.body.report).toBeUndefined();
    expect(res.body.layout).toBeUndefined();
  });

  it('records a best-effort VIEW_RISK audit', async () => {
    await getRisk(capToken);
    const audit = await query(`SELECT action FROM audit_log WHERE action='VIEW_RISK'`);
    expect(audit.rows.length).toBeGreaterThan(0);
  });
});

describe('GET /api/pedimentos/:pedimentoId/reports.json — per-pedimento report + layout', () => {
  it('returns report + layout with full PII for capturista', async () => {
    const pedimentoId = await addPedimento(['g1']);
    const res = await getPedReports(pedimentoId, capToken);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.body.layout).toHaveLength(1);
    expect(Object.keys(res.body.layout[0])).toHaveLength(35);
    expect(Object.keys(res.body.report[0])).toHaveLength(37);
    // capturista sees full PII
    expect(res.body.layout[0]['Consignatario RFC']).toBe(RFC);
    expect(res.body.masked).toBe(false);
    // risk is NOT part of the per-pedimento bundle.
    expect(res.body.risk).toBeUndefined();
  });

  it('builds over the covered_guias SUBSET — a shipment not covered is absent', async () => {
    // Add a second shipment (g2) NOT covered by this pedimento.
    const s2 = { id: crypto.randomUUID(), mawbReference: '369-1', description: 'OTRO', hsCode: '99010002',
      quantity: 1, unit: '6', customsValueUsd: 50, currency: 'USD', originCountry: 'CN', guideId: 'g2',
      consignee: { name: 'Maria' }, sender: { name: 'S' }, platform: { commercialName: 'P' } };
    await query('INSERT INTO shipments (id,manifest_id,data) VALUES ($1,$2,$3)', [s2.id, manifestId, JSON.stringify(s2)]);

    const pedimentoId = await addPedimento(['g1']);
    const res = await getPedReports(pedimentoId, capToken);
    expect(res.status).toBe(200);
    expect(res.body.report).toHaveLength(1);
    const guias = res.body.report.map((r: Record<string, string>) => r['No. de guía aérea']);
    expect(guias).toContain('g1');
    expect(guias).not.toContain('g2');
  });

  it('two pedimentos over different subsets produce different reports', async () => {
    const s2 = { id: crypto.randomUUID(), mawbReference: '369-1', description: 'OTRO', hsCode: '99010002',
      quantity: 1, unit: '6', customsValueUsd: 50, currency: 'USD', originCountry: 'CN', guideId: 'g2',
      consignee: { name: 'Maria' }, sender: { name: 'S' }, platform: { commercialName: 'P' } };
    await query('INSERT INTO shipments (id,manifest_id,data) VALUES ($1,$2,$3)', [s2.id, manifestId, JSON.stringify(s2)]);

    const pedA = await addPedimento(['g1']);
    const pedB = await addPedimento(['g2']);
    const a = await getPedReports(pedA, capToken);
    const b = await getPedReports(pedB, capToken);
    expect(a.body.report.map((r: Record<string, string>) => r['No. de guía aérea'])).toEqual(['g1']);
    expect(b.body.report.map((r: Record<string, string>) => r['No. de guía aérea'])).toEqual(['g2']);
    expect(a.body.contentHash).not.toBe(b.body.contentHash);
  });

  it('an empty covered_guias subset yields empty report/layout rows', async () => {
    const pedimentoId = await addPedimento([]);
    const res = await getPedReports(pedimentoId, capToken);
    expect(res.status).toBe(200);
    expect(res.body.report).toHaveLength(0);
    expect(res.body.layout).toHaveLength(0);
  });

  it('masks identity PII for autoridad and reveals it on ?reveal=all (fail-closed audit)', async () => {
    const pedimentoId = await addPedimento(['g1']);
    const masked = await getPedReports(pedimentoId, autToken);
    expect(masked.status).toBe(200);
    expect(masked.body.masked).toBe(true);
    expect(masked.body.layout[0]['Consignatario RFC']).not.toBe(RFC);
    expect(masked.body.report[0]['Consignatario RFC']).not.toBe(RFC);

    const revealed = await getPedReports(pedimentoId, autToken, '?reveal=all');
    expect(revealed.body.layout[0]['Consignatario RFC']).toBe(RFC);

    const audit = await query(`SELECT action FROM audit_log WHERE action IN ('VIEW_REPORTS','REVEAL_PII')`);
    const actions = audit.rows.map((r) => r.action);
    expect(actions).toContain('VIEW_REPORTS');
    expect(actions).toContain('REVEAL_PII');
  });

  it('reflects lock state from THIS pedimento finalization', async () => {
    const pedimentoId = await addPedimento(['g1'], { prevalidation: { status: 'APPROVED' } });
    const res = await getPedReports(pedimentoId, capToken);
    expect(res.body.lock.editable).toBe(false);
  });

  it('404s an unknown pedimento', async () => {
    const res = await getPedReports(crypto.randomUUID(), capToken);
    expect(res.status).toBe(404);
  });
});

describe('per-pedimento import-data: lock + concurrency + report read/cache coherence', () => {
  const DATA = { cveT1: 'A1', patente: '3250', tasaImportacion: '17.50', fechaEntrada: '2024-01-15', claveAduanaEntrada: '460', claveAduanaDespacho: '461' };

  function postImport(pedimentoId: string, body: object) {
    return request(app).post(`/api/pedimentos/${pedimentoId}/import-data`).set('Authorization', `Bearer ${capToken}`).send(body);
  }

  it('rejects edits with 409 once the pedimento row is locked', async () => {
    const pedimentoId = await addPedimento(['g1'], { prevalidation: { status: 'APPROVED' } });
    const res = await postImport(pedimentoId, DATA);
    expect(res.status).toBe(409);
    expect(res.body.locked).toBe(true);
  });

  it('bumps version and rejects a stale optimistic write', async () => {
    const pedimentoId = await addPedimento(['g1']);
    const first = await postImport(pedimentoId, { ...DATA, version: 0 });
    expect(first.status).toBe(200);
    expect(first.body.version).toBe(1);
    const stale = await postImport(pedimentoId, { ...DATA, version: 0 });
    expect(stale.status).toBe(409);
    expect(stale.body.conflict).toBe(true);
  });

  it('busts THIS pedimento report cache but does not flag risk stale on import-data edit', async () => {
    const pedimentoId = await addPedimento(['g1']);
    const f = await query(
      `INSERT INTO files (kind, original_name, storage_path, size_bytes, uploaded_by) VALUES ('report','r.xlsx','/x',1,$1) RETURNING id`, [capId]);
    await query(`UPDATE pedimentos SET report_file_id=$1 WHERE id=$2`, [f.rows[0].id, pedimentoId]);
    await query(`UPDATE manifests SET risk_stale=false WHERE id=$1`, [manifestId]);

    const res = await postImport(pedimentoId, { ...DATA, version: 0 });
    expect(res.status).toBe(200);

    const p = await query(`SELECT report_file_id FROM pedimentos WHERE id=$1`, [pedimentoId]);
    expect(p.rows[0].report_file_id).toBeNull();
    const mm = await query(`SELECT risk_stale FROM manifests WHERE id=$1`, [manifestId]);
    expect(mm.rows[0].risk_stale).toBe(false);
  });

  it('report rows reflect import-data captured on this pedimento row', async () => {
    const pedimentoId = await addPedimento(['g1']);
    await postImport(pedimentoId, { ...DATA, patente: '9999', version: 0 });

    const bundle = await getPedReports(pedimentoId, capToken);
    expect(bundle.status).toBe(200);
    expect(bundle.body.report[0]['Patente AA']).toBe('9999');
  });
});
