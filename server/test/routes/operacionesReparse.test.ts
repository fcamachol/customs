/**
 * Route tests for POST /api/operaciones/:id/reparse.
 *
 * Exists because of a real production incident: two live prealertas carried a parse produced by
 * parser 2026-08b, minutes before the fix (2026-08c) deployed, and the UI rendered
 * `PA-01 — error — [object Object]` from a stale, wrong `cartones` value baked into the stored
 * discrepancias. This route is the healing path — re-run the CURRENT parser against the LATEST
 * stored prealerta and, where a manifest is attached, re-run the manifest cotejo too.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../../src/app';
import { signToken, type Role } from '../../src/auth/token';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';
import { PREALERTA_PARSER_VERSION } from '../../../shared/operaciones/prealerta';
import { normGuia } from '../../../shared/pedimento/guia';

const app = createApp();

// Calibrated against the live incident subject (shared/operaciones/prealerta.ts normalizeInbound
// docstring): full-width colons (U+FF1A) after ETD/ETA and `//`-delimited fields.
const SUBJECT =
  'iMile// 160-05930216 //ETD：07 Ago 06:00//ETA：07Ago 09:45 ETA//64 CTNS/ 2914 PCS/ 542.86 KGS';
const MAWB_RAW = '160-05930216';
const MAWB = normGuia(MAWB_RAW);
const STALE_PARSER_VERSION = '2026-08b';

beforeEach(async () => {
  await truncateAll();
});

async function seedUser(role: Role): Promise<{ id: string; token: string }> {
  const { rows } = await query<{ id: string; token_version: number }>(
    `INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', $2)
       RETURNING id, token_version`,
    [`reparse-${role}-${randomUUID()}`, role],
  );
  return { id: rows[0].id, token: signToken({ userId: rows[0].id, role, tv: rows[0].token_version }) };
}

/** Seed an operación (with the stale 6-cartones parse) and its prealerta carrying the live subject. */
async function seedOperacionConPrealerta(
  opts: { manifestId?: string | null; discrepancias?: unknown[] | null } = {},
): Promise<{ operacionId: string; prealertaId: string }> {
  const { rows: opRows } = await query<{ id: string }>(
    `INSERT INTO operaciones (mawb, mawb_raw, cartones_prealerta, manifest_id, discrepancias)
       VALUES ($1, $2, 6, $3, $4::jsonb)
       RETURNING id`,
    [MAWB, MAWB_RAW, opts.manifestId ?? null, opts.discrepancias ? JSON.stringify(opts.discrepancias) : null],
  );
  const operacionId = opRows[0].id;

  const { rows: preRows } = await query<{ id: string }>(
    `INSERT INTO prealertas (operacion_id, version, asunto, cuerpo_texto, parsed, parser_version, estado)
       VALUES ($1, 1, $2, '', $3::jsonb, $4, 'parseada')
       RETURNING id`,
    [
      operacionId,
      SUBJECT,
      JSON.stringify({ fields: { mawb: MAWB, mawbRaw: MAWB_RAW, cartones: 6 }, provenance: {}, warnings: [] }),
      STALE_PARSER_VERSION,
    ],
  );
  return { operacionId, prealertaId: preRows[0].id };
}

