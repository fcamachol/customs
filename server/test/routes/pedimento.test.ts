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

const PEDIMENTO_BODY = {
  numeroPedimento: '258516535001684',
  tipoCambio: 20.45,
  customsEntryCode: '4',
  customsClearanceCode: '850',
  entryDate: '2025-04-04',
  paymentDate: '2025-04-05',
  importer: { rfc: 'ADM130509UQ0', name: 'ADMERCE SA DE CV', fiscalAddress: 'CDMX' },
  agent: { patente: '1653', name: 'GUZMOR', agentRfc: 'GUMM710831UYA', agencyRfc: 'GLG1502247K9' },
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
    // Two shipments — guia g1 and g2. The pedimento covers only g1.
    const s1 = makeShipment('g1');
    const s2 = makeShipment('g2');
    await query('INSERT INTO shipments (id,manifest_id,data) VALUES ($1,$2,$3)', [s1.id, manifestId, JSON.stringify(s1)]);
    await query('INSERT INTO shipments (id,manifest_id,data) VALUES ($1,$2,$3)', [s2.id, manifestId, JSON.stringify(s2)]);

    // Insert a pedimento row covering only g1.
    const ped = await query(
      `INSERT INTO pedimentos (manifest_id, covered_guias, created_by) VALUES ($1,$2,$3) RETURNING id`,
      [manifestId, ['g1'], userId],
    );
    const pedimentoId = ped.rows[0].id;

    const res = await request(app)
      .post(`/api/pedimentos/${pedimentoId}/pedimento`)
      .set('Authorization', `Bearer ${token}`)
      .send(PEDIMENTO_BODY);

    expect(res.status).toBe(201);
    expect(res.body.prevalidation.status).toBe('APPROVED');
    // The built pedimento should contain only 1 partida (g1), not 2.
    expect(res.body.pedimento.partidas).toHaveLength(1);
    expect(res.body.pedimento.partidas[0].observation).toMatch(/^GUIA /);

    // Verify persisted on the pedimento row (not manifests).
    const row = await query<{ pedimento: unknown; prevalidation: { status?: string } }>(
      'SELECT pedimento, prevalidation FROM pedimentos WHERE id=$1', [pedimentoId]);
    expect(row.rows[0].prevalidation?.status).toBe('APPROVED');

    // manifests table should NOT have pedimento/prevalidation written.
    const mRow = await query<{ pedimento: unknown; prevalidation: unknown }>(
      'SELECT pedimento, prevalidation FROM manifests WHERE id=$1', [manifestId]);
    expect(mRow.rows[0].pedimento).toBeNull();
    expect(mRow.rows[0].prevalidation).toBeNull();
  });

  it('leaves sibling pedimento rows untouched when one pedimento is built', async () => {
    const s1 = makeShipment('g1');
    const s2 = makeShipment('g2');
    await query('INSERT INTO shipments (id,manifest_id,data) VALUES ($1,$2,$3)', [s1.id, manifestId, JSON.stringify(s1)]);
    await query('INSERT INTO shipments (id,manifest_id,data) VALUES ($1,$2,$3)', [s2.id, manifestId, JSON.stringify(s2)]);

    const ped1 = await query(
      `INSERT INTO pedimentos (manifest_id, covered_guias, created_by) VALUES ($1,$2,$3) RETURNING id`,
      [manifestId, ['g1'], userId],
    );
    const ped2 = await query(
      `INSERT INTO pedimentos (manifest_id, covered_guias, created_by) VALUES ($1,$2,$3) RETURNING id`,
      [manifestId, ['g2'], userId],
    );

    // Build only ped1.
    const res = await request(app)
      .post(`/api/pedimentos/${ped1.rows[0].id}/pedimento`)
      .set('Authorization', `Bearer ${token}`)
      .send(PEDIMENTO_BODY);
    expect(res.status).toBe(201);

    // ped2 must remain untouched (prevalidation still null).
    const sib = await query<{ prevalidation: unknown }>(
      'SELECT prevalidation FROM pedimentos WHERE id=$1', [ped2.rows[0].id]);
    expect(sib.rows[0].prevalidation).toBeNull();
  });

  it('returns 400 when covered_guias is empty (no shipments in subset)', async () => {
    const s = makeShipment('g1');
    await query('INSERT INTO shipments (id,manifest_id,data) VALUES ($1,$2,$3)', [s.id, manifestId, JSON.stringify(s)]);

    // Pedimento with no covered guías → empty subset.
    const ped = await query(
      `INSERT INTO pedimentos (manifest_id, covered_guias, created_by) VALUES ($1,$2,$3) RETURNING id`,
      [manifestId, [], userId],
    );

    const res = await request(app)
      .post(`/api/pedimentos/${ped.rows[0].id}/pedimento`)
      .set('Authorization', `Bearer ${token}`)
      .send(PEDIMENTO_BODY);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/No shipments/);
  });

  it('returns 400 when covered_guias is null (no shipments in subset)', async () => {
    const s = makeShipment('g1');
    await query('INSERT INTO shipments (id,manifest_id,data) VALUES ($1,$2,$3)', [s.id, manifestId, JSON.stringify(s)]);

    // Pedimento with null covered_guias → empty subset (coveredSet is empty).
    const ped = await query(
      `INSERT INTO pedimentos (manifest_id, covered_guias, created_by) VALUES ($1, NULL, $2) RETURNING id`,
      [manifestId, userId],
    );

    const res = await request(app)
      .post(`/api/pedimentos/${ped.rows[0].id}/pedimento`)
      .set('Authorization', `Bearer ${token}`)
      .send(PEDIMENTO_BODY);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/No shipments/);
  });

  it('returns 404 when pedimento row does not exist', async () => {
    const fakeId = crypto.randomUUID();
    const res = await request(app)
      .post(`/api/pedimentos/${fakeId}/pedimento`)
      .set('Authorization', `Bearer ${token}`)
      .send(PEDIMENTO_BODY);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it('returns 400 (not 500) when importer and agent are missing', async () => {
    const s = makeShipment('g1');
    await query('INSERT INTO shipments (id,manifest_id,data) VALUES ($1,$2,$3)', [s.id, manifestId, JSON.stringify(s)]);
    const ped = await query(
      `INSERT INTO pedimentos (manifest_id, covered_guias, created_by) VALUES ($1,$2,$3) RETURNING id`,
      [manifestId, ['g1'], userId],
    );

    const res = await request(app)
      .post(`/api/pedimentos/${ped.rows[0].id}/pedimento`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        numeroPedimento: '258516535001684', tipoCambio: 20.45,
        customsEntryCode: '4', customsClearanceCode: '850',
        entryDate: '2025-04-04', paymentDate: '2025-04-05',
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
    expect(JSON.stringify(res.body.details)).toMatch(/importer/);
  });
});
