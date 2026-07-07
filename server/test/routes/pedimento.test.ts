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

// Seeds verified entity-catalog rows required for a warning-free APPROVED prevalidation. The
// pedimento resolves its agente by patente (1653, derivable from the numero) and its importador by
// import_data.importerRfc (ADM130509UQ0).
async function setEntities() {
  await query(
    `INSERT INTO importadores (rfc, name, fiscal_address, verified)
     VALUES ('ADM130509UQ0','ADMERCE SA DE CV','CDMX', true)
     ON CONFLICT (rfc) DO UPDATE SET verified=true, name=EXCLUDED.name, fiscal_address=EXCLUDED.fiscal_address`,
  );
  await query(
    `INSERT INTO agentes_aduanales (patente, name, agent_rfc, agency_rfc, verified)
     VALUES ('1653','GUZMOR','GUMM710831UYA','GLG1502247K9', true)
     ON CONFLICT (patente) DO UPDATE SET verified=true, name=EXCLUDED.name, agent_rfc=EXCLUDED.agent_rfc, agency_rfc=EXCLUDED.agency_rfc`,
  );
}

// Required import_data fields for prevalidation. importerRfc drives importador resolution; patente
// drives agente resolution (also re-derivable from the numero when absent).
const IMPORT_DATA = {
  tipoCambio: 20.45,
  claveAduanaEntrada: '850',
  claveAduanaDespacho: '850',
  fechaEntrada: '2025-04-04',
  paymentDate: '2025-04-05',
  importerRfc: 'ADM130509UQ0',
  patente: '1653',
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

  it('returns 400 naming the extraction gap when covered_guias is empty', async () => {
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
    expect(res.body.error).toMatch(/no tiene guías asignadas/);
    expect(res.body.reason).toBe('sin_guias_asignadas');
  });

  it('returns 400 naming the extraction gap when covered_guias is null', async () => {
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
    expect(res.body.error).toMatch(/no tiene guías asignadas/);
    expect(res.body.reason).toBe('sin_guias_asignadas');
  });

  it('returns 400 naming the empty manifest when it has no shipments at all', async () => {
    await setEntities();
    // No shipments seeded — the manifest is empty even though the pedimento declares guías.
    const ped = await query(
      `INSERT INTO pedimentos (manifest_id, numero_pedimento, covered_guias, created_by, sub_status, import_data) VALUES ($1,'258516535001684',$2,$3,'capturado',$4) RETURNING id`,
      [manifestId, ['g1'], userId, JSON.stringify(IMPORT_DATA)],
    );

    const res = await request(app)
      .post(`/api/pedimentos/${ped.rows[0].id}/pedimento`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/manifiesto no tiene guías/);
    expect(res.body.reason).toBe('manifiesto_sin_guias');
  });

  it('returns 400 listing the unmatched guías when covered_guias match no manifest shipment', async () => {
    await setEntities();
    const s = makeShipment('g1');
    await query('INSERT INTO shipments (id,manifest_id,data) VALUES ($1,$2,$3)', [s.id, manifestId, JSON.stringify(s)]);

    // covered_guias formatted differently from the shipment guideId → exact-match intersection empty.
    const ped = await query(
      `INSERT INTO pedimentos (manifest_id, numero_pedimento, covered_guias, created_by, sub_status, import_data) VALUES ($1,'258516535001684',$2,$3,'capturado',$4) RETURNING id`,
      [manifestId, ['G-1', 'G-2'], userId, JSON.stringify(IMPORT_DATA)],
    );

    const res = await request(app)
      .post(`/api/pedimentos/${ped.rows[0].id}/pedimento`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no coinciden/);
    expect(res.body.error).toContain('G-1');
    expect(res.body.error).toContain('g1'); // shows manifest guías so the mismatch is visible
    expect(res.body.reason).toBe('guias_no_coinciden');
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

  it('returns 422 naming the RFC when the importer RFC is unavailable to resolve with', async () => {
    // No importerRfc in import_data → importador cannot be resolved. Patente is still derivable
    // from the numero, so only the RFC is missing and the message says so.
    const s = makeShipment('G1');
    await query('INSERT INTO shipments (id,manifest_id,data) VALUES ($1,$2,$3)', [s.id, manifestId, JSON.stringify(s)]);
    const { importerRfc: _drop, ...noRfc } = IMPORT_DATA;
    const pid = (await query(
      `INSERT INTO pedimentos (manifest_id, numero_pedimento, covered_guias, created_by, sub_status, import_data)
       VALUES ($1,'258516535001684',$2,$3,'capturado',$4) RETURNING id`,
      [manifestId, [s.guideId], userId, JSON.stringify(noRfc)])).rows[0].id;
    const res = await request(app).post(`/api/pedimentos/${pid}/pedimento`).set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/RFC del importador/i);
  });

  it('returns 422 naming the patente when no patente can be resolved (non-15-digit numero)', async () => {
    // numero is not 15 digits so patente cannot be derived, and import_data omits patente.
    const s = makeShipment('G1');
    await query('INSERT INTO shipments (id,manifest_id,data) VALUES ($1,$2,$3)', [s.id, manifestId, JSON.stringify(s)]);
    const { patente: _dropP, ...noPatente } = IMPORT_DATA;
    const pid = (await query(
      `INSERT INTO pedimentos (manifest_id, numero_pedimento, covered_guias, created_by, sub_status, import_data)
       VALUES ($1,'123',$2,$3,'capturado',$4) RETURNING id`,
      [manifestId, [s.guideId], userId, JSON.stringify(noPatente)])).rows[0].id;
    const res = await request(app).post(`/api/pedimentos/${pid}/pedimento`).set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/patente/i);
  });

  it('auto-creates unresolved entities (unverified) and warns on them, still APPROVED', async () => {
    // No setEntities() — the entity rows do not exist yet. The route auto-registers them (unverified)
    // from import_data and adds a prevalidation warning naming each unverified entity.
    const s = makeShipment('g1');
    await query('INSERT INTO shipments (id,manifest_id,data) VALUES ($1,$2,$3)', [s.id, manifestId, JSON.stringify(s)]);
    const pid = (await query(
      `INSERT INTO pedimentos (manifest_id, numero_pedimento, covered_guias, created_by, sub_status, import_data)
       VALUES ($1,'258516535001684',$2,$3,'capturado',$4) RETURNING id`,
      [manifestId, ['g1'], userId, JSON.stringify(IMPORT_DATA)])).rows[0].id;
    const res = await request(app).post(`/api/pedimentos/${pid}/pedimento`).set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(201);
    expect(res.body.prevalidation.status).toBe('APPROVED');
    const w = res.body.prevalidation.warnings.join(' ');
    expect(w).toMatch(/agente aduanal.*sin verificar/i);
    expect(w).toMatch(/importador.*sin verificar/i);

    // The rows now exist, keyed by patente/rfc, unverified.
    const ag = await query<{ verified: boolean }>(`SELECT verified FROM agentes_aduanales WHERE patente='1653'`);
    expect(ag.rows[0].verified).toBe(false);
    const im = await query<{ verified: boolean }>(`SELECT verified FROM importadores WHERE rfc='ADM130509UQ0'`);
    expect(im.rows[0].verified).toBe(false);
  });

  it('warns (not errors) when the agente has no agencyRfc — APPROVED', async () => {
    // Verified importador + agente, but the agente row has a NULL agency_rfc → build passes '' →
    // prevalidatePedimento warns instead of erroring, so the pedimento is still APPROVED.
    await query(
      `INSERT INTO importadores (rfc, name, fiscal_address, verified) VALUES ('ADM130509UQ0','ADMERCE','CDMX', true)`,
    );
    await query(
      `INSERT INTO agentes_aduanales (patente, name, agent_rfc, agency_rfc, verified)
       VALUES ('1653','GUZMOR','GUMM710831UYA', NULL, true)`,
    );
    const s = makeShipment('g1');
    await query('INSERT INTO shipments (id,manifest_id,data) VALUES ($1,$2,$3)', [s.id, manifestId, JSON.stringify(s)]);
    const pid = (await query(
      `INSERT INTO pedimentos (manifest_id, numero_pedimento, covered_guias, created_by, sub_status, import_data)
       VALUES ($1,'258516535001684',$2,$3,'capturado',$4) RETURNING id`,
      [manifestId, ['g1'], userId, JSON.stringify(IMPORT_DATA)])).rows[0].id;
    const res = await request(app).post(`/api/pedimentos/${pid}/pedimento`).set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(201);
    expect(res.body.prevalidation.status).toBe('APPROVED');
    expect(res.body.prevalidation.warnings.join(' ')).toMatch(/agencia.*no disponible/i);
    expect(res.body.prevalidation.errors.join(' ')).not.toMatch(/agencia/i);
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