async function seedManifest(): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO manifests (mawb_reference) VALUES ($1) RETURNING id`,
    [`MAWB-${randomUUID()}`],
  );
  return rows[0].id;
}

async function seedShipment(manifestId: string, data: Record<string, unknown>): Promise<void> {
  await query(`INSERT INTO shipments (id, manifest_id, data) VALUES ($1, $2, $3::jsonb)`, [
    randomUUID(),
    manifestId,
    JSON.stringify(data),
  ]);
}

describe('POST /api/operaciones/:id/reparse — gates', () => {
  it('404 for an unknown operación id', async () => {
    const admin = await seedUser('admin');
    const res = await request(app)
      .post(`/api/operaciones/${randomUUID()}/reparse`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(404);
  });

  it('409 when the operación has no prealertas', async () => {
    const admin = await seedUser('admin');
    const { rows } = await query<{ id: string }>(
      `INSERT INTO operaciones (mawb) VALUES ($1) RETURNING id`,
      [`sin-prealerta-${randomUUID()}`],
    );
    const res = await request(app)
      .post(`/api/operaciones/${rows[0].id}/reparse`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no tiene prealertas/);
  });

  it('allows capturista', async () => {
    const capturista = await seedUser('capturista');
    const { operacionId } = await seedOperacionConPrealerta();
    const res = await request(app)
      .post(`/api/operaciones/${operacionId}/reparse`)
      .set('Authorization', `Bearer ${capturista.token}`);
    expect(res.status).toBe(200);
  });

  it('forbids autoridad', async () => {
    const autoridad = await seedUser('autoridad');
    const { operacionId } = await seedOperacionConPrealerta();
    const res = await request(app)
      .post(`/api/operaciones/${operacionId}/reparse`)
      .set('Authorization', `Bearer ${autoridad.token}`);
    expect(res.status).toBe(403);
  });

  it('401 with no token', async () => {
    const { operacionId } = await seedOperacionConPrealerta();
    const res = await request(app).post(`/api/operaciones/${operacionId}/reparse`);
    expect(res.status).toBe(401);
  });
});

describe('POST /api/operaciones/:id/reparse — heals the stored parse', () => {
  it('re-parses the latest prealerta, bumps parser_version, and overwrites operaciones fields', async () => {
    const admin = await seedUser('admin');
    const { operacionId, prealertaId } = await seedOperacionConPrealerta();

    const res = await request(app)
      .post(`/api/operaciones/${operacionId}/reparse`)
      .set('Authorization', `Bearer ${admin.token}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, parserVersion: PREALERTA_PARSER_VERSION });
    expect(res.body.fields).toMatchObject({ cartones: 64, piezas: 2914, pesoKg: 542.86 });
    expect(typeof res.body.warnings).toBe('number');
    expect(typeof res.body.discrepancias).toBe('number');

    const pre = await query<{ parser_version: string }>(
      `SELECT parser_version FROM prealertas WHERE id = $1`,
      [prealertaId],
    );
    expect(pre.rows[0].parser_version).toBe(PREALERTA_PARSER_VERSION);

    const op = await query<{
      cartones_prealerta: number; piezas_prealerta: number; peso_kg_prealerta: string;
      etd_origen: string | null; eta_pais: string | null;
    }>(
      `SELECT cartones_prealerta, piezas_prealerta, peso_kg_prealerta, etd_origen, eta_pais
         FROM operaciones WHERE id = $1`,
      [operacionId],
    );
    expect(op.rows[0].cartones_prealerta).toBe(64);
    expect(op.rows[0].piezas_prealerta).toBe(2914);
    expect(Number(op.rows[0].peso_kg_prealerta)).toBeCloseTo(542.86, 2);
    expect(op.rows[0].etd_origen).not.toBeNull();
    expect(op.rows[0].eta_pais).not.toBeNull();
  });

  it('writes a COTEJO_EJECUTADO ledger event with payload.reproceso true', async () => {
    const admin = await seedUser('admin');
    const { operacionId } = await seedOperacionConPrealerta();

    await request(app).post(`/api/operaciones/${operacionId}/reparse`).set('Authorization', `Bearer ${admin.token}`);

    const ev = await query<{ payload: { reproceso?: boolean; parserVersionDespues?: string } }>(
      `SELECT payload FROM operacion_eventos
        WHERE operacion_id = $1 AND tipo = 'COTEJO_EJECUTADO'
        ORDER BY id DESC LIMIT 1`,
      [operacionId],
    );
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0].payload.reproceso).toBe(true);
    expect(ev.rows[0].payload.parserVersionDespues).toBe(PREALERTA_PARSER_VERSION);
  });

  it('records a PREALERTA_REPROCESADA audit row', async () => {
    const admin = await seedUser('admin');
    const { operacionId } = await seedOperacionConPrealerta();

    await request(app).post(`/api/operaciones/${operacionId}/reparse`).set('Authorization', `Bearer ${admin.token}`);

    const audit = await query(
      `SELECT id FROM audit_log WHERE action = 'PREALERTA_REPROCESADA' AND entity_id = $1`,
      [operacionId],
    );
    expect(audit.rows).toHaveLength(1);
  });

  it('409s rather than re-keying when the reparse would yield a different mawb', async () => {
    const admin = await seedUser('admin');
    // Operación keyed to a DIFFERENT mawb than what the stored prealerta's subject actually parses to.
    const { rows: opRows } = await query<{ id: string }>(
      `INSERT INTO operaciones (mawb, mawb_raw) VALUES ($1, $2) RETURNING id`,
      ['99999999999', '999-99999999'],
    );
    const operacionId = opRows[0].id;
    await query(
      `INSERT INTO prealertas (operacion_id, version, asunto, cuerpo_texto, parser_version, estado)
         VALUES ($1, 1, $2, '', $3, 'parseada')`,
      [operacionId, SUBJECT, STALE_PARSER_VERSION],
    );

    const res = await request(app)
      .post(`/api/operaciones/${operacionId}/reparse`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/re-clavar|re-key/i);
  });
});

