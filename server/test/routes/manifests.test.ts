import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import * as XLSX from 'xlsx';
import { createApp } from '../../src/app';
import { hashPassword } from '../../src/auth/password';
import { signToken } from '../../src/auth/token';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

const app = createApp();
let token: string;

beforeEach(async () => {
  await truncateAll();
  const hash = await hashPassword('p');
  const { rows } = await query(`INSERT INTO users (username,password_hash,role) VALUES ('cap',$1,'capturista') RETURNING id`, [hash]);
  token = signToken({ userId: rows[0].id, role: 'capturista' , tv: 0 });
});

function xlsxBuffer(aoa: unknown[][]): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Hoja1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}
const HEADER = ['Número de guía de embarque', 'Descripción del Producto', 'Código HS', 'Número de productos', 'Valor total declarado', 'Divisa', 'Código de país del remitente', 'ID'];
const GOOD = ['G1', 'Camisa', '6109100022', '1', '6.03', 'Dólar estadounidense', 'CN', 'AERA790828HBSRBR04'];
const BAD = ['G2', 'Camisa', '6109100022', '1', 'N/A', 'Dólar estadounidense', 'CN', 'AERA790828HBSRBR04'];

describe('POST /api/manifests (multipart staging)', () => {
  it('stages rows, quarantines bad ones, persists nothing to shipments yet', async () => {
    const res = await request(app)
      .post('/api/manifests')
      .set('Authorization', `Bearer ${token}`)
      .field('mawbReference', '369-1')
      .field('clientName', 'Cliente A')
      .attach('file', xlsxBuffer([HEADER, GOOD, BAD]), 'm.xlsx');
    expect(res.status).toBe(201);
    expect(res.body.counts).toEqual({ total: 2, valid: 0, warning: 1, error: 1 });
    expect(res.body.rejected.length).toBe(1);
    const staged = await query('SELECT count(*)::int AS n FROM manifest_staging_rows');
    expect(staged.rows[0].n).toBe(2);
    const ships = await query('SELECT count(*)::int AS n FROM shipments');
    expect(ships.rows[0].n).toBe(0); // gold is empty until promotion
    const man = await query('SELECT ingestion_status FROM manifests WHERE id=$1', [res.body.manifestId]);
    expect(man.rows[0].ingestion_status).toBe('staged');
  });

  it('rejects a non-file request', async () => {
    const res = await request(app).post('/api/manifests').set('Authorization', `Bearer ${token}`).field('mawbReference', 'x');
    expect(res.status).toBe(400);
  });
});

describe('GET /api/manifests/:id/staging', () => {
  it('returns staging rows with statuses and redacts PII', async () => {
    const up = await request(app).post('/api/manifests').set('Authorization', `Bearer ${token}`)
      .field('mawbReference', '369-2').attach('file', xlsxBuffer([HEADER, GOOD, BAD]), 'm.xlsx');
    const res = await request(app).get(`/api/manifests/${up.body.manifestId}/staging`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.rows.length).toBe(2);
    expect(res.body.rows.map((r: any) => r.status).sort()).toEqual(['error', 'warning']);
    expect(JSON.stringify(res.body)).not.toContain('AERA790828HBSRBR04'); // raw PII not leaked
  });
});

describe('PII encryption at rest', () => {
  it('stores consignee curp as v1:-encrypted in manifest_staging_rows', async () => {
    await request(app)
      .post('/api/manifests')
      .set('Authorization', `Bearer ${token}`)
      .field('mawbReference', '369-pii')
      .attach('file', xlsxBuffer([HEADER, GOOD]), 'm.xlsx');
    const r = await query<{ data: any }>('SELECT data FROM manifest_staging_rows ORDER BY row_index LIMIT 1');
    const c = r.rows[0].data.consignee;
    expect((c.curp ?? c.rfc ?? '')).toMatch(/^v1:/);
  });
});

