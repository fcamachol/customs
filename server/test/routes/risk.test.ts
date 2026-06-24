import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { hashPassword } from '../../src/auth/password';
import { signToken } from '../../src/auth/token';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

const app = createApp();
let token: string; let manifestId: string;

async function addShipment(name: string, value: number, guideId = name, tableId?: string) {
  // Allow caller to supply an explicit table PK that differs from the data's `id` field
  // to test the PK-fix regression (see "PK-fix regression" test below).
  const dataId = crypto.randomUUID(); // the id INSIDE the JSON data
  const pkId = tableId ?? crypto.randomUUID(); // the table primary key
  const s = {
    id: dataId, mawbReference: '369-1', description: 'camisa', hsCode: '9901000100',
    quantity: 1, unit: 'PCE', customsValueUsd: value, currency: 'USD', originCountry: 'CN', guideId,
    consignee: { name, rfc: 'PERJ800101AA8', address: 'Calle 1' }, sender: { name: 'S' }, platform: { commercialName: 'P' },
  };
  await query('INSERT INTO shipments (id, manifest_id, data) VALUES ($1,$2,$3)', [pkId, manifestId, JSON.stringify(s)]);
  return { pkId, dataId };
}

beforeEach(async () => {
  await truncateAll();
  const hash = await hashPassword('p');
  const u = await query(`INSERT INTO users (username,password_hash,role) VALUES ('c',$1,'capturista') RETURNING id`, [hash]);
  token = signToken({ userId: u.rows[0].id, role: 'capturista' , tv: 0 });
  const m = await query(`INSERT INTO manifests (mawb_reference) VALUES ('369-1') RETURNING id`);
  manifestId = m.rows[0].id;
});

