import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { hashPassword } from '../../src/auth/password';
import { signToken } from '../../src/auth/token';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

const app = createApp();
let token: string;
let manifestId: string;
let userId: string;

// A minimal valid shipment shape for the shipments.data column.
function makeShipment(guideId: string) {
  return {
    id: crypto.randomUUID(),
    mawbReference: '369-1',
    description: 'TRAJE',
    hsCode: '99010001',
    quantity: 1,
    unit: '6',
    customsValueUsd: 120,
    currency: 'USD',
    originCountry: 'CHN',
    guideId,
    consignee: { name: 'Juan', rfc: 'TOMM020922D40' },
    sender: { name: 'S' },
    platform: { commercialName: 'P' },
  };
}

// A shipment whose value exceeds the $2500 USD cap → causes REJECTED prevalidation.
function makeExpensiveShipment(guideId: string) {
  return {
    id: crypto.randomUUID(),
    mawbReference: '369-1',
    description: 'BOLSO DE LUJO',
    hsCode: '99010001',
    quantity: 1,
    unit: '6',
    customsValueUsd: 3000,
    currency: 'USD',
    originCountry: 'ITA',
    guideId,
    consignee: { name: 'Juan', rfc: 'TOMM020922D40' },
    sender: { name: 'S' },
    platform: { commercialName: 'P' },
  };
}

// Seeds config entities required for prevalidation.
async function setEntities() {
  await query(
    `INSERT INTO config (key,value) VALUES ('importer_of_record',$1) ON CONFLICT (key) DO UPDATE SET value=$1`,
    [JSON.stringify({ rfc: 'ADM130509UQ0', name: 'ADMERCE SA DE CV', fiscalAddress: 'CDMX' })],
  );
  await query(
    `INSERT INTO config (key,value) VALUES ('customs_agent',$1) ON CONFLICT (key) DO UPDATE SET value=$1`,
    [JSON.stringify({ patente: '1653', name: 'GUZMOR', agentRfc: 'GUMM710831UYA', agencyRfc: 'GLG1502247K9' })],
  );
}

// Required import_data fields for prevalidation.
const IMPORT_DATA = {
  tipoCambio: 20.45,
  claveAduanaEntrada: '850',
  claveAduanaDespacho: '850',
  fechaEntrada: '2025-04-04',
  paymentDate: '2025-04-05',
};

beforeEach(async () => {
  await truncateAll();
  const hash = await hashPassword('p');
  const u = await query(`INSERT INTO users (username,password_hash,role) VALUES ('a',$1,'admin') RETURNING id`, [hash]);
  userId = u.rows[0].id;
  token = signToken({ userId, role: 'admin', tv: 0 });
  const m = await query(`INSERT INTO manifests (mawb_reference) VALUES ('369-1') RETURNING id`);
  manifestId = m.rows[0].id;
});