describe('POST /api/manifests/:id/promote', () => {
  it('promotes valid+warning rows to shipments and is idempotent on re-upload', async () => {
    const up = await request(app).post('/api/manifests').set('Authorization', `Bearer ${token}`)
      .field('mawbReference', '369-3').attach('file', xlsxBuffer([HEADER, GOOD]), 'm.xlsx');
    const id = up.body.manifestId;
    const prom = await request(app).post(`/api/manifests/${id}/promote`).set('Authorization', `Bearer ${token}`);
    expect(prom.status).toBe(200);
    expect(prom.body.promoted).toBe(1);
    const ships = await query('SELECT count(*)::int AS n FROM shipments WHERE manifest_id=$1', [id]);
    expect(ships.rows[0].n).toBe(1);
    const man = await query('SELECT ingestion_status FROM manifests WHERE id=$1', [id]);
    expect(man.rows[0].ingestion_status).toBe('promoted');
    // second promote is rejected (state machine guard)
    const again = await request(app).post(`/api/manifests/${id}/promote`).set('Authorization', `Bearer ${token}`);
    expect(again.status).toBe(409);
  });

  it('refuses promotion while error rows remain', async () => {
    const up = await request(app).post('/api/manifests').set('Authorization', `Bearer ${token}`)
      .field('mawbReference', '369-4').attach('file', xlsxBuffer([HEADER, GOOD, BAD]), 'm.xlsx');
    const prom = await request(app).post(`/api/manifests/${up.body.manifestId}/promote`).set('Authorization', `Bearer ${token}`);
    expect(prom.status).toBe(422);
    const ships = await query('SELECT count(*)::int AS n FROM shipments WHERE manifest_id=$1', [up.body.manifestId]);
    expect(ships.rows[0].n).toBe(0);
  });

  it('blocks promotion when any pedimento subdivision is finalized (sub_status=cargado)', async () => {
    // Stage a manifest with one valid row so it can be promoted.
    const up = await request(app).post('/api/manifests').set('Authorization', `Bearer ${token}`)
      .field('mawbReference', '369-5').attach('file', xlsxBuffer([HEADER, GOOD]), 'm.xlsx');
    const id = up.body.manifestId;

    // Seed a finalized pedimento row (sub_status='cargado' → computeLock returns editable:false).
    // Lock is lifecycle-driven: source PDF and prevalidation alone no longer block promotion.
    const u = await query('SELECT id FROM users WHERE username=$1', ['cap']);
    await query(
      `INSERT INTO pedimentos (manifest_id, sub_status, created_by) VALUES ($1,'cargado',$2)`,
      [id, u.rows[0].id],
    );

    const prom = await request(app).post(`/api/manifests/${id}/promote`).set('Authorization', `Bearer ${token}`);
    expect(prom.status).toBe(409);
    expect(prom.body.error).toMatch(/bloqueado/i);
    // No shipments promoted.
    const ships = await query('SELECT count(*)::int AS n FROM shipments WHERE manifest_id=$1', [id]);
    expect(ships.rows[0].n).toBe(0);
  });

  it('does NOT block promotion when pedimento has file_id but sub_status is not cargado (PDF no longer locks)', async () => {
    const up = await request(app).post('/api/manifests').set('Authorization', `Bearer ${token}`)
      .field('mawbReference', '369-6').attach('file', xlsxBuffer([HEADER, GOOD]), 'm.xlsx');
    const id = up.body.manifestId;

    const u = await query('SELECT id FROM users WHERE username=$1', ['cap']);
    const f = await query(
      `INSERT INTO files (kind, original_name, storage_path, size_bytes, uploaded_by)
       VALUES ('pedimento_pdf','p.pdf','/p.pdf',1,$1) RETURNING id`,
      [u.rows[0].id],
    );
    await query(
      `INSERT INTO pedimentos (manifest_id, file_id, sub_status, created_by) VALUES ($1,$2,'capturado',$3)`,
      [id, f.rows[0].id, u.rows[0].id],
    );

    const prom = await request(app).post(`/api/manifests/${id}/promote`).set('Authorization', `Bearer ${token}`);
    expect(prom.status).toBe(200);
  });

  it('allows promotion when pedimentos exist but none is locked', async () => {
    const up = await request(app).post('/api/manifests').set('Authorization', `Bearer ${token}`)
      .field('mawbReference', '369-7').attach('file', xlsxBuffer([HEADER, GOOD]), 'm.xlsx');
    const id = up.body.manifestId;

    // Pedimento row exists but has no file_id and no APPROVED prevalidation → not locked.
    const u = await query('SELECT id FROM users WHERE username=$1', ['cap']);
    await query(
      'INSERT INTO pedimentos (manifest_id, prevalidation, created_by) VALUES ($1,$2::jsonb,$3)',
      [id, JSON.stringify({ status: 'WARNINGS', errors: [] }), u.rows[0].id],
    );

    const prom = await request(app).post(`/api/manifests/${id}/promote`).set('Authorization', `Bearer ${token}`);
    expect(prom.status).toBe(200);
    expect(prom.body.promoted).toBe(1);
  });
});

