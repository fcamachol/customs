import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { hashPassword } from '../../src/auth/password';
import { signToken } from '../../src/auth/token';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

const app = createApp();
let capturistaToken: string;
let autoridadToken: string;
let capId: string;
let manifestId: string;
let pedimentoId: string;

async function addPedimento(mId: string, fields: { fileId?: string | null; prevalidation?: object | null } = {}) {
  const r = await query<{ id: string }>(
    `INSERT INTO pedimentos (manifest_id, numero_pedimento, file_id, prevalidation, created_by)
     VALUES ($1,'111',$2,$3,$4) RETURNING id`,
    [mId, fields.fileId ?? null, fields.prevalidation ? JSON.stringify(fields.prevalidation) : null, capId],
  );
  return r.rows[0].id;
}

beforeEach(async () => {
  await truncateAll();
  const hash = await hashPassword('p');
  const capRes = await query(
    `INSERT INTO users (username,password_hash,role) VALUES ('cap',$1,'capturista') RETURNING id`,
    [hash],
  );
  capId = capRes.rows[0].id;
  capturistaToken = signToken({ userId: capId, role: 'capturista' , tv: 0 });

  const authRes = await query(
    `INSERT INTO users (username,password_hash,role) VALUES ('auth',$1,'autoridad') RETURNING id`,
    [hash],
  );
  autoridadToken = signToken({ userId: authRes.rows[0].id, role: 'autoridad' , tv: 0 });

  const mRes = await query(
    `INSERT INTO manifests (mawb_reference, client_name, created_by) VALUES ('TEST-001','Cliente Test',$1) RETURNING id`,
    [capId],
  );
  manifestId = mRes.rows[0].id;
  pedimentoId = await addPedimento(manifestId);
});

const IMPORT_DATA = {
  cveT1: 'A1',
  patente: '3250',
  agenteAduanal: 'Juan Pérez',
  tasaImportacion: '17.50',
  fechaEntrada: '2024-01-15',
  claveAduanaEntrada: '460',
  claveAduanaDespacho: '461',
};

describe('POST /api/pedimentos/:pedimentoId/import-data', () => {
  it('capturista saves import data → 200 and data persisted on the pedimentos row', async () => {
    const res = await request(app)
      .post(`/api/pedimentos/${pedimentoId}/import-data`)
      .set('Authorization', `Bearer ${capturistaToken}`)
      .send(IMPORT_DATA);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.importData.cveT1).toBe('A1');

    const { rows } = await query('SELECT import_data FROM pedimentos WHERE id=$1', [pedimentoId]);
    expect(rows[0].import_data.cveT1).toBe('A1');
    expect(rows[0].import_data.patente).toBe('3250');
    expect(rows[0].import_data.agenteAduanal).toBe('Juan Pérez');

    // The cutover stops writing manifests.import_data entirely.
    const m = await query('SELECT import_data FROM manifests WHERE id=$1', [manifestId]);
    expect(m.rows[0].import_data).toBeNull();
  });

  it('writes are isolated per-pedimento (sibling row untouched)', async () => {
    const otherId = await addPedimento(manifestId);
    const res = await request(app)
      .post(`/api/pedimentos/${pedimentoId}/import-data`)
      .set('Authorization', `Bearer ${capturistaToken}`)
      .send(IMPORT_DATA);
    expect(res.status).toBe(200);

    const target = await query('SELECT import_data FROM pedimentos WHERE id=$1', [pedimentoId]);
    expect(target.rows[0].import_data.cveT1).toBe('A1');
    const sibling = await query('SELECT import_data FROM pedimentos WHERE id=$1', [otherId]);
    expect(sibling.rows[0].import_data).toBeNull();
  });

  it('bumps version and rejects a stale optimistic write (version guard on the pedimentos row)', async () => {
    const first = await request(app)
      .post(`/api/pedimentos/${pedimentoId}/import-data`)
      .set('Authorization', `Bearer ${capturistaToken}`)
      .send({ ...IMPORT_DATA, version: 0 });
    expect(first.status).toBe(200);
    expect(first.body.version).toBe(1);

    const stale = await request(app)
      .post(`/api/pedimentos/${pedimentoId}/import-data`)
      .set('Authorization', `Bearer ${capturistaToken}`)
      .send({ ...IMPORT_DATA, version: 0 });
    expect(stale.status).toBe(409);
    expect(stale.body.conflict).toBe(true);
  });

  it('rejects edits with 409 once the pedimento row is locked (PDF attached)', async () => {
    const f = await query(
      `INSERT INTO files (kind, original_name, storage_path, size_bytes, uploaded_by) VALUES ('pedimento_pdf','p.pdf','/p',1,$1) RETURNING id`,
      [capId]);
    const lockedId = await addPedimento(manifestId, { fileId: f.rows[0].id });
    const res = await request(app)
      .post(`/api/pedimentos/${lockedId}/import-data`)
      .set('Authorization', `Bearer ${capturistaToken}`)
      .send(IMPORT_DATA);
    expect(res.status).toBe(409);
    expect(res.body.locked).toBe(true);
  });

  it('busts the cached report on the affected manifest but leaves risk_stale untouched', async () => {
    const f = await query(
      `INSERT INTO files (kind, original_name, storage_path, size_bytes, uploaded_by) VALUES ('risk_analysis','r.xlsx','/x',1,$1) RETURNING id`,
      [capId]);
    await query(`UPDATE manifests SET risk_file_id=$1, report_file_id=$1, risk_stale=false WHERE id=$2`, [f.rows[0].id, manifestId]);

    const res = await request(app)
      .post(`/api/pedimentos/${pedimentoId}/import-data`)
      .set('Authorization', `Bearer ${capturistaToken}`)
      .send({ ...IMPORT_DATA, version: 0 });
    expect(res.status).toBe(200);

    const m = await query(`SELECT report_file_id, risk_stale FROM manifests WHERE id=$1`, [manifestId]);
    // Report cache busted (regenerates from the new import-data)…
    expect(m.rows[0].report_file_id).toBeNull();
    // …but risk is per-manifest and no longer keyed on import_data: not flagged stale here.
    expect(m.rows[0].risk_stale).toBe(false);
  });

  it('autoridad token → 403 Forbidden', async () => {
    const res = await request(app)
      .post(`/api/pedimentos/${pedimentoId}/import-data`)
      .set('Authorization', `Bearer ${autoridadToken}`)
      .send(IMPORT_DATA);

    expect(res.status).toBe(403);
  });

  it('non-existent pedimento id → 404', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000000';
    const res = await request(app)
      .post(`/api/pedimentos/${fakeId}/import-data`)
      .set('Authorization', `Bearer ${capturistaToken}`)
      .send(IMPORT_DATA);

    expect(res.status).toBe(404);
  });
});