describe('POST /api/manifests/:id/risk', () => {
  it('scores shipments, persists color, returns table + summary', async () => {
    await addShipment('Ana', 100);
    await addShipment('Bad', 5000);
    const res = await request(app)
      .post(`/api/manifests/${manifestId}/risk`)
      .set('Authorization', `Bearer ${token}`)
      .send({ period: '2025-02' });
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(2);
    expect(res.body.summary.analizados).toBe(2);
    const persisted = await query('SELECT risk_color FROM shipments WHERE risk_color IS NOT NULL');
    expect(persisted.rows.length).toBe(2);
  });

  it('summary exposes 3-bucket PRD shape: analizados, aprobados, noIdentificados, validarEnPrevio', async () => {
    await addShipment('Verde', 100, 'g-verde');
    const res = await request(app)
      .post(`/api/manifests/${manifestId}/risk`)
      .set('Authorization', `Bearer ${token}`)
      .send({ period: '2025-02' });
    expect(res.status).toBe(200);
    const s = res.body.summary;
    expect(s).toHaveProperty('analizados');
    expect(s).toHaveProperty('aprobados');
    expect(s).toHaveProperty('noIdentificados');
    expect(s).toHaveProperty('validarEnPrevio');
    expect(s).not.toHaveProperty('rojos');
  });

  it('summary includes sinDatos bucket for gris shipments', async () => {
    // A shipment with no description/value/id triggers gris band
    const pkId = crypto.randomUUID();
    const s = {
      id: crypto.randomUUID(), mawbReference: '369-1', description: '', hsCode: '',
      quantity: 1, unit: 'PCE', customsValueUsd: NaN, currency: 'USD', originCountry: 'CN', guideId: 'gris-1',
      consignee: { name: 'SinDatos', address: 'X' }, sender: { name: 'S' }, platform: { commercialName: 'P' },
    };
    await query('INSERT INTO shipments (id, manifest_id, data) VALUES ($1,$2,$3)', [pkId, manifestId, JSON.stringify(s)]);
    const res = await request(app)
      .post(`/api/manifests/${manifestId}/risk`)
      .set('Authorization', `Bearer ${token}`)
      .send({ period: '2025-02' });
    expect(res.status).toBe(200);
    expect(res.body.summary).toHaveProperty('sinDatos');
  });

  it('persists ruleset_version on the manifest', async () => {
    await addShipment('Ana', 100);
    await request(app)
      .post(`/api/manifests/${manifestId}/risk`)
      .set('Authorization', `Bearer ${token}`)
      .send({ period: '2025-02' });
    const { rows } = await query<{ ruleset_version: string }>(
      'SELECT ruleset_version FROM manifests WHERE id=$1', [manifestId]);
    expect(rows[0].ruleset_version).toBe('2026-06');
  });

  it('persists risk_reasons and ruleset_hash (non-null) after a run', async () => {
    await addShipment('Ana', 100);
    const res = await request(app)
      .post(`/api/manifests/${manifestId}/risk`)
      .set('Authorization', `Bearer ${token}`)
      .send({ period: '2025-02' });
    expect(res.status).toBe(200);
    const { rows } = await query<{ risk_reasons: unknown; ruleset_hash: string }>(
      'SELECT risk_reasons, ruleset_hash FROM shipments WHERE manifest_id=$1', [manifestId]);
    expect(rows.length).toBeGreaterThan(0);
    // risk_reasons must be a non-null array (may be empty for a clean shipment)
    for (const row of rows) {
      expect(Array.isArray(row.risk_reasons)).toBe(true);
      expect(typeof row.ruleset_hash).toBe('string');
      expect(row.ruleset_hash.length).toBeGreaterThan(0);
    }
  });

  it('response rows include resultado (band) and resultadoLegacy (parity verdict)', async () => {
    await addShipment('Ana', 100);
    const res = await request(app)
      .post(`/api/manifests/${manifestId}/risk`)
      .set('Authorization', `Bearer ${token}`)
      .send({ period: '2025-02' });
    expect(res.status).toBe(200);
    for (const row of res.body.rows) {
      expect(row).toHaveProperty('resultado');
      expect(row).toHaveProperty('resultadoLegacy');
      // engine resultado is lowercase band; legacy is title-case
      expect(['verde', 'amarillo', 'rojo', 'gris']).toContain(row.resultado);
      expect(['Verde', 'Amarillo', 'Rojo']).toContain(row.resultadoLegacy);
    }
  });

  it('bbdd regression: cross-manifest monthly recurrence fires for RFC-bearing consignee (Ficha-124)', async () => {
    // RED evidence (before fix): the server stored history keyed by norm(name) but
    // classify.ts seeded entityMonthlyCount by entityKey (RFC), so lookup never matched.
    // A consignee with RFC 'PERJ800101AA8' and 3 prior ops + 1 current → total 4 → bbdd
    // MUST fire. This test would have FAILED before the name-keying fix.

    // Seed a prior manifest's history: "recurrente" seen 3× in same period
    const priorManifest = await query(`INSERT INTO manifests (mawb_reference) VALUES ('369-prior') RETURNING id`);
    const priorId = priorManifest.rows[0].id as string;
    await query(
      `INSERT INTO monthly_history (consignee_name_norm, period, manifest_id, seen_count)
       VALUES ('recurrente', '2025-06', $1, 3)`,
      [priorId],
    );

    // Current manifest has 1 shipment from the same consignee (name normalizes to 'recurrente')
    await addShipment('Recurrente', 100, 'g-bbdd');

    const res = await request(app)
      .post(`/api/manifests/${manifestId}/risk`)
      .set('Authorization', `Bearer ${token}`)
      .send({ period: '2025-06' });

    expect(res.status).toBe(200);
    const row = res.body.rows.find((r: { consignee: string }) => r.consignee === 'Recurrente');
    expect(row).toBeDefined();
    // Must carry the bbdd incidence or a non-verde band attributable to bbdd
    const hasRecurrence = (row.motivo as string).includes('Varias importaciones en el mes');
    expect(hasRecurrence).toBe(true);
  });

  it('PK-fix regression: risk_color is persisted to the correct table row when data.id != table PK', async () => {
    // Insert a shipment where the table row PK differs from the id field inside the JSON data.
    // Before the fix, the UPDATE used sc.shipment.id (data JSON field) in WHERE id=...,
    // which would not match the table row and the risk_color would remain NULL.
    const explicitPkId = crypto.randomUUID();
    // addShipment with tableId causes pkId (table row PK) != dataId (data.id JSON field)
    const { pkId } = await addShipment('TestPkFix', 200, 'pk-fix-guide', explicitPkId);

    const res = await request(app)
      .post(`/api/manifests/${manifestId}/risk`)
      .set('Authorization', `Bearer ${token}`)
      .send({ period: '2025-02' });
    expect(res.status).toBe(200);

    // Assert the TABLE ROW (by table PK) now has risk_color set
    const { rows } = await query<{ risk_color: string | null }>(
      'SELECT risk_color FROM shipments WHERE id=$1', [pkId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].risk_color).not.toBeNull();
    expect(['verde', 'amarillo', 'rojo', 'gris']).toContain(rows[0].risk_color);
  });
});