describe('manifest duplicate prevention (Poka-Yoke)', () => {
  const GOOD2 = ['G9', 'Pantalón', '6109100022', '1', '7.50', 'Dólar estadounidense', 'CN', 'AERA790828HBSRBR04'];

  it('rejects re-uploading the identical file with 409 and keeps one manifest', async () => {
    const buf = xlsxBuffer([HEADER, GOOD]);
    const first = await request(app).post('/api/manifests').set('Authorization', `Bearer ${token}`)
      .field('mawbReference', '369-dup-file').attach('file', buf, 'm.xlsx');
    expect(first.status).toBe(201);

    const again = await request(app).post('/api/manifests').set('Authorization', `Bearer ${token}`)
      .field('mawbReference', '369-dup-file').attach('file', buf, 'm.xlsx');
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/archivo ya fue cargado/i);

    const man = await query('SELECT count(*)::int AS n FROM manifests WHERE mawb_reference=$1', ['369-dup-file']);
    expect(man.rows[0].n).toBe(1);
  });

  it('rejects the same MAWB with a different file with 409', async () => {
    const first = await request(app).post('/api/manifests').set('Authorization', `Bearer ${token}`)
      .field('mawbReference', '369-dup-mawb').attach('file', xlsxBuffer([HEADER, GOOD]), 'm.xlsx');
    expect(first.status).toBe(201);

    // Different file content (distinct hash) but same MAWB → blocked by the MAWB gate.
    const again = await request(app).post('/api/manifests').set('Authorization', `Bearer ${token}`)
      .field('mawbReference', '369-dup-mawb').attach('file', xlsxBuffer([HEADER, GOOD2]), 'm.xlsx');
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/guía MAWB/i);

    const man = await query('SELECT count(*)::int AS n FROM manifests WHERE mawb_reference=$1', ['369-dup-mawb']);
    expect(man.rows[0].n).toBe(1);
  });

  it('enforces mawb_reference uniqueness at the DB level (23505)', async () => {
    await query(`INSERT INTO manifests (mawb_reference) VALUES ('369-db-uq')`);
    await expect(
      query(`INSERT INTO manifests (mawb_reference) VALUES ('369-db-uq')`),
    ).rejects.toMatchObject({ code: '23505' });
  });
});

describe('per-client header mappings applied at upload', () => {
  // A client whose description column is named differently than any built-in synonym.
  const CLIENT_HEADER = ['Número de guía de embarque', 'Detalle Mercancía', 'Código HS', 'Número de productos', 'Valor total declarado', 'Divisa', 'Código de país del remitente', 'ID'];
  const GOOD_ROW = ['G1', 'Camisa', '6109100022', '1', '6.03', 'Dólar estadounidense', 'CN', 'AERA790828HBSRBR04'];

  it('reports the unmapped header, then ingests it once a client mapping is stored', async () => {
    const client = await query(`INSERT INTO clients (name) VALUES ('MappingCo') RETURNING id`);
    const clientId = client.rows[0].id;

    // First upload (no mapping): the client's column is unmapped and the row errors on description.
    const first = await request(app).post('/api/manifests').set('Authorization', `Bearer ${token}`)
      .field('mawbReference', '369-map-1').field('clientId', clientId)
      .attach('file', xlsxBuffer([CLIENT_HEADER, GOOD_ROW]), 'm.xlsx');
    expect(first.status).toBe(201);
    expect(first.body.unmappedHeaders).toContain('Detalle Mercancía');
    expect(first.body.counts.error).toBe(1);

    // Admin stores the mapping for this client.
    const admin = await query(`INSERT INTO users (username,password_hash,role) VALUES ('adm',$1,'admin') RETURNING id`,
      [await hashPassword('p')]);
    const adminToken = signToken({ userId: admin.rows[0].id, role: 'admin', tv: 0 });
    const save = await request(app).post('/api/header-mappings').set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId, header: 'Detalle Mercancía', canonicalPath: 'core.description' });
    expect(save.status).toBe(201);

    // Next upload (distinct MAWB + distinct content) applies the stored mapping: header maps,
    // description present, no error.
    const SECOND_ROW = ['G2', 'Pantalón', '6109100022', '1', '7.50', 'Dólar estadounidense', 'CN', 'AERA790828HBSRBR04'];
    const second = await request(app).post('/api/manifests').set('Authorization', `Bearer ${token}`)
      .field('mawbReference', '369-map-2').field('clientId', clientId)
      .attach('file', xlsxBuffer([CLIENT_HEADER, SECOND_ROW]), 'm.xlsx');
    expect(second.status).toBe(201);
    expect(second.body.unmappedHeaders).not.toContain('Detalle Mercancía');
    expect(second.body.counts.error).toBe(0);
  });
});