describe('POST /api/operaciones/:id/reparse — manifest cotejo', () => {
  it('recomputes manifest-owned discrepancias and preserves other families (PA-10 survives)', async () => {
    const admin = await seedUser('admin');
    const manifestId = await seedManifest();
    // Two shipment lines, deliberately mismatched against the new parse (64 cartones / 2914 piezas /
    // 542.86 kg): 2 bultos, 2900 piezas, 500 kg total — enough to fire PA-01/02/03 as errors.
    await seedShipment(manifestId, { guideId: MAWB_RAW, quantity: 1450, weightKg: 250, bulto: 'B1' });
    await seedShipment(manifestId, { guideId: MAWB_RAW, quantity: 1450, weightKg: 250, bulto: 'B2' });

    const existingPA10 = {
      codigo: 'PA-10',
      severidad: 'advertencia',
      mensaje: 'El vuelo declarado no pudo verificarse contra ninguna fuente externa.',
      detalle: { numeroVueloDeclarado: null, fuente: null },
    };
    const { operacionId } = await seedOperacionConPrealerta({
      manifestId,
      discrepancias: [existingPA10],
    });

    const res = await request(app)
      .post(`/api/operaciones/${operacionId}/reparse`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(200);

    const op = await query<{ discrepancias: Array<{ codigo: string; severidad: string }>; cotejo_version: string }>(
      `SELECT discrepancias, cotejo_version FROM operaciones WHERE id = $1`,
      [operacionId],
    );
    const codigos = op.rows[0].discrepancias.map((d) => d.codigo).sort();
    expect(codigos).toEqual(['PA-01', 'PA-02', 'PA-03', 'PA-10'].sort());
    expect(op.rows[0].discrepancias.find((d) => d.codigo === 'PA-01')?.severidad).toBe('error');
    expect(op.rows[0].discrepancias.find((d) => d.codigo === 'PA-02')?.severidad).toBe('error');
    expect(op.rows[0].discrepancias.find((d) => d.codigo === 'PA-03')?.severidad).toBe('error');
    // PA-10 (flight-family) is untouched by the manifest-family merge.
    expect(op.rows[0].discrepancias.find((d) => d.codigo === 'PA-10')).toMatchObject(existingPA10);
    expect(res.body.discrepancias).toBe(4);
  });

  it('leaves discrepancias untouched when no manifest is attached', async () => {
    const admin = await seedUser('admin');
    const existing = [{ codigo: 'PA-08', severidad: 'advertencia', mensaje: 'x' }];
    const { operacionId } = await seedOperacionConPrealerta({ discrepancias: existing });

    const res = await request(app)
      .post(`/api/operaciones/${operacionId}/reparse`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(200);

    const op = await query<{ discrepancias: Array<{ codigo: string }> }>(
      `SELECT discrepancias FROM operaciones WHERE id = $1`,
      [operacionId],
    );
    expect(op.rows[0].discrepancias).toEqual(existing);
  });
});