describe('POST /api/pedimentos/:pedimentoId/pedimento', () => {
  it('builds over covered_guias subset, persists on pedimento row, returns prevalidation', async () => {
    await setEntities();
    // Two shipments — guia g1 and g2. The pedimento covers only g1.
    const s1 = makeShipment('g1');
    const s2 = makeShipment('g2');
    await query('INSERT INTO shipments (id,manifest_id,data) VALUES ($1,$2,$3)', [s1.id, manifestId, JSON.stringify(s1)]);
    await query('INSERT INTO shipments (id,manifest_id,data) VALUES ($1,$2,$3)', [s2.id, manifestId, JSON.stringify(s2)]);

    // Insert a pedimento row covering only g1 — seeded as 'capturado' to pass the lifecycle guard.
    const ped = await query(
      `INSERT INTO pedimentos (manifest_id, numero_pedimento, covered_guias, created_by, sub_status, import_data) VALUES ($1,'258516535001684',$2,$3,'capturado',$4) RETURNING id`,
      [manifestId, ['g1'], userId, JSON.stringify(IMPORT_DATA)],
    );
    const pedimentoId = ped.rows[0].id;

    const res = await request(app)
      .post(`/api/pedimentos/${pedimentoId}/pedimento`)
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(201);
    expect(res.body.prevalidation.status).toBe('APPROVED');
    // The built pedimento should contain only 1 partida (g1), not 2.
    expect(res.body.pedimento.partidas).toHaveLength(1);
    expect(res.body.pedimento.partidas[0].observation).toMatch(/^GUIA /);

    // Verify persisted on the pedimento row (not manifests).
    const row = await query<{ pedimento: unknown; prevalidation: { status?: string } }>(
      'SELECT pedimento, prevalidation FROM pedimentos WHERE id=$1', [pedimentoId]);
    expect(row.rows[0].prevalidation?.status).toBe('APPROVED');

    // manifests.pedimento and manifests.prevalidation were dropped in Task 11 — schema enforces it.
  });

  it('leaves sibling pedimento rows untouched when one pedimento is built', async () => {
    await setEntities();
    const s1 = makeShipment('g1');
    const s2 = makeShipment('g2');
    await query('INSERT INTO shipments (id,manifest_id,data) VALUES ($1,$2,$3)', [s1.id, manifestId, JSON.stringify(s1)]);
    await query('INSERT INTO shipments (id,manifest_id,data) VALUES ($1,$2,$3)', [s2.id, manifestId, JSON.stringify(s2)]);

    // Seed ped1 as 'capturado' so it can be built; ped2 can remain default 'pendiente'.
    const ped1 = await query(
      `INSERT INTO pedimentos (manifest_id, numero_pedimento, covered_guias, created_by, sub_status, import_data) VALUES ($1,'258516535001684',$2,$3,'capturado',$4) RETURNING id`,
      [manifestId, ['g1'], userId, JSON.stringify(IMPORT_DATA)],
    );
    const ped2 = await query(
      `INSERT INTO pedimentos (manifest_id, covered_guias, created_by) VALUES ($1,$2,$3) RETURNING id`,
      [manifestId, ['g2'], userId],
    );

    // Build only ped1.
    const res = await request(app)
      .post(`/api/pedimentos/${ped1.rows[0].id}/pedimento`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(201);

    // ped2 must remain untouched (prevalidation still null).
    const sib = await query<{ prevalidation: unknown }>(
      'SELECT prevalidation FROM pedimentos WHERE id=$1', [ped2.rows[0].id]);
    expect(sib.rows[0].prevalidation).toBeNull();
  });

  it('returns 400 when covered_guias is empty (no shipments in subset)', async () => {
    await setEntities();
    const s = makeShipment('g1');
    await query('INSERT INTO shipments (id,manifest_id,data) VALUES ($1,$2,$3)', [s.id, manifestId, JSON.stringify(s)]);

    // Pedimento with no covered guías → empty subset.
    const ped = await query(
      `INSERT INTO pedimentos (manifest_id, numero_pedimento, covered_guias, created_by, sub_status, import_data) VALUES ($1,'258516535001684',$2,$3,'capturado',$4) RETURNING id`,
      [manifestId, [], userId, JSON.stringify(IMPORT_DATA)],
    );

    const res = await request(app)
      .post(`/api/pedimentos/${ped.rows[0].id}/pedimento`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/No shipments/);
  });

  it('returns 400 when covered_guias is null (no shipments in subset)', async () => {
    await setEntities();
    const s = makeShipment('g1');
    await query('INSERT INTO shipments (id,manifest_id,data) VALUES ($1,$2,$3)', [s.id, manifestId, JSON.stringify(s)]);

    // Pedimento with null covered_guias → empty subset (coveredSet is empty).
    const ped = await query(
      `INSERT INTO pedimentos (manifest_id, numero_pedimento, covered_guias, created_by, sub_status, import_data) VALUES ($1,'258516535001684', NULL, $2,'capturado',$3) RETURNING id`,
      [manifestId, userId, JSON.stringify(IMPORT_DATA)],
    );

    const res = await request(app)
      .post(`/api/pedimentos/${ped.rows[0].id}/pedimento`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/No shipments/);
  });

  it('returns 404 when pedimento row does not exist', async () => {
    const fakeId = crypto.randomUUID();
    const res = await request(app)
      .post(`/api/pedimentos/${fakeId}/pedimento`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it('returns 422 when entities are not configured', async () => {
    // No setEntities() call — config rows absent.
    const s = makeShipment('G1');
    await query('INSERT INTO shipments (id,manifest_id,data) VALUES ($1,$2,$3)', [s.id, manifestId, JSON.stringify(s)]);
    const pid = (await query(
      `INSERT INTO pedimentos (manifest_id, numero_pedimento, covered_guias, created_by, sub_status, import_data)
       VALUES ($1,'258516535001684',$2,$3,'capturado',$4) RETURNING id`,
      [manifestId, [s.guideId], userId, JSON.stringify(IMPORT_DATA)])).rows[0].id;
    const res = await request(app).post(`/api/pedimentos/${pid}/pedimento`).set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(422);
  });

  it('returns 409 when pedimento sub_status is pendiente (lifecycle guard)', async () => {
    await setEntities();
    const s = makeShipment('g1');
    await query('INSERT INTO shipments (id,manifest_id,data) VALUES ($1,$2,$3)', [s.id, manifestId, JSON.stringify(s)]);

    // Insert row with default sub_status='pendiente' — not yet captured.
    const ped = await query(
      `INSERT INTO pedimentos (manifest_id, numero_pedimento, covered_guias, created_by, import_data) VALUES ($1,'258516535001684',$2,$3,$4) RETURNING id`,
      [manifestId, ['g1'], userId, JSON.stringify(IMPORT_DATA)],
    );

    const res = await request(app)
      .post(`/api/pedimentos/${ped.rows[0].id}/pedimento`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBeTruthy();
  });

  it('prevalidación APPROVED assembles the body from import_data + config entities', async () => {
    await setEntities();
    const s1 = makeShipment('G1');
    await query('INSERT INTO shipments (id,manifest_id,data) VALUES ($1,$2,$3)', [s1.id, manifestId, JSON.stringify(s1)]);
    const pid = (await query(
      `INSERT INTO pedimentos (manifest_id, numero_pedimento, covered_guias, created_by, sub_status, import_data)
       VALUES ($1,'258516535001684',$2,$3,'capturado',$4) RETURNING id`,
      [manifestId, [s1.guideId], userId, JSON.stringify(IMPORT_DATA)])).rows[0].id;
    const res = await request(app).post(`/api/pedimentos/${pid}/pedimento`).set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(201);
    expect(res.body.prevalidation.status).toBe('APPROVED');
    expect((await query(`SELECT sub_status FROM pedimentos WHERE id=$1`, [pid])).rows[0].sub_status).toBe('prevalidado');
  });

  it('returns 422 when tipoCambio is 0 (zero exchange rate treated as missing)', async () => {
    await setEntities();
    const s = makeShipment('g1');
    await query('INSERT INTO shipments (id,manifest_id,data) VALUES ($1,$2,$3)', [s.id, manifestId, JSON.stringify(s)]);

    // Seed import_data with tipoCambio=0 — all other required fields are present.
    const dataWithZeroTasa = { ...IMPORT_DATA, tipoCambio: 0 };
    const ped = await query(
      `INSERT INTO pedimentos (manifest_id, numero_pedimento, covered_guias, created_by, sub_status, import_data) VALUES ($1,'258516535001684',$2,$3,'capturado',$4) RETURNING id`,
      [manifestId, ['g1'], userId, JSON.stringify(dataWithZeroTasa)],
    );

    const res = await request(app)
      .post(`/api/pedimentos/${ped.rows[0].id}/pedimento`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/tipoCambio/);
  });

  it('prevalidación REJECTED sets sub_status=rechazado', async () => {
    await setEntities();
    // Use a shipment with customsValueUsd > $2500 to trigger REJECTED prevalidation.
    const s = makeExpensiveShipment('g1');
    await query('INSERT INTO shipments (id,manifest_id,data) VALUES ($1,$2,$3)', [s.id, manifestId, JSON.stringify(s)]);

    // Seed as capturado so it can be prevalidated.
    const ped = await query(
      `INSERT INTO pedimentos (manifest_id, numero_pedimento, covered_guias, created_by, sub_status, import_data) VALUES ($1,'258516535001684',$2,$3,'capturado',$4) RETURNING id`,
      [manifestId, ['g1'], userId, JSON.stringify(IMPORT_DATA)],
    );
    const pedimentoId = ped.rows[0].id;

    const res = await request(app)
      .post(`/api/pedimentos/${pedimentoId}/pedimento`)
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(201);
    expect(res.body.prevalidation.status).toBe('REJECTED');

    // sub_status must be updated to 'rechazado'.
    const row = await query<{ sub_status: string }>(
      'SELECT sub_status FROM pedimentos WHERE id=$1', [pedimentoId]);
    expect(row.rows[0].sub_status).toBe('rechazado');
  });
});
