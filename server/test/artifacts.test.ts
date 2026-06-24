import { beforeEach, describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import request from 'supertest';
import { createApp } from '../src/app';
import { hashPassword } from '../src/auth/password';
import { signToken } from '../src/auth/token';
import { query } from '../src/db/pool';
import { truncateAll } from './helpers/db';

const app = createApp();
let token: string;
let manifestId: string;

let userId: string;
const guias: string[] = [];

async function addShipment(name: string, value: number) {
  const guideId = `g-${name}`;
  guias.push(guideId);
  const s = {
    id: crypto.randomUUID(),
    mawbReference: '369-1',
    description: 'camisa',
    hsCode: '9901000100',
    quantity: 1,
    unit: 'PCE',
    customsValueUsd: value,
    currency: 'USD',
    originCountry: 'CN',
    guideId,
    consignee: { name, rfc: 'PERJ800101AAA', address: 'Calle 1' },
    sender: { name: 'S' },
    platform: { commercialName: 'P' },
  };
  await query('INSERT INTO shipments (id, manifest_id, data) VALUES ($1,$2,$3)', [s.id, manifestId, JSON.stringify(s)]);
}

/** A pedimento covering every shipment seeded so far (defaults to all current guías). */
async function addPedimento(coveredGuias: string[] = guias): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO pedimentos (manifest_id, numero_pedimento, covered_guias, created_by)
     VALUES ($1,'111',$2,$3) RETURNING id`,
    [manifestId, coveredGuias, userId],
  );
  return r.rows[0].id;
}

beforeEach(async () => {
  await truncateAll();
  guias.length = 0;
  const hash = await hashPassword('p');
  const u = await query(`INSERT INTO users (username,password_hash,role) VALUES ('c',$1,'capturista') RETURNING id`, [hash]);
  userId = u.rows[0].id;
  token = signToken({ userId, role: 'capturista' , tv: 0 });
  const m = await query(`INSERT INTO manifests (mawb_reference, created_by) VALUES ('369-1', $1) RETURNING id`, [userId]);
  manifestId = m.rows[0].id;
});

describe('POST /api/manifests/:id/risk — artifact persistence', () => {
  it('sets risk_file_id on manifests and creates a files row with kind risk_analysis', async () => {
    await addShipment('Ana', 100);
    await addShipment('Bad', 5000);

    const res = await request(app)
      .post(`/api/manifests/${manifestId}/risk`)
      .set('Authorization', `Bearer ${token}`)
      .send({ period: '2025-02' });

    expect(res.status).toBe(200);

    // manifests.risk_file_id must be set
    const { rows: mRows } = await query<{ risk_file_id: string | null }>(
      'SELECT risk_file_id FROM manifests WHERE id=$1', [manifestId]);
    expect(mRows[0].risk_file_id).not.toBeNull();

    // a files row with kind 'risk_analysis' must exist
    const { rows: fRows } = await query<{ kind: string }>(
      `SELECT kind FROM files WHERE id=$1`, [mRows[0].risk_file_id]);
    expect(fRows[0].kind).toBe('risk_analysis');
  });

  it('risk workbook includes a Motivo column', async () => {
    await addShipment('Ana', 100);

    await request(app)
      .post(`/api/manifests/${manifestId}/risk`)
      .set('Authorization', `Bearer ${token}`)
      .send({ period: '2025-02' });

    // Fetch via GET risk.xlsx which should serve the stored file
    const xlsxRes = await request(app)
      .get(`/api/records/${manifestId}/risk.xlsx`)
      .set('Authorization', `Bearer ${token}`)
      .buffer()
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(xlsxRes.status).toBe(200);
    const wb = XLSX.read(xlsxRes.body, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const json = XLSX.utils.sheet_to_json(sheet) as Record<string, unknown>[];
    expect(Object.keys(json[0])).toContain('Motivo');
  });

  it('GET /:id/risk.xlsx streams the stored bytes after risk run', async () => {
    await addShipment('Ana', 100);

    // Run risk to generate + persist
    await request(app)
      .post(`/api/manifests/${manifestId}/risk`)
      .set('Authorization', `Bearer ${token}`)
      .send({ period: '2025-02' });

    const res = await request(app)
      .get(`/api/records/${manifestId}/risk.xlsx`)
      .set('Authorization', `Bearer ${token}`)
      .buffer()
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml.sheet');
    // Must be a valid XLSX
    const wb = XLSX.read(res.body, { type: 'buffer' });
    expect(wb.SheetNames).toHaveLength(1);
  });
});

describe('GET /api/pedimentos/:pedimentoId/report.xlsx — per-pedimento artifact persistence', () => {
  it('persists the report XLSX on first generation and sets pedimentos.report_file_id', async () => {
    await addShipment('Ana', 100);
    const pedimentoId = await addPedimento();

    // Trigger risk first so incidences exist
    await request(app)
      .post(`/api/manifests/${manifestId}/risk`)
      .set('Authorization', `Bearer ${token}`)
      .send({ period: '2025-02' });

    // First GET → generates + persists
    const res1 = await request(app)
      .get(`/api/pedimentos/${pedimentoId}/report.xlsx`)
      .set('Authorization', `Bearer ${token}`)
      .buffer()
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res1.status).toBe(200);

    const { rows: pRows } = await query<{ report_file_id: string | null }>(
      'SELECT report_file_id FROM pedimentos WHERE id=$1', [pedimentoId]);
    expect(pRows[0].report_file_id).not.toBeNull();

    const { rows: fRows } = await query<{ kind: string }>(
      'SELECT kind FROM files WHERE id=$1', [pRows[0].report_file_id]);
    expect(fRows[0].kind).toBe('report');

    // The manifest report cache column is NOT touched (report is per-pedimento now).
    const { rows: mRows } = await query<{ report_file_id: string | null }>(
      'SELECT report_file_id FROM manifests WHERE id=$1', [manifestId]);
    expect(mRows[0].report_file_id).toBeNull();
  });

  it('second GET /report.xlsx returns the stored bytes (immutable)', async () => {
    await addShipment('Ana', 100);
    const pedimentoId = await addPedimento();

    await request(app)
      .post(`/api/manifests/${manifestId}/risk`)
      .set('Authorization', `Bearer ${token}`)
      .send({ period: '2025-02' });

    // First call: generate + store
    await request(app)
      .get(`/api/pedimentos/${pedimentoId}/report.xlsx`)
      .set('Authorization', `Bearer ${token}`)
      .buffer()
      .parse((r, cb) => { const cs: Buffer[] = []; r.on('data', (c) => cs.push(c)); r.on('end', () => cb(null, Buffer.concat(cs))); });

    // Get report_file_id before second call
    const { rows: before } = await query<{ report_file_id: string }>(
      'SELECT report_file_id FROM pedimentos WHERE id=$1', [pedimentoId]);
    const firstId = before[0].report_file_id;

    // Second call: should serve stored (report_file_id unchanged)
    await request(app)
      .get(`/api/pedimentos/${pedimentoId}/report.xlsx`)
      .set('Authorization', `Bearer ${token}`)
      .buffer()
      .parse((r, cb) => { const cs: Buffer[] = []; r.on('data', (c) => cs.push(c)); r.on('end', () => cb(null, Buffer.concat(cs))); });

    const { rows: after } = await query<{ report_file_id: string }>(
      'SELECT report_file_id FROM pedimentos WHERE id=$1', [pedimentoId]);
    expect(after[0].report_file_id).toBe(firstId);
  });
});
