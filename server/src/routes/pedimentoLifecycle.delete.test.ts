import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../app';
import { query } from '../db/pool';
import { signToken, type Role } from '../auth/token';

const app = createApp();

// Disk scratch dir for storage_path fixtures so the best-effort unlink has real files to remove.
const scratch = mkdtempSync(join(tmpdir(), 'pedimento-delete-'));

// Track fixtures so afterAll can tidy the shared test DB. Deleting the manifest
// cascades to pedimentos + pedimento_scans; files rows are removed explicitly.
const createdManifestIds: string[] = [];
const createdUserIds: string[] = [];
const createdFileIds: string[] = [];

async function createUser(role: Role): Promise<{ id: string; token: string }> {
  const username = `del-test-${role}-${randomUUID()}`;
  const { rows } = await query<{ id: string; token_version: number }>(
    `INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', $2)
       RETURNING id, token_version`,
    [username, role],
  );
  const { id, token_version } = rows[0];
  createdUserIds.push(id);
  return { id, token: signToken({ userId: id, role, tv: token_version }) };
}

async function createFile(uploadedBy: string): Promise<string> {
  const id = randomUUID();
  const storagePath = join(scratch, `${id}.pdf`);
  writeFileSync(storagePath, 'pdf-bytes');
  await query(
    `INSERT INTO files (id, kind, original_name, storage_path, size_bytes, uploaded_by, content_hash)
       VALUES ($1, 'pedimento_pdf', $2, $3, $4, $5, $6)`,
    [id, `${id}.pdf`, storagePath, 9, uploadedBy, randomUUID()],
  );
  createdFileIds.push(id);
  return id;
}

let uniqueCounter = 0;
function uniqueNumero(): string {
  // Distinct global número (DB-enforced unique on the digit-normalized value).
  uniqueCounter += 1;
  return `${Date.now()}${uniqueCounter}${Math.floor(Math.random() * 1e6)}`;
}

interface SeedOpts {
  subStatus?: string;
  createdBy: string;
  numero?: string;
  withReportFile?: boolean;
}

interface Seed {
  pedimentoId: string;
  manifestId: string;
  fileId: string;
  reportFileId: string | null;
  scanFileId: string;
  numero: string;
  storagePaths: string[];
}

