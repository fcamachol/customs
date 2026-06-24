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
let manifestId: string;

beforeEach(async () => {
  await truncateAll();
  const hash = await hashPassword('p');
  const capRes = await query(
    `INSERT INTO users (username,password_hash,role) VALUES ('cap',$1,'capturista') RETURNING id`,
    [hash],
  );
  capturistaToken = signToken({ userId: capRes.rows[0].id, role: 'capturista' , tv: 0 });

  const authRes = await query(
    `INSERT INTO users (username,password_hash,role) VALUES ('auth',$1,'autoridad') RETURNING id`,
    [hash],
  );
  autoridadToken = signToken({ userId: authRes.rows[0].id, role: 'autoridad' , tv: 0 });

  const mRes = await query(
    `INSERT INTO manifests (mawb_reference, client_name) VALUES ('TEST-001','Cliente Test') RETURNING id`,
  );
  manifestId = mRes.rows[0].id;
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

describe('POST /api/manifests/:id/import-data', () => {
  it('capturista saves import data → 200 and data persisted in DB', async () => {
    const res = await request(app)
      .post(`/api/manifests/${manifestId}/import-data`)
      .set('Authorization', `Bearer ${capturistaToken}`)
      .send(IMPORT_DATA);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.importData.cveT1).toBe('A1');

    const { rows } = await query('SELECT import_data FROM manifests WHERE id=$1', [manifestId]);
    expect(rows[0].import_data.cveT1).toBe('A1');
    expect(rows[0].import_data.patente).toBe('3250');
    expect(rows[0].import_data.agenteAduanal).toBe('Juan Pérez');
  });

  it('autoridad token → 403 Forbidden', async () => {
    const res = await request(app)
      .post(`/api/manifests/${manifestId}/import-data`)
      .set('Authorization', `Bearer ${autoridadToken}`)
      .send(IMPORT_DATA);

    expect(res.status).toBe(403);
  });

  it('non-existent manifest id → 404', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000000';
    const res = await request(app)
      .post(`/api/manifests/${fakeId}/import-data`)
      .set('Authorization', `Bearer ${capturistaToken}`)
      .send(IMPORT_DATA);

    expect(res.status).toBe(404);
  });
});
