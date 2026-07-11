/**
 * Demo Reset — route tests for POST /api/admin/demo-reset.
 *
 * Verifies the DEMO_MODE 404 gate, the admin/super_admin role gate, the full
 * manifest cascade (+ explicit monthly_history / files cleanup), survivor tables,
 * and the DEMO_RESET audit event with correct counts.
 *
 * DEMO_MODE is pinned explicitly per the MFA_ENFORCEMENT test convention.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../../src/app';
import { hashPassword } from '../../src/auth/password';
import { signToken, type Role } from '../../src/auth/token';
import { recordAudit } from '../../src/services/audit';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

const app = createApp();

// Disk scratch dir so the post-commit best-effort unlink has real blobs to remove.
const scratch = mkdtempSync(join(tmpdir(), 'demo-reset-'));

const ORIGINAL_DEMO_MODE = process.env.DEMO_MODE;
beforeEach(async () => {
  await truncateAll();
  process.env.DEMO_MODE = 'true';
});
afterEach(() => {
  if (ORIGINAL_DEMO_MODE === undefined) delete process.env.DEMO_MODE;
  else process.env.DEMO_MODE = ORIGINAL_DEMO_MODE;
});

async function seedUser(role: Role): Promise<{ id: string; token: string }> {
  const { rows } = await query<{ id: string; token_version: number }>(
    `INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', $2)
       RETURNING id, token_version`,
    [`demo-${role}-${randomUUID()}`, role],
  );
  return { id: rows[0].id, token: signToken({ userId: rows[0].id, role, tv: rows[0].token_version }) };
}

async function seedFile(kind: string, uploadedBy: string): Promise<{ id: string; path: string }> {
  const id = randomUUID();
  const path = join(scratch, `${id}.bin`);
  writeFileSync(path, 'blob');
  await query(
    `INSERT INTO files (id, kind, original_name, storage_path, size_bytes, uploaded_by, content_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, kind, `${id}.bin`, path, 4, uploadedBy, randomUUID()],
  );
  return { id, path };
}

let numeroCounter = 0;
function uniqueNumero(): string {
  numeroCounter += 1;
  return `${Date.now()}${numeroCounter}${Math.floor(Math.random() * 1e6)}`;
}

async function insManifest(createdBy: string, opts: { riskFile?: string; sourceFile?: string } = {}): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO manifests (mawb_reference, created_by, risk_file_id, source_file_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
    [`MAWB-${randomUUID()}`, createdBy, opts.riskFile ?? null, opts.sourceFile ?? null],
  );
  return rows[0].id;
}

async function insShipment(manifestId: string): Promise<void> {
  await query(`INSERT INTO shipments (id, manifest_id, data) VALUES ($1, $2, '{}'::jsonb)`, [randomUUID(), manifestId]);
}

async function insPedimento(manifestId: string, createdBy: string, opts: { file?: string; report?: string } = {}): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO pedimentos (manifest_id, numero_pedimento, file_id, report_file_id, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [manifestId, uniqueNumero(), opts.file ?? null, opts.report ?? null, createdBy],
  );
  return rows[0].id;
}

async function insScan(manifestId: string, fileId: string, createdBy: string): Promise<void> {
  await query(
    `INSERT INTO pedimento_scans (manifest_id, file_id, verdict, created_by) VALUES ($1, $2, 'ok', $3)`,
    [manifestId, fileId, createdBy],
  );
}

async function insMonthly(manifestId: string | null): Promise<void> {
  await query(
    `INSERT INTO monthly_history (consignee_name_norm, period, manifest_id, seen_count) VALUES ($1, '2026-07', $2, 1)`,
    [`c-${randomUUID()}`, manifestId],
  );
}

async function count(table: string): Promise<number> {
  const { rows } = await query<{ c: number }>(`SELECT count(*)::int AS c FROM ${table}`);
  return rows[0].c;
}

describe('POST /api/admin/demo-reset — gates', () => {
  it('404 when DEMO_MODE is unset, even for an admin', async () => {
    delete process.env.DEMO_MODE;
    const admin = await seedUser('admin');
    const res = await request(app).post('/api/admin/demo-reset').set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(404);
  });

  it('404 without a token when DEMO_MODE is unset (feature is hidden entirely)', async () => {
    delete process.env.DEMO_MODE;
    const res = await request(app).post('/api/admin/demo-reset');
    expect(res.status).toBe(404);
  });

  it('401 without a token in demo mode', async () => {
    const res = await request(app).post('/api/admin/demo-reset');
    expect(res.status).toBe(401);
  });

  it('403 for a capturista in demo mode — nothing is deleted', async () => {
    const cap = await seedUser('capturista');
    await insManifest(cap.id);
    const res = await request(app).post('/api/admin/demo-reset').set('Authorization', `Bearer ${cap.token}`);
    expect(res.status).toBe(403);
    expect(await count('manifests')).toBe(1);
  });

  it('403 for an autoridad in demo mode', async () => {
    const aut = await seedUser('autoridad');
    const res = await request(app).post('/api/admin/demo-reset').set('Authorization', `Bearer ${aut.token}`);
    expect(res.status).toBe(403);
  });

  it('allows super_admin', async () => {
    const sa = await seedUser('super_admin');
    const res = await request(app).post('/api/admin/demo-reset').set('Authorization', `Bearer ${sa.token}`);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toEqual({ manifests: 0, pedimentos: 0, shipments: 0, files: 0 });
  });
});

describe('POST /api/admin/demo-reset — cascade + survivors + audit', () => {
  it('wipes the manifest graph, removes files, preserves catalogs/users/audit, and logs DEMO_RESET', async () => {
    const admin = await seedUser('admin');

    // M1: risk + source files, one shipment, one pedimento (pdf + report) and a scan (own file).
    const riskF = await seedFile('risk_analysis', admin.id);
    const srcF = await seedFile('manifest', admin.id);
    const m1 = await insManifest(admin.id, { riskFile: riskF.id, sourceFile: srcF.id });
    await insShipment(m1);
    const p1pdf = await seedFile('pedimento_pdf', admin.id);
    const p1rep = await seedFile('report', admin.id);
    await insPedimento(m1, admin.id, { file: p1pdf.id, report: p1rep.id });
    const scanF = await seedFile('pedimento_pdf', admin.id);
    await insScan(m1, scanF.id, admin.id);
    await insMonthly(m1);

    // M2: two shipments, two pedimentos (pdf each).
    const m2 = await insManifest(admin.id);
    await insShipment(m2);
    await insShipment(m2);
    const p2pdf = await seedFile('pedimento_pdf', admin.id);
    const p3pdf = await seedFile('pedimento_pdf', admin.id);
    await insPedimento(m2, admin.id, { file: p2pdf.id });
    await insPedimento(m2, admin.id, { file: p3pdf.id });

    // M3: two pedimentos (pdf each), no shipments.
    const m3 = await insManifest(admin.id);
    const p4pdf = await seedFile('pedimento_pdf', admin.id);
    const p5pdf = await seedFile('pedimento_pdf', admin.id);
    await insPedimento(m3, admin.id, { file: p4pdf.id });
    await insPedimento(m3, admin.id, { file: p5pdf.id });

    // Legacy monthly_history aggregate with NO manifest_id — must be removed explicitly.
    await insMonthly(null);

    // A files row NOT referenced by anything (abandoned upload: saveFile commits before
    // the referencing row is attached). The reset wipes it too — files is not a survivor.
    const orphanF = await seedFile('manifest', admin.id);

    // Survivors: users, clients, catalogs, validated RFCs, config, and the audit log.
    await query(`INSERT INTO clients (name) VALUES ('Survivor Co')`);
    await query(`INSERT INTO agentes_aduanales (patente) VALUES ('9999')`);
    await query(`INSERT INTO importadores (rfc) VALUES ('RFC999999XXX')`);
    await query(`INSERT INTO validated_rfcs (id_ref) VALUES ('REF-1')`);
    await query(`INSERT INTO config (key, value) VALUES ('branding', '{}'::jsonb)`);
    await recordAudit({ userId: admin.id, action: 'LOGIN', entity: 'session', ip: '127.0.0.1' });

    const allFiles = [riskF, srcF, p1pdf, p1rep, scanF, p2pdf, p3pdf, p4pdf, p5pdf, orphanF];
    const expectedCounts = { manifests: 3, pedimentos: 5, shipments: 3, files: allFiles.length };

    const res = await request(app).post('/api/admin/demo-reset').set('Authorization', `Bearer ${admin.token}`);

    expect(res.status).toBe(200);
    expect(res.body.deleted).toEqual(expectedCounts);

    // Operational graph gone (manifests + all cascade + explicit deletes).
    expect(await count('manifests')).toBe(0);
    expect(await count('shipments')).toBe(0);
    expect(await count('pedimentos')).toBe(0);
    expect(await count('pedimento_scans')).toBe(0);
    expect(await count('monthly_history')).toBe(0); // includes the NULL-manifest_id legacy row

    // ALL files rows removed (graph-referenced AND the never-referenced orphan) + blobs unlinked.
    expect(await count('files')).toBe(0);
    for (const f of allFiles) expect(existsSync(f.path)).toBe(false);

    // Survivors intact.
    expect(await count('users')).toBe(1);
    expect(await count('clients')).toBe(1);
    expect(await count('agentes_aduanales')).toBe(1);
    expect(await count('importadores')).toBe(1);
    expect(await count('validated_rfcs')).toBe(1);
    expect(await count('config')).toBe(1);

    // Audit log survives and the DEMO_RESET event carries the counts.
    const login = await query(`SELECT count(*)::int AS c FROM audit_log WHERE action='LOGIN'`);
    expect(login.rows[0].c).toBe(1);
    const demo = await query<{ after: unknown }>(`SELECT after FROM audit_log WHERE action='DEMO_RESET'`);
    expect(demo.rows).toHaveLength(1);
    expect(demo.rows[0].after).toEqual(expectedCounts);

    // Hash chain stays valid: DEMO_RESET links to the prior row's hash.
    const chain = await query<{ action: string; prev_hash: string | null; hash: string }>(
      `SELECT action, prev_hash, hash FROM audit_log ORDER BY id`,
    );
    const last = chain.rows[chain.rows.length - 1];
    const prev = chain.rows[chain.rows.length - 2];
    expect(last.action).toBe('DEMO_RESET');
    expect(last.prev_hash).toBe(prev.hash);
  });
});

describe('demoMode flag on auth responses', () => {
  // Capturista avoids the MFA enforcement gate for privileged roles.
  async function seedLoginUser(): Promise<string> {
    const username = `demo-login-${randomUUID()}`;
    await query(
      `INSERT INTO users (username, password_hash, role) VALUES ($1, $2, 'capturista')`,
      [username, await hashPassword('pass')],
    );
    return username;
  }

  it('POST /login includes demoMode: true on the user when DEMO_MODE is pinned true', async () => {
    const username = await seedLoginUser();
    const res = await request(app).post('/api/auth/login').send({ username, password: 'pass' });
    expect(res.status).toBe(200);
    expect(res.body.user.demoMode).toBe(true);
  });

  it('POST /login includes demoMode: false when DEMO_MODE is unset', async () => {
    delete process.env.DEMO_MODE;
    const username = await seedLoginUser();
    const res = await request(app).post('/api/auth/login').send({ username, password: 'pass' });
    expect(res.status).toBe(200);
    expect(res.body.user.demoMode).toBe(false);
  });

  it('GET /me includes demoMode: true when DEMO_MODE is pinned true', async () => {
    const cap = await seedUser('capturista');
    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${cap.token}`);
    expect(res.status).toBe(200);
    expect(res.body.demoMode).toBe(true);
  });
});