async function seedPedimento(opts: SeedOpts): Promise<Seed> {
  const numero = opts.numero ?? uniqueNumero();
  const mawb = `MAWB-${randomUUID()}`;

  const manifest = await query<{ id: string }>(
    `INSERT INTO manifests (mawb_reference, created_by) VALUES ($1, $2) RETURNING id`,
    [mawb, opts.createdBy],
  );
  const manifestId = manifest.rows[0].id;
  createdManifestIds.push(manifestId);

  const fileId = await createFile(opts.createdBy);
  const reportFileId = opts.withReportFile ? await createFile(opts.createdBy) : null;

  const pedimento = await query<{ id: string }>(
    `INSERT INTO pedimentos
       (manifest_id, numero_pedimento, master_guide, file_id, report_file_id,
        covered_guias, sub_status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
    [
      manifestId,
      numero,
      `guia-${randomUUID()}`,
      fileId,
      reportFileId,
      [`guia-${randomUUID()}`],
      opts.subStatus ?? 'pendiente',
      opts.createdBy,
    ],
  );
  const pedimentoId = pedimento.rows[0].id;

  // A scan row keyed by the pedimento's file_id (pedimento_scans has no pedimento_id;
  // the route deletes scans by file_id).
  await query(
    `INSERT INTO pedimento_scans (manifest_id, file_id, verdict, created_by)
       VALUES ($1, $2, 'ok', $3)`,
    [manifestId, fileId, opts.createdBy],
  );

  const storagePaths = [join(scratch, `${fileId}.pdf`)];
  if (reportFileId) storagePaths.push(join(scratch, `${reportFileId}.pdf`));

  return { pedimentoId, manifestId, fileId, reportFileId, scanFileId: fileId, numero, storagePaths };
}

let admin: { id: string; token: string };
let capturista: { id: string; token: string };
let autoridad: { id: string; token: string };

beforeAll(async () => {
  admin = await createUser('admin');
  capturista = await createUser('capturista');
  autoridad = await createUser('autoridad');
});

afterAll(async () => {
  for (const id of createdManifestIds) {
    await query('DELETE FROM manifests WHERE id=$1', [id]).catch(() => {});
  }
  for (const id of createdFileIds) {
    await query('DELETE FROM files WHERE id=$1', [id]).catch(() => {});
  }
  for (const id of createdUserIds) {
    await query('DELETE FROM users WHERE id=$1', [id]).catch(() => {});
  }
});

describe('DELETE /api/pedimentos/:id', () => {
  it('deletes the pedimento, its scans and files, writes an audit entry, and frees the número', async () => {
    const seed = await seedPedimento({ createdBy: admin.id, withReportFile: true });

    const res = await request(app)
      .delete(`/api/pedimentos/${seed.pedimentoId}`)
      .set('Authorization', `Bearer ${admin.token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    // Pedimento row gone.
    const ped = await query('SELECT id FROM pedimentos WHERE id=$1', [seed.pedimentoId]);
    expect(ped.rows).toHaveLength(0);

    // Scan rows for the pedimento's file gone.
    const scans = await query('SELECT id FROM pedimento_scans WHERE file_id=$1', [seed.scanFileId]);
    expect(scans.rows).toHaveLength(0);

    // Both files rows (pdf + cached report) gone.
    const files = await query('SELECT id FROM files WHERE id = ANY($1)', [
      [seed.fileId, seed.reportFileId],
    ]);
    expect(files.rows).toHaveLength(0);

    // Best-effort disk unlink happened.
    for (const p of seed.storagePaths) {
      expect(existsSync(p)).toBe(false);
    }

    // Audit entry with before-snapshot.
    const audit = await query<{ action: string; entity: string; entity_id: string; before: any }>(
      `SELECT action, entity, entity_id, before FROM audit_log
        WHERE action='DELETE_PEDIMENTO' AND entity_id=$1`,
      [seed.pedimentoId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].entity).toBe('pedimento');
    expect(audit.rows[0].before.numeroPedimento).toBe(seed.numero);
    expect(audit.rows[0].before.fileId).toBe(seed.fileId);
    expect(audit.rows[0].before.manifestId).toBe(seed.manifestId);

    // Dedup freed: the same número can be inserted again after delete.
    const mawb2 = `MAWB-${randomUUID()}`;
    const m2 = await query<{ id: string }>(
      `INSERT INTO manifests (mawb_reference, created_by) VALUES ($1, $2) RETURNING id`,
      [mawb2, admin.id],
    );
    createdManifestIds.push(m2.rows[0].id);
    await expect(
      query(
        `INSERT INTO pedimentos (manifest_id, numero_pedimento, created_by)
           VALUES ($1, $2, $3)`,
        [m2.rows[0].id, seed.numero, admin.id],
      ),
    ).resolves.toBeDefined();
  });

  it('allows a capturista to delete', async () => {
    const seed = await seedPedimento({ createdBy: capturista.id });
    const res = await request(app)
      .delete(`/api/pedimentos/${seed.pedimentoId}`)
      .set('Authorization', `Bearer ${capturista.token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('returns 409 when the pedimento is finalized (cargado)', async () => {
    const seed = await seedPedimento({ createdBy: admin.id, subStatus: 'cargado' });
    const res = await request(app)
      .delete(`/api/pedimentos/${seed.pedimentoId}`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBeTruthy();

    // Nothing was deleted.
    const ped = await query('SELECT id FROM pedimentos WHERE id=$1', [seed.pedimentoId]);
    expect(ped.rows).toHaveLength(1);
  });

  it('returns 404 for an unknown id', async () => {
    const res = await request(app)
      .delete(`/api/pedimentos/${randomUUID()}`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(404);
  });

  it('returns 401 without a token', async () => {
    const seed = await seedPedimento({ createdBy: admin.id });
    const res = await request(app).delete(`/api/pedimentos/${seed.pedimentoId}`);
    expect(res.status).toBe(401);
  });

  it('returns 403 for a disallowed role (autoridad)', async () => {
    const seed = await seedPedimento({ createdBy: admin.id });
    const res = await request(app)
      .delete(`/api/pedimentos/${seed.pedimentoId}`)
      .set('Authorization', `Bearer ${autoridad.token}`);
    expect(res.status).toBe(403);

    // Not deleted.
    const ped = await query('SELECT id FROM pedimentos WHERE id=$1', [seed.pedimentoId]);
    expect(ped.rows).toHaveLength(1);
  });
});
