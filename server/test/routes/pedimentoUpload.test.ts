import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Buffer } from 'node:buffer';
import { createApp } from '../../src/app';
import { hashPassword } from '../../src/auth/password';
import { signToken } from '../../src/auth/token';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

const app = createApp();
let token: string; let manifestId: string;

const MINIMAL_PDF = Buffer.from(
  '%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
  '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n' +
  'trailer<</Root 1 0 R>>\n%%EOF', 'latin1');

const DIRTY_PDF = Buffer.from(
  '%PDF-1.5\n1 0 obj<</OpenAction<</S/JavaScript/JS(app.alert\\(1\\))>>>>endobj\n%%EOF', 'latin1');

beforeEach(async () => {
  await truncateAll();
  const hash = await hashPassword('p');
  const u = await query(`INSERT INTO users (username,password_hash,role) VALUES ('c',$1,'capturista') RETURNING id`, [hash]);
  token = signToken({ userId: u.rows[0].id, role: 'capturista' , tv: 0 });
  const m = await query(`INSERT INTO manifests (mawb_reference) VALUES ('369-1') RETURNING id`);
  manifestId = m.rows[0].id;
});

describe('POST /api/manifests/:id/pedimento-pdf', () => {
  it('stores the PDF and links it to the manifest', async () => {
    const res = await request(app)
      .post(`/api/manifests/${manifestId}/pedimento-pdf`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', MINIMAL_PDF, { filename: 'pedimento.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(201);
    expect(res.body.fileId).toBeTruthy();
    const { rows } = await query('SELECT kind FROM files WHERE id=$1', [res.body.fileId]);
    expect(rows[0].kind).toBe('pedimento_pdf');
    const scans = await query('SELECT verdict FROM pedimento_scans WHERE manifest_id=$1', [manifestId]);
    expect(scans.rows).toHaveLength(1);
    expect(scans.rows[0].verdict).toBe('clean');
  });

  it('accepts a flagged PDF under default flag policy and records the scan', async () => {
    const res = await request(app)
      .post(`/api/manifests/${manifestId}/pedimento-pdf`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', DIRTY_PDF, { filename: 'pedimento.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(201);
    expect(res.body.fileId).toBeTruthy();
    expect(res.body.scan.verdict).toBe('suspicious');

    const scans = await query('SELECT verdict FROM pedimento_scans WHERE manifest_id=$1', [manifestId]);
    expect(scans.rows).toHaveLength(1);
    expect(scans.rows[0].verdict).toBe('suspicious');

    const audit = await query(`SELECT action FROM audit_log WHERE action='PEDIMENTO_SCAN_FLAGGED'`);
    expect(audit.rows).toHaveLength(1);
  });

  it('blocks a dirty PDF with 422 when policy onActiveContent is block', async () => {
    await query(
      `INSERT INTO config (key, value) VALUES ('pedimento_scan_policy', $1)`,
      [JSON.stringify({ onActiveContent: 'block' })],
    );
    const res = await request(app)
      .post(`/api/manifests/${manifestId}/pedimento-pdf`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', DIRTY_PDF, { filename: 'pedimento.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(422);
    expect(res.body.scan.verdict).toBe('blocked');

    // No file persisted, manifest not linked.
    const files = await query('SELECT id FROM files');
    expect(files.rows).toHaveLength(0);
    const m = await query('SELECT file_id FROM manifests WHERE id=$1', [manifestId]);
    expect(m.rows[0].file_id).toBeNull();

    const scans = await query('SELECT verdict, file_id FROM pedimento_scans WHERE manifest_id=$1', [manifestId]);
    expect(scans.rows).toHaveLength(1);
    expect(scans.rows[0].verdict).toBe('blocked');
    expect(scans.rows[0].file_id).toBeNull();
  });

  it('rejects a non-PDF file with 400', async () => {
    const txtBuffer = Buffer.from('this is plain text, not a pdf');
    const res = await request(app)
      .post(`/api/manifests/${manifestId}/pedimento-pdf`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', txtBuffer, { filename: 'notapdf.txt', contentType: 'text/plain' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/PDF/i);
  });

  it('rejects a 0-byte file with 400', async () => {
    const emptyBuffer = Buffer.alloc(0);
    const res = await request(app)
      .post(`/api/manifests/${manifestId}/pedimento-pdf`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', emptyBuffer, { filename: 'empty.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(400);
  });

  it('rejects a file below PEDIMENTO_MIN_BYTES when env is set', async () => {
    const originalEnv = process.env.PEDIMENTO_MIN_BYTES;
    process.env.PEDIMENTO_MIN_BYTES = String(MINIMAL_PDF.length + 1);
    try {
      const res = await request(app)
        .post(`/api/manifests/${manifestId}/pedimento-pdf`)
        .set('Authorization', `Bearer ${token}`)
        .attach('file', MINIMAL_PDF, { filename: 'pedimento.pdf', contentType: 'application/pdf' });
      expect(res.status).toBe(400);
    } finally {
      if (originalEnv === undefined) delete process.env.PEDIMENTO_MIN_BYTES;
      else process.env.PEDIMENTO_MIN_BYTES = originalEnv;
    }
  });
});
