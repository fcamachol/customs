import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Buffer } from 'node:buffer';
import { createApp } from '../../src/app';
import { hashPassword } from '../../src/auth/password';
import { signToken } from '../../src/auth/token';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

const app = createApp();
let token: string; let userId: string; let manifestId: string;

const MINIMAL_PDF = Buffer.from(
  '%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
  '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n' +
  'trailer<</Root 1 0 R>>\n%%EOF', 'latin1');

const DIRTY_PDF = Buffer.from(
  '%PDF-1.5\n1 0 obj<</OpenAction<</S/JavaScript/JS(app.alert\\(1\\))>>>>endobj\n%%EOF', 'latin1');

// Build a minimal single-page PDF whose content stream draws real text so that
// extractPedimento parses a numero_pedimento + subdivisión metadata from it.
function makeTextPdf(lines: string[]): Buffer {
  const text = lines.map((l) => `(${l.replace(/([()\\])/g, '\\$1')}) Tj 0 -14 Td`).join('\n');
  const content = `BT /F1 10 Tf 36 740 Td\n${text}\nET`;
  const objs = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>',
    `<</Length ${content.length}>>\nstream\n${content}\nendstream`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((off) => { pdf += `${String(off).padStart(10, '0')} 00000 n \n`; });
  pdf += `trailer<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

// A pedimento PDF whose master guide matches the manifest mawb_reference (369-94268462).
function pedimentoPdf(numero: string): Buffer {
  return makeTextPdf([
    `NUM. PEDIMENTO: ${numero}`,
    'T1',
    'SEGUNDA SUBDIVISION DE LA GUIA MASTER NO. 369-94268462',
    '34 BULTOS CON UN PESO DE 808 KG.',
    'DESTINO/ORIGEN: TIPO CAMBIO: PESO BRUTO: ADUANA E/S:',
    '9 20.45680 808.000 850',
    'FECHAS',
    '04/04/2025',
    '05/04/2025',
  ]);
}

beforeEach(async () => {
  await truncateAll();
  const hash = await hashPassword('p');
  const u = await query(`INSERT INTO users (username,password_hash,role) VALUES ('c',$1,'capturista') RETURNING id`, [hash]);
  userId = u.rows[0].id;
  token = signToken({ userId, role: 'capturista' , tv: 0 });
  // mawb_reference matches the master guide parsed from pedimentoPdf().
  const m = await query(`INSERT INTO manifests (mawb_reference) VALUES ('369-94268462') RETURNING id`);
  manifestId = m.rows[0].id;
});

describe('POST /api/manifests/:id/pedimento-pdf', () => {
  it('stores the PDF and inserts a pedimentos row (not manifest columns)', async () => {
    const res = await request(app)
      .post(`/api/manifests/${manifestId}/pedimento-pdf`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', MINIMAL_PDF, { filename: 'pedimento.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(201);
    expect(res.body.fileId).toBeTruthy();
    expect(res.body.pedimentoId).toBeTruthy();

    const { rows } = await query('SELECT kind FROM files WHERE id=$1', [res.body.fileId]);
    expect(rows[0].kind).toBe('pedimento_pdf');

    // A pedimentos row owns the file_id + scan now; manifests.file_id is untouched.
    const ped = await query('SELECT file_id, pedimento_scan FROM pedimentos WHERE manifest_id=$1', [manifestId]);
    expect(ped.rows).toHaveLength(1);
    expect(ped.rows[0].file_id).toBe(res.body.fileId);
    expect(ped.rows[0].pedimento_scan.verdict).toBe('clean');

    // manifests.file_id and manifests.pedimento_scan were dropped in Task 11 — schema enforces it.

    const scans = await query('SELECT verdict FROM pedimento_scans WHERE manifest_id=$1', [manifestId]);
    expect(scans.rows).toHaveLength(1);
    expect(scans.rows[0].verdict).toBe('clean');
  });

  it('populates the pedimentos row from the extracted pedimento', async () => {
    const res = await request(app)
      .post(`/api/manifests/${manifestId}/pedimento-pdf`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', pedimentoPdf('25 85 1653 5001684'), { filename: 'pedimento.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(201);
    expect(res.body.numeroPedimento).toBe('258516535001684');

    const ped = await query(
      'SELECT numero_pedimento, master_guide, subdivision_ordinal, is_last_subdivision, bultos, peso_bruto_kg FROM pedimentos WHERE manifest_id=$1',
      [manifestId]);
    expect(ped.rows[0].numero_pedimento).toBe('258516535001684');
    expect(ped.rows[0].master_guide).toBe('369-94268462');
    expect(ped.rows[0].subdivision_ordinal).toBe(2);
    expect(ped.rows[0].bultos).toBe(34);
  });

  it('rejects a master guide that does not match the manifest mawb_reference with 400', async () => {
    const pdf = makeTextPdf([
      'NUM. PEDIMENTO: 25 85 1653 5001684',
      'SEGUNDA SUBDIVISION DE LA GUIA MASTER NO. 999-00000000',
    ]);
    const res = await request(app)
      .post(`/api/manifests/${manifestId}/pedimento-pdf`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', pdf, { filename: 'pedimento.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/guía master/i);
    // Nothing persisted on a hard-gate failure.
    const ped = await query('SELECT id FROM pedimentos WHERE manifest_id=$1', [manifestId]);
    expect(ped.rows).toHaveLength(0);
    const files = await query('SELECT id FROM files');
    expect(files.rows).toHaveLength(0);
  });

  it('rejects a duplicate numero_pedimento for the same manifest with 409', async () => {
    const first = await request(app)
      .post(`/api/manifests/${manifestId}/pedimento-pdf`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', pedimentoPdf('25 85 1653 5001684'), { filename: 'pedimento.pdf', contentType: 'application/pdf' });
    expect(first.status).toBe(201);

    // Same pedimento number uploaded again — rejected as a duplicate for this manifest.
    const dup = await request(app)
      .post(`/api/manifests/${manifestId}/pedimento-pdf`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', pedimentoPdf('25 85 1653 5001684'), { filename: 'pedimento.pdf', contentType: 'application/pdf' });
    expect(dup.status).toBe(409);
    const ped = await query('SELECT id FROM pedimentos WHERE manifest_id=$1', [manifestId]);
    expect(ped.rows).toHaveLength(1);
  });

  it('attaches but warns pdf_unparseable when extraction yields nothing (gates skipped)', async () => {
    // DIRTY_PDF passes the scan under the default flag policy but is not a parseable PDF, so
    // extractPedimento throws → best-effort attach proceeds and the 201 surfaces the bypass.
    const res = await request(app)
      .post(`/api/manifests/${manifestId}/pedimento-pdf`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', DIRTY_PDF, { filename: 'pedimento.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(201);
    expect(res.body.warnings).toContain('pdf_unparseable');
    expect(res.body.warning).toMatch(/pdf_unparseable/);
    // The row is still attached, just unverified (no numero, gates skipped).
    expect(res.body.numeroPedimento).toBeNull();
    const ped = await query('SELECT id, numero_pedimento FROM pedimentos WHERE manifest_id=$1', [manifestId]);
    expect(ped.rows).toHaveLength(1);
    expect(ped.rows[0].numero_pedimento).toBeNull();
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

    // No file persisted, no pedimentos row created.
    const files = await query('SELECT id FROM files');
    expect(files.rows).toHaveLength(0);
    const ped = await query('SELECT id FROM pedimentos WHERE manifest_id=$1', [manifestId]);
    expect(ped.rows).toHaveLength(0);

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

  it('pre-fills import_data on the new pedimento row from the extracted header', async () => {
    const res = await request(app)
      .post(`/api/manifests/${manifestId}/pedimento-pdf`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', pedimentoPdf('25 85 1653 5001684'), { filename: 'pedimento.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(201);
    const row = await query<{ import_data: Record<string, unknown> | null; sub_status: string }>(
      `SELECT import_data, sub_status FROM pedimentos WHERE id=$1`, [res.body.pedimentoId]);
    expect(row.rows[0].import_data).toMatchObject({
      patente: '1653', cveT1: 'T1', fechaEntrada: '2025-04-04', tipoCambio: 20.4568, paymentDate: '2025-04-05',
    });
    expect(row.rows[0].sub_status).toBe('pendiente'); // pre-fill does not advance the lifecycle
  });
});
