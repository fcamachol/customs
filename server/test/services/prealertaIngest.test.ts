import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';
import { COTEJO_RULESET_VERSION } from '../../../shared/operaciones/cotejo';

/**
 * Ingest tests. The point of most of these is ORDER and IDEMPOTENCY, not field extraction (that is
 * covered by shared/operaciones/prealerta.test.ts):
 *
 *   - evidence is archived before the caso is committed (rule R-A)
 *   - a redelivered webhook produces no second caso
 *   - a resend of the same guía máster versions the caso instead of forking it (R6 / D2)
 *   - a blocked attachment stops the pipeline rather than half-advancing it
 *   - the ledger cannot be rewritten afterwards
 */

const scratch = mkdtempSync(join(tmpdir(), 'prealerta-ingest-'));
process.env.FILE_STORAGE_DIR = scratch;

// A real (if minimal) CSV for the manifiesto, so the manifest pipeline genuinely runs instead of
// choking on placeholder bytes. Headers use the vocabulary shared/parsing/headerSynonyms.ts maps.
// 10 + 25 = 35 pieces, which deliberately CONTRADICTS the 1910 the email body declares — that is what
// makes PA-02 fire and proves the red flag works end to end.
// Fraccion arancelaria is REQUIRED by validateManifest: without it every row is a hard error, nothing
// promotes to shipments, and the risk engine gets nothing to score. Worth knowing operationally — a
// real manifiesto that omits it produces a caso with no risk analysis at all.
const MANIFIESTO_CSV = [
  'No. de guia aerea o documento de transporte,Descripcion de la mercancia,Fraccion arancelaria,Cantidad de la mercancia,Valor en aduana declarado,Moneda,Pais de procedencia',
  '160-94705516-001,AURICULARES INALAMBRICOS,9901000100,10,85.50,USD,CN',
  '160-94705516-002,FUNDA PARA TELEFONO,9901000100,25,42.00,USD,CN',
].join('\n');

// A second manifiesto that shares a house guía with the first (…-001) while being a different file for
// a different guía máster. That overlap is duplicate cargo — the same shipment declared on two casos —
// which is what PA-07 exists to catch.
const MANIFIESTO_CSV_GUIA_COMPARTIDA = [
  'No. de guia aerea o documento de transporte,Descripcion de la mercancia,Fraccion arancelaria,Cantidad de la mercancia,Valor en aduana declarado,Moneda,Pais de procedencia',
  '160-94705516-001,AURICULARES INALAMBRICOS,9901000100,10,85.50,USD,CN',
  '160-94705516-003,CABLE USB TIPO C,9901000100,5,12.00,USD,CN',
].join('\n');

/**
 * Default attachment fetcher. Restored in beforeEach because `vi.clearAllMocks()` clears recorded
 * CALLS but keeps any implementation a test installed — so a test that makes the download return
 * garbage silently broke the manifest pipeline for every test that ran after it.
 */
async function defaultDownload(_cfg: unknown, url: string): Promise<Buffer> {
  if (String(url).includes('manifiesto-compartido')) {
    return Buffer.from(MANIFIESTO_CSV_GUIA_COMPARTIDA, 'utf8');
  }
  if (String(url).endsWith('.csv') || String(url).endsWith('.xlsx')) {
    return Buffer.from(MANIFIESTO_CSV, 'utf8');
  }
  return Buffer.from('%PDF-1.4 fake\n');
}

const downloadAttachment = vi.fn(defaultDownload);
// Typed parameters (rather than `async () => {}`) so the assertions below can read the recorded call
// arguments without tsc rejecting an index into a zero-length tuple.
const setConversationCustomAttributes = vi.fn(
  async (_cfg: unknown, _conversationId: unknown, _attrs: Record<string, unknown>) => {},
);
/** The AGORA mirror's write path (task #24). Stubbed so these tests never touch the network. */
const postMessage = vi.fn(
  async (_cfg: unknown, _conversationId: unknown, _body: { content: string; private?: boolean }) => ({
    id: 1,
  }),
);
const scanPedimentoPdf = vi.fn(async () => ({
  verdict: 'clean' as const,
  findings: [],
  motors: { rf08: 'clean' as const, rf10: 'clean' as const },
  scannedAt: '2026-08-06T00:00:00.000Z',
  bytesScanned: 14,
  policy: {} as never,
}));

vi.mock('../../src/services/agoraClient', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/agoraClient')>(
    '../../src/services/agoraClient',
  );
  return {
    ...actual,
    loadAgoraConfig: () => ({ baseUrl: 'https://agora.test', accountId: '9', token: 't' }),
    downloadAttachment: (...a: unknown[]) => downloadAttachment(...(a as [unknown, string])),
    setConversationCustomAttributes: (...a: unknown[]) =>
      setConversationCustomAttributes(...(a as Parameters<typeof setConversationCustomAttributes>)),
    postMessage: (...a: unknown[]) => postMessage(...(a as Parameters<typeof postMessage>)),
  };
});

/**
 * The manifest step, wrapped so a test can make it fail. Defaults to the REAL implementation — the
 * manifest pipeline genuinely running is the point of half this suite — and is restored in beforeEach
 * because `vi.clearAllMocks()` clears calls but keeps an implementation a previous test installed.
 */
const manifiestoActual = await vi.importActual<typeof import('../../src/services/manifiestoIngest')>(
  '../../src/services/manifiestoIngest',
);
const ingestManifiestoFromPrealerta = vi.fn(manifiestoActual.ingestManifiestoFromPrealerta);
vi.mock('../../src/services/manifiestoIngest', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/manifiestoIngest')>(
    '../../src/services/manifiestoIngest',
  );
  return {
    ...actual,
    ingestManifiestoFromPrealerta: (...a: unknown[]) =>
      ingestManifiestoFromPrealerta(...(a as Parameters<typeof manifiestoActual.ingestManifiestoFromPrealerta>)),
  };
});

// The ingest resolves the flight as its final step. Stubbed here so these tests stay about INGEST and
// never touch the network — flight behaviour has its own suite in vuelosService.test.ts. Without this
// stub the tests would make a live adsb.lol call and gain an extra VUELO_* event.
const refreshVueloForOperacion = vi.fn(async () => undefined);
vi.mock('../../src/services/vuelosService', () => ({
  refreshVueloForOperacion: (...a: unknown[]) => refreshVueloForOperacion(...(a as [])),
  refreshVuelosPendientes: async () => [],
}));

vi.mock('../../src/services/pdfScan', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/pdfScan')>(
    '../../src/services/pdfScan',
  );
  return {
    ...actual,
    loadScanPolicy: async () => ({
      onActiveContent: 'flag',
      onQrTrojan: 'flag',
      oversizeBehavior: 'skip',
      maxBytes: 1024 * 1024,
    }),
    scanPedimentoPdf: (...a: unknown[]) => scanPedimentoPdf(...(a as [])),
  };
});

const { ingestPrealerta, classifyAdjunto } = await import('../../src/services/prealertaIngest');

const BODY = [
  'Master AWB: 160-94705516',
  'Origin/Destination: HKG-NLU',
  'Flight: CI5218',
  'Estimated Time of Departure: 2026-08-16',
  'Estimated Time of Arrival: 2026-08-18',
  'Cartons: 63',
  'Pieces: 1910',
  'Gross Weight: 52.64 KG',
].join('\n');

function payload(over: Record<string, unknown> = {}) {
  return {
    event: 'message_created',
    id: 5001,
    message_type: 'incoming',
    private: false,
    content: BODY,
    content_attributes: {
      email: {
        subject: 'Prealert 160-94705516',
        message_id: '<msg-1@client.example>',
        from: ['robot@shein.example'],
        text_content: { full: BODY },
      },
    },
    conversation: { id: 77, inbox_id: 21 },
    inbox: { id: 21, name: 'Operaciones' },
    sender: { id: 3, email: 'robot@shein.example' },
    attachments: [
      { id: 1, file_type: 'file', data_url: 'https://agora.test/blob/awb.pdf', extension: 'pdf' },
      { id: 2, file_type: 'file', data_url: 'https://agora.test/blob/manifiesto.csv', extension: 'csv' },
    ],
    ...over,
  };
}

beforeEach(async () => {
  await truncateAll();
  vi.clearAllMocks();
  downloadAttachment.mockImplementation(defaultDownload);
  ingestManifiestoFromPrealerta.mockImplementation(manifiestoActual.ingestManifiestoFromPrealerta);
  setConversationCustomAttributes.mockResolvedValue(undefined);
  postMessage.mockResolvedValue({ id: 1 });
  scanPedimentoPdf.mockResolvedValue({
    verdict: 'clean',
    findings: [],
    motors: { rf08: 'clean', rf10: 'clean' },
    scannedAt: '2026-08-06T00:00:00.000Z',
    bytesScanned: 14,
    policy: {} as never,
  });
});

afterAll(() => {
  delete process.env.FILE_STORAGE_DIR;
});

describe('classifyAdjunto', () => {
  it('routes by extension, since a client-supplied label could aim a file at the wrong pipeline', () => {
    expect(classifyAdjunto('awb.pdf')).toBe('awb');
    expect(classifyAdjunto('MANIFEST.XLSX')).toBe('manifiesto');
    expect(classifyAdjunto('data.csv')).toBe('manifiesto');
    expect(classifyAdjunto('note.txt')).toBe('otro');
  });
});

describe('ingestPrealerta — happy path', () => {
  it('hands the new caso straight to flight resolution', async () => {
    // Resolving the flight at ingest rather than waiting for the tick is what lets PA-04/PA-05 fire
    // while the cargo is still in the air, which is the whole point of the deadline mechanic.
    const out = await ingestPrealerta(payload(), { eventId: 'evt-f', expectedInboxId: '21' });
    expect(out.status).toBe('processed');
    if (out.status !== 'processed') return;
    expect(refreshVueloForOperacion).toHaveBeenCalledWith(out.operacionId);
  });

  it('creates the caso, archives every artifact, and writes the ledger', async () => {
    const out = await ingestPrealerta(payload(), { eventId: 'evt-1', expectedInboxId: '21' });
    expect(out.status).toBe('processed');
    if (out.status !== 'processed') return;
    expect(out.operacionCreated).toBe(true);
    expect(out.version).toBe(1);

    const op = await query<{ mawb: string; numero_vuelo: string; piezas_prealerta: number; etapa: string; agora_conversation_id: string }>(
      'SELECT mawb, numero_vuelo, piezas_prealerta, etapa, agora_conversation_id FROM operaciones',
    );
    expect(op.rows).toHaveLength(1);
    expect(op.rows[0].mawb).toBe('16094705516');
    expect(op.rows[0].numero_vuelo).toBe('CI5218');
    expect(Number(op.rows[0].piezas_prealerta)).toBe(1910);
    expect(op.rows[0].etapa).toBe('prealerta');
    expect(op.rows[0].agora_conversation_id).toBe('77');

    // The archived email plus both attachments — evidence lives here, not only in AGORA. Asserted as
    // a subset because automatic risk scoring now also persists a risk_analysis workbook.
    const files = await query<{ kind: string }>('SELECT kind FROM files ORDER BY kind');
    const kinds = files.rows.map((r) => r.kind);
    for (const k of ['awb', 'manifest', 'prealerta_email']) expect(kinds).toContain(k);

    const adj = await query<{ tipo: string; scan_verdict: string; content_hash: string }>(
      'SELECT tipo, scan_verdict, content_hash FROM prealerta_adjuntos ORDER BY tipo',
    );
    expect(adj.rows.map((r) => r.tipo)).toEqual(['awb', 'manifiesto']);
    expect(adj.rows[0].scan_verdict).toBe('clean');
    // The spreadsheet is honestly marked unscannable rather than given a fake clean bill.
    expect(adj.rows[1].scan_verdict).toBe('unscannable');
    expect(adj.rows[0].content_hash).toMatch(/^[0-9a-f]{64}$/);

    // Filtered to the prealerta family: the cotejo now adds its own event, and asserting an exact
    // whole-timeline array would break every time another rule family starts contributing.
    const ev = await query<{ tipo: string; origen: string; operacion_mawb: string }>(
      `SELECT tipo, origen, operacion_mawb FROM operacion_eventos WHERE tipo LIKE 'PREALERTA%'`,
    );
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0].tipo).toBe('PREALERTA_RECIBIDA');
    expect(ev.rows[0].origen).toBe('cliente');
    expect(ev.rows[0].operacion_mawb).toBe('16094705516');

    // Same hash chain as the documentary side: one GET /api/audit/verify covers both.
    const audit = await query<{ action: string; hash: string }>(
      `SELECT action, hash FROM audit_log WHERE action = 'PREALERTA_RECIBIDA'`,
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].hash).toMatch(/^[0-9a-f]{64}$/);

    expect(setConversationCustomAttributes).toHaveBeenCalledTimes(1);
  });

  it('scans the PDF but does not run the PDF scanner over a spreadsheet', async () => {
    await ingestPrealerta(payload(), { eventId: 'evt-1', expectedInboxId: '21' });
    expect(scanPedimentoPdf).toHaveBeenCalledTimes(1);
  });

  it('survives AGORA rejecting the custom-attribute decoration, and says so in the timeline', async () => {
    setConversationCustomAttributes.mockRejectedValueOnce(new Error('boom'));
    const out = await ingestPrealerta(payload(), { eventId: 'evt-1', expectedInboxId: '21' });
    // Decoration is convenience; it must never unwind a committed caso.
    expect(out.status).toBe('processed');
    // But it is no longer INVISIBLE: a sidebar that silently stops updating is how a coordinator ends
    // up trusting a stale etapa.
    const ev = await query<{ payload: { paso?: string } }>(
      `SELECT payload FROM operacion_eventos WHERE tipo = 'INGESTA_INCIDENCIA'`,
    );
    expect(ev.rows.map((r) => r.payload.paso)).toEqual(['espejo_agora']);
  });
});

describe('ingestPrealerta — the AGORA mirror (task #24)', () => {
  it('stamps the caso state onto the conversation from the LIVE row', async () => {
    // Composed from the row rather than hard-coded, so the sidebar shows the bandera count the cotejo
    // just wrote instead of a fixed `etapa: prealerta`.
    const out = await ingestPrealerta(payload(), { eventId: 'evt-esp', expectedInboxId: '21' });
    expect(out.status).toBe('processed');
    if (out.status !== 'processed') return;

    expect(setConversationCustomAttributes).toHaveBeenCalledTimes(1);
    const attrs = setConversationCustomAttributes.mock.calls[0][2];
    expect(attrs).toMatchObject({
      mawb: '16094705516',
      operacion_id: out.operacionId,
      etapa: 'prealerta',
    });
    // PA-01/PA-02/PA-03 + PA-08 all fire on this fixture; the exact number matters less than that the
    // count is real and non-zero.
    expect(Number(attrs.banderas)).toBeGreaterThan(0);
  });

  it('posts a PRIVATE note for the red flag the cotejo found', async () => {
    const out = await ingestPrealerta(payload(), { eventId: 'evt-nota', expectedInboxId: '21' });
    expect(out.status).toBe('processed');

    const notas = postMessage.mock.calls.map((c) => c[2]);
    expect(notas.length).toBeGreaterThan(0);
    // private: internal chatter must not be emailed to the client, and a non-private note would come
    // back through the message_created webhook looking like inbound mail.
    expect(notas.every((n) => n.private === true)).toBe(true);
    expect(notas.some((n) => n.content.includes('PA-02'))).toBe(true);
  });

  it('posts nothing when there is no conversation to post into', async () => {
    // A caso recovered without conversation context must not blow up the mirror.
    await ingestPrealerta(payload({ conversation: { inbox_id: 21 } }), {
      eventId: 'evt-sin-conv',
      expectedInboxId: '21',
    });
    expect(postMessage).not.toHaveBeenCalled();
    expect(setConversationCustomAttributes).not.toHaveBeenCalled();
  });
});

/**
 * Durable ingest incidents. Every block below the commit is best-effort on purpose, but "best-effort"
 * used to mean console.warn — i.e. invisible, which is exactly the operational complaint ("no hay un
 * log de errores claro"). The caso must keep standing AND the failure must become a timeline row.
 */
describe('ingestPrealerta — a failed post-commit step is recorded, not swallowed', () => {
  it('writes INGESTA_INCIDENCIA with paso `manifiesto` and still returns processed', async () => {
    ingestManifiestoFromPrealerta.mockRejectedValueOnce(new Error('hoja de cálculo corrupta'));

    const out = await ingestPrealerta(payload(), { eventId: 'evt-inc', expectedInboxId: '21' });
    // The caso stands: its evidence is archived and refusing it would have lost the shipment.
    expect(out.status).toBe('processed');
    if (out.status !== 'processed') return;
    expect((await query('SELECT 1 FROM operaciones')).rows).toHaveLength(1);
    expect((await query('SELECT 1 FROM manifests')).rows).toHaveLength(0);

    const ev = await query<{
      tipo: string;
      origen: string;
      operacion_mawb: string;
      payload: { paso?: string; error?: string };
    }>(
      `SELECT tipo, origen, operacion_mawb, payload FROM operacion_eventos
        WHERE tipo = 'INGESTA_INCIDENCIA'`,
    );
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0].origen).toBe('sistema');
    expect(ev.rows[0].operacion_mawb).toBe('16094705516');
    expect(ev.rows[0].payload.paso).toBe('manifiesto');
    expect(ev.rows[0].payload.error).toMatch(/hoja de cálculo corrupta/);

    // …and in the same hash chain as everything else, so one GET /api/audit/verify covers it.
    const audit = await query<{ after: { paso?: string }; hash: string }>(
      `SELECT after, hash FROM audit_log WHERE action = 'INGESTA_INCIDENCIA'`,
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].after.paso).toBe('manifiesto');
    expect(audit.rows[0].hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reaches the AGORA thread too, so the gap is visible where humans work', async () => {
    ingestManifiestoFromPrealerta.mockRejectedValueOnce(new Error('hoja de cálculo corrupta'));
    await ingestPrealerta(payload(), { eventId: 'evt-inc2', expectedInboxId: '21' });
    const notas = postMessage.mock.calls.map((c) => c[2]);
    expect(notas.some((n) => n.content.includes('INGESTA_INCIDENCIA') && n.content.includes('manifiesto'))).toBe(
      true,
    );
  });

  it('records paso `vuelo` when the flight lookup fails, without touching the caso', async () => {
    refreshVueloForOperacion.mockRejectedValueOnce(new Error('proveedor caído'));
    const out = await ingestPrealerta(payload(), { eventId: 'evt-inc3', expectedInboxId: '21' });
    expect(out.status).toBe('processed');
    const ev = await query<{ payload: { paso?: string } }>(
      `SELECT payload FROM operacion_eventos WHERE tipo = 'INGESTA_INCIDENCIA'`,
    );
    expect(ev.rows.map((r) => r.payload.paso)).toEqual(['vuelo']);
  });
});

describe('ingestPrealerta — the manifiesto reaches the manifest pipeline', () => {
  it('creates the manifest, promotes shipments, links the caso, and fires PA-02', async () => {
    // This is the join between the two systems. Before it, the manifiesto was archived and nothing
    // more, so the risk engine still needed a human to upload the same file by hand.
    const out = await ingestPrealerta(payload(), { eventId: 'evt-m', expectedInboxId: '21' });
    expect(out.status).toBe('processed');
    if (out.status !== 'processed') return;

    const man = await query<{ id: string; mawb_reference: string; ingestion_status: string }>(
      'SELECT id, mawb_reference, ingestion_status FROM manifests',
    );
    expect(man.rows).toHaveLength(1);
    expect(man.rows[0].mawb_reference).toBe('16094705516');
    expect(man.rows[0].ingestion_status).toBe('promoted');

    // Promoted to the gold layer, so the risk engine has rows to score.
    const ship = await query('SELECT 1 FROM shipments WHERE manifest_id = $1', [man.rows[0].id]);
    expect(ship.rows).toHaveLength(2);

    const op = await query<{ manifest_id: string; estado_documental: string; cotejo_version: string; discrepancias: Array<{ codigo: string; severidad: string; detalle?: Record<string, unknown> }> }>(
      'SELECT manifest_id, estado_documental, cotejo_version, discrepancias FROM operaciones WHERE id = $1',
      [out.operacionId],
    );
    expect(op.rows[0].manifest_id).toBe(man.rows[0].id);
    // Advances past 'cotejado' because risk now runs in the same pass — the state machine's eje 2
    // moving without a human is the point, so accept either post-risk state.
    expect(['cotejado', 'riesgo_ok', 'riesgo_con_hallazgos']).toContain(op.rows[0].estado_documental);
    // Tracks the engine rather than a literal, so adding a rule family does not break this test for a
    // reason that has nothing to do with what it is asserting.
    expect(op.rows[0].cotejo_version).toBe(COTEJO_RULESET_VERSION);

    // The email declared 1910 pieces; the manifest totals 35. That is the red flag Fernando derived
    // in the meeting, firing automatically.
    const pa02 = op.rows[0].discrepancias.find((d) => d.codigo === 'PA-02');
    expect(pa02?.severidad).toBe('error');
    expect(pa02?.detalle).toMatchObject({ declarado: 1910, manifiesto: 35 });

    const ev = await query<{ tipo: string }>('SELECT tipo FROM operacion_eventos ORDER BY id');
    expect(ev.rows.map((e) => e.tipo)).toContain('COTEJO_EJECUTADO');
  });

  it('scores risk automatically on the shipments it just promoted', async () => {
    // The last link that makes the pipeline self-driving: nobody clicked "run risk".
    const out = await ingestPrealerta(payload(), { eventId: 'evt-r', expectedInboxId: '21' });
    expect(out.status).toBe('processed');
    if (out.status !== 'processed') return;

    const ship = await query<{ risk_color: string | null; ruleset_hash: string | null }>(
      'SELECT risk_color, ruleset_hash FROM shipments',
    );
    expect(ship.rows).toHaveLength(2);
    for (const r of ship.rows) {
      expect(r.risk_color).toBeTruthy();
      // The ruleset hash is stamped on every row so a score can be replayed and defended later.
      expect(r.ruleset_hash).toMatch(/^[0-9a-f]{64}$/);
    }

    // The risk XLSX artifact is produced by the same code path the manual button uses.
    const files = await query<{ kind: string }>(
      `SELECT kind FROM files WHERE kind = 'risk_analysis'`,
    );
    expect(files.rows).toHaveLength(1);

    const man = await query<{ risk_stale: boolean; ruleset_version: string }>(
      'SELECT risk_stale, ruleset_version FROM manifests',
    );
    expect(man.rows[0].risk_stale).toBe(false);
    expect(man.rows[0].ruleset_version).toBeTruthy();

    // Eje 2 advanced off sin_cotejar without a human touching it.
    const op = await query<{ estado_documental: string }>(
      'SELECT estado_documental FROM operaciones WHERE id = $1', [out.operacionId]);
    expect(['riesgo_ok', 'riesgo_con_hallazgos']).toContain(op.rows[0].estado_documental);

    const ev = await query<{ tipo: string }>('SELECT tipo FROM operacion_eventos ORDER BY id');
    expect(ev.rows.map((e) => e.tipo)).toContain('RIESGO_EVALUADO');
    const audit = await query(`SELECT 1 FROM audit_log WHERE action = 'RIESGO_EVALUADO'`);
    expect(audit.rows).toHaveLength(1);
  });

  it('does not attempt scoring when no rows promoted', async () => {
    // A manifiesto whose every row fails validation leaves nothing to score; the caso must still
    // stand rather than erroring out.
    downloadAttachment.mockImplementation(async (_c: unknown, url: string) =>
      String(url).endsWith('.csv')
        ? Buffer.from('Columna Sin Sentido,Otra\nfoo,bar\n', 'utf8')
        : Buffer.from('%PDF-1.4 fake\n'),
    );
    const out = await ingestPrealerta(payload(), { eventId: 'evt-nr', expectedInboxId: '21' });
    expect(out.status).toBe('processed');
    expect((await query('SELECT 1 FROM shipments')).rows).toHaveLength(0);
    expect(
      (await query(`SELECT 1 FROM files WHERE kind = 'risk_analysis'`)).rows,
    ).toHaveLength(0);
  });

  it('attaches to an existing manifest for the same MAWB instead of violating the unique index', async () => {
    // mawb_reference is globally unique, so a manual upload or a resend must be joined, not duplicated.
    await query(
      `INSERT INTO manifests (mawb_reference, ingestion_status) VALUES ('16094705516','draft')`,
    );
    const out = await ingestPrealerta(payload(), { eventId: 'evt-a', expectedInboxId: '21' });
    expect(out.status).toBe('processed');
    if (out.status !== 'processed') return;

    const man = await query('SELECT 1 FROM manifests');
    expect(man.rows).toHaveLength(1);
    const op = await query<{ manifest_id: string }>(
      'SELECT manifest_id FROM operaciones WHERE id = $1', [out.operacionId]);
    expect(op.rows[0].manifest_id).toBeTruthy();
  });

  it('keeps the caso when the manifiesto cannot be parsed', async () => {
    // A malformed spreadsheet must not cost us the shipment; it becomes a reported gap instead.
    downloadAttachment.mockImplementation(async () => Buffer.from('not a spreadsheet at all'));
    const out = await ingestPrealerta(payload(), { eventId: 'evt-bad', expectedInboxId: '21' });
    expect(out.status).toBe('processed');
    const op = await query('SELECT 1 FROM operaciones');
    expect(op.rows).toHaveLength(1);
  });

  it('does not touch the manifest pipeline when an attachment was blocked', async () => {
    scanPedimentoPdf.mockResolvedValue({
      verdict: 'blocked',
      findings: [{ motor: 'RF08_ACTIVE_CONTENT', code: 'js', severity: 'critical', message: 'JS' }],
      motors: { rf08: 'blocked', rf10: 'clean' },
      scannedAt: '2026-08-06T00:00:00.000Z',
      bytesScanned: 14,
      policy: {} as never,
    } as never);
    await ingestPrealerta(payload(), { eventId: 'evt-blk', expectedInboxId: '21' });
    const man = await query('SELECT 1 FROM manifests');
    expect(man.rows).toHaveLength(0);
  });
});

describe('ingestPrealerta — client resolution and the operation-level cotejo', () => {
  /** A second prealerta for a DIFFERENT guía máster whose manifiesto repeats a house guía. */
  function payloadCompartido() {
    const body = BODY.replace('160-94705516', '160-11223344');
    return payload({
      id: 5100,
      content: body,
      content_attributes: {
        email: {
          subject: 'Prealert 160-11223344',
          message_id: '<msg-dup@client.example>',
          from: ['robot@shein.example'],
          text_content: { full: body },
        },
      },
      attachments: [
        {
          id: 21,
          file_type: 'file',
          data_url: 'https://agora.test/blob/manifiesto-compartido.csv',
          extension: 'csv',
        },
      ],
    });
  }

  async function discrepanciasDe(operacionId: string) {
    const { rows } = await query<{
      discrepancias: Array<{ codigo: string; severidad: string; detalle?: Record<string, unknown> }> | null;
    }>('SELECT discrepancias FROM operaciones WHERE id = $1', [operacionId]);
    return rows[0].discrepancias ?? [];
  }

  it('attaches the resolved client to the caso and stays quiet about PA-08', async () => {
    // client_platforms.email is plaintext, so the sender address matches it directly (see the note in
    // clientResolution.ts). Without this the caso has no tariff, no delivery address and cannot appear
    // in anyone's monthly report — which is why an unresolved sender is a reported finding.
    const c = await query<{ id: string }>(
      `INSERT INTO clients (name) VALUES ('SHEIN MX') RETURNING id`,
    );
    await query(
      `INSERT INTO client_platforms (client_id, commercial_name, email)
       VALUES ($1,'SHEIN','robot@shein.example')`,
      [c.rows[0].id],
    );

    const out = await ingestPrealerta(payload(), { eventId: 'evt-cli', expectedInboxId: '21' });
    expect(out.status).toBe('processed');
    if (out.status !== 'processed') return;

    const op = await query<{ client_id: string }>(
      'SELECT client_id FROM operaciones WHERE id = $1',
      [out.operacionId],
    );
    expect(op.rows[0].client_id).toBe(c.rows[0].id);

    // Carried into the manifest too, which is what makes the per-client header mappings apply.
    const man = await query<{ client_id: string }>('SELECT client_id FROM manifests');
    expect(man.rows[0].client_id).toBe(c.rows[0].id);

    const codes = (await discrepanciasDe(out.operacionId)).map((d) => d.codigo);
    expect(codes).not.toContain('PA-08');
    // The house guías are materialized, which is the precondition for PA-07 and for planning.
    const guias = await query<{ guia_norm: string; piezas: number; client_id: string }>(
      'SELECT guia_norm, piezas, client_id FROM operacion_guias WHERE operacion_id = $1 ORDER BY guia_norm',
      [out.operacionId],
    );
    expect(guias.rows.map((g) => g.guia_norm)).toEqual(['16094705516001', '16094705516002']);
    expect(guias.rows.map((g) => Number(g.piezas))).toEqual([10, 25]);
    expect(guias.rows[0].client_id).toBe(c.rows[0].id);
  });

  it('reports PA-08 for an unknown sender WITHOUT clobbering the manifest findings', async () => {
    // The merge bug this guards against: two rule families writing the same jsonb column, where a
    // naive full replacement makes the later one erase the earlier one's red flags. PA-02 (1910
    // declared pieces vs 35 in the manifest) must survive PA-08 being appended.
    const out = await ingestPrealerta(payload(), { eventId: 'evt-pa08', expectedInboxId: '21' });
    expect(out.status).toBe('processed');
    if (out.status !== 'processed') return;

    const ds = await discrepanciasDe(out.operacionId);
    const codes = ds.map((d) => d.codigo);
    // Both families coexist.
    for (const c of ['PA-01', 'PA-02', 'PA-03', 'PA-08']) expect(codes).toContain(c);

    const pa08 = ds.find((d) => d.codigo === 'PA-08');
    // A warning, not an error: an unrecognized mailbox is usually a new client, not misconduct.
    expect(pa08?.severidad).toBe('advertencia');
    expect(pa08?.detalle).toMatchObject({ remitente: 'robot@shein.example' });
    expect(ds.find((d) => d.codigo === 'PA-02')?.severidad).toBe('error');

    const op = await query<{ client_id: string | null; cotejo_version: string }>(
      'SELECT client_id, cotejo_version FROM operaciones WHERE id = $1',
      [out.operacionId],
    );
    expect(op.rows[0].client_id).toBeNull();
    expect(op.rows[0].cotejo_version).toBe(COTEJO_RULESET_VERSION);

    // The finding also reaches the append-only ledger and the hash chain: a red flag that lived only
    // in a mutable column could be overwritten with nothing left to show an auditor.
    const ev = await query<{ payload: { alcance?: string; discrepancias?: Array<{ codigo: string }> } }>(
      `SELECT payload FROM operacion_eventos
        WHERE tipo = 'COTEJO_EJECUTADO' AND payload->>'alcance' = 'operacion'`,
    );
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0].payload.discrepancias?.map((d) => d.codigo)).toContain('PA-08');
  });

  it('fires PA-07 as an error when a second caso repeats a house guía', async () => {
    // Two guías máster, one house guía in common: either a clerical duplicate or the same cargo being
    // moved under two records. Both need a human before anything is planned.
    const first = await ingestPrealerta(payload(), { eventId: 'evt-dup-1', expectedInboxId: '21' });
    const second = await ingestPrealerta(payloadCompartido(), {
      eventId: 'evt-dup-2',
      expectedInboxId: '21',
    });
    expect(first.status).toBe('processed');
    expect(second.status).toBe('processed');
    if (second.status !== 'processed') return;

    // Two distinct casos, each with its own guías.
    const ops = await query<{ mawb: string }>('SELECT mawb FROM operaciones ORDER BY mawb');
    expect(ops.rows.map((o) => o.mawb)).toEqual(['16011223344', '16094705516']);

    const ds = await discrepanciasDe(second.operacionId);
    const pa07 = ds.find((d) => d.codigo === 'PA-07');
    expect(pa07?.severidad).toBe('error');
    expect(pa07?.detalle).toMatchObject({ guias: ['16094705516001'], total: 1 });

    // …and only the shared guía is flagged: …-003 is unique to the second caso.
    const guias = await query<{ guia_norm: string }>(
      'SELECT guia_norm FROM operacion_guias WHERE operacion_id = $1 ORDER BY guia_norm',
      [second.operacionId],
    );
    expect(guias.rows.map((g) => g.guia_norm)).toEqual(['16094705516001', '16094705516003']);

    // The FIRST caso is not retro-flagged here: PA-07 is evaluated when a caso is ingested or
    // re-polled, so the older operación gains the finding on its next cycle. Asserted so the
    // asymmetry is a documented property rather than a surprise.
    expect((await discrepanciasDe(first.status === 'processed' ? first.operacionId : '')).map((d) => d.codigo))
      .not.toContain('PA-07');
  });

  it('does not accumulate duplicate guías when the same manifiesto is resent', async () => {
    await ingestPrealerta(payload(), { eventId: 'evt-g1', expectedInboxId: '21' });
    const resendBody = BODY.replace('Pieces: 1910', 'Pieces: 35');
    await ingestPrealerta(
      payload({
        id: 5004,
        content: resendBody,
        content_attributes: {
          email: {
            subject: 'Prealert 160-94705516 (updated)',
            message_id: '<msg-g2@client.example>',
            from: ['robot@shein.example'],
            text_content: { full: resendBody },
          },
        },
      }),
      { eventId: 'evt-g2', expectedInboxId: '21' },
    );
    const guias = await query<{ guia_norm: string; estado: string }>(
      'SELECT guia_norm, estado FROM operacion_guias ORDER BY guia_norm',
    );
    expect(guias.rows.map((g) => g.guia_norm)).toEqual(['16094705516001', '16094705516002']);
    expect(guias.rows.every((g) => g.estado === 'declarada')).toBe(true);

    // A resend must not make the caso look like duplicate cargo against itself.
    const ds = await query<{ discrepancias: Array<{ codigo: string }> }>(
      'SELECT discrepancias FROM operaciones',
    );
    expect(ds.rows[0].discrepancias.map((d) => d.codigo)).not.toContain('PA-07');
  });

  it('leaves a guía already retenida alone when the manifiesto is re-ingested', async () => {
    // The reason `estado` is excluded from the upsert: a re-ingest walking a retención back to
    // `declarada` would silently release cargo the authority is holding.
    const out = await ingestPrealerta(payload(), { eventId: 'evt-ret', expectedInboxId: '21' });
    expect(out.status).toBe('processed');
    if (out.status !== 'processed') return;
    await query(
      `UPDATE operacion_guias SET estado = 'retenida' WHERE guia_norm = '16094705516001'`,
    );

    const resendBody = BODY.replace('CI5218', 'CI5300');
    await ingestPrealerta(
      payload({
        id: 5005,
        content: resendBody,
        content_attributes: {
          email: {
            message_id: '<msg-ret2@client.example>',
            from: ['robot@shein.example'],
            text_content: { full: resendBody },
          },
        },
      }),
      { eventId: 'evt-ret2', expectedInboxId: '21' },
    );

    const g = await query<{ estado: string }>(
      `SELECT estado FROM operacion_guias WHERE guia_norm = '16094705516001'`,
    );
    expect(g.rows[0].estado).toBe('retenida');
  });
});

describe('ingestPrealerta — idempotency and resends', () => {
  it('treats a redelivered event id as a duplicate', async () => {
    await ingestPrealerta(payload(), { eventId: 'evt-1', expectedInboxId: '21' });
    const second = await ingestPrealerta(payload(), { eventId: 'evt-1', expectedInboxId: '21' });
    expect(second.status).toBe('duplicate');
    expect((await query('SELECT 1 FROM prealertas')).rows).toHaveLength(1);
    expect(
      (await query(`SELECT 1 FROM operacion_eventos WHERE tipo LIKE 'PREALERTA%'`)).rows,
    ).toHaveLength(1);
  });

  it('treats the same Message-ID arriving with a different event id as a duplicate', async () => {
    // This is the reconciliation sweep re-finding a message a webhook already delivered.
    await ingestPrealerta(payload(), { eventId: 'evt-1', expectedInboxId: '21' });
    const sweep = await ingestPrealerta(payload(), { eventId: 'evt-2', expectedInboxId: '21' });
    expect(sweep.status).toBe('duplicate');
    expect((await query('SELECT 1 FROM operaciones')).rows).toHaveLength(1);
  });

  it('versions the SAME caso when the client resends the guía with a new flight', async () => {
    await ingestPrealerta(payload(), { eventId: 'evt-1', expectedInboxId: '21' });

    const resendBody = BODY.replace('CI5218', 'CI5300').replace('2026-08-18', '2026-08-19');
    const resend = payload({
      id: 5002,
      content: resendBody,
      content_attributes: {
        email: {
          subject: 'Prealert 160-94705516 (updated)',
          message_id: '<msg-2@client.example>',
          from: ['robot@shein.example'],
          text_content: { full: resendBody },
        },
      },
    });
    const out = await ingestPrealerta(resend, { eventId: 'evt-3', expectedInboxId: '21' });

    expect(out.status).toBe('processed');
    if (out.status !== 'processed') return;
    expect(out.operacionCreated).toBe(false);
    expect(out.version).toBe(2);

    // One caso, two prealertas — never a forked case (R6 / D2).
    expect((await query('SELECT 1 FROM operaciones')).rows).toHaveLength(1);
    const op = await query<{ numero_vuelo: string; eta_pais: string }>(
      'SELECT numero_vuelo, eta_pais FROM operaciones',
    );
    expect(op.rows[0].numero_vuelo).toBe('CI5300');
    expect(new Date(op.rows[0].eta_pais).toISOString().slice(0, 10)).toBe('2026-08-19');

    const ev = await query<{ tipo: string }>(
      `SELECT tipo FROM operacion_eventos WHERE tipo LIKE 'PREALERTA%' ORDER BY id`,
    );
    expect(ev.rows.map((r) => r.tipo)).toEqual(['PREALERTA_RECIBIDA', 'PREALERTA_VERSIONADA']);
  });

  it('does not erase an established field when a later resend fails to parse it', async () => {
    await ingestPrealerta(payload(), { eventId: 'evt-1', expectedInboxId: '21' });
    const thin = 'Master AWB: 160-94705516\nFlight: CI5300';
    await ingestPrealerta(
      payload({
        id: 5003,
        content: thin,
        content_attributes: {
          email: { message_id: '<msg-3@client.example>', text_content: { full: thin } },
        },
      }),
      { eventId: 'evt-4', expectedInboxId: '21' },
    );
    const op = await query<{ piezas_prealerta: number; numero_vuelo: string }>(
      'SELECT piezas_prealerta, numero_vuelo FROM operaciones',
    );
    expect(Number(op.rows[0].piezas_prealerta)).toBe(1910); // preserved via COALESCE
    expect(op.rows[0].numero_vuelo).toBe('CI5300'); // refreshed
  });
});

describe('ingestPrealerta — what it refuses to act on', () => {
  it('ignores our own outgoing replies coming back through the webhook', async () => {
    const out = await ingestPrealerta(payload({ message_type: 'outgoing' }), { eventId: 'e' });
    expect(out.status).toBe('ignored');
    expect((await query('SELECT 1 FROM operaciones')).rows).toHaveLength(0);
  });

  it('ignores private internal notes', async () => {
    const out = await ingestPrealerta(payload({ private: true }), { eventId: 'e' });
    expect(out.status).toBe('ignored');
  });

  it('ignores traffic from an inbox it is not watching', async () => {
    const out = await ingestPrealerta(payload(), { eventId: 'e', expectedInboxId: '99' });
    expect(out.status).toBe('ignored');
    expect((await query('SELECT 1 FROM operaciones')).rows).toHaveLength(0);
  });

  it('ignores a non message_created event', async () => {
    const out = await ingestPrealerta(payload({ event: 'conversation_created' }), { eventId: 'e' });
    expect(out.status).toBe('ignored');
  });

  it('records but does not invent a caso when there is no guía máster', async () => {
    const noMawb = 'Cartons: 63\nPieces: 1910';
    const out = await ingestPrealerta(
      payload({
        content: noMawb,
        content_attributes: { email: { message_id: '<x@y>', text_content: { full: noMawb } } },
      }),
      { eventId: 'e', expectedInboxId: '21' },
    );
    expect(out.status).toBe('ignored');
    expect((await query('SELECT 1 FROM operaciones')).rows).toHaveLength(0);
    // The gap is visible in the chain rather than silent.
    const audit = await query(`SELECT 1 FROM audit_log WHERE action = 'PREALERTA_SIN_MAWB'`);
    expect(audit.rows).toHaveLength(1);
  });
});

describe('ingestPrealerta — blocked attachment', () => {
  it('rejects the prealerta and says why, instead of half-advancing the caso', async () => {
    scanPedimentoPdf.mockResolvedValue({
      verdict: 'blocked',
      findings: [{ motor: 'RF08_ACTIVE_CONTENT', code: 'js', severity: 'critical', message: 'JS' }],
      motors: { rf08: 'blocked', rf10: 'clean' },
      scannedAt: '2026-08-06T00:00:00.000Z',
      bytesScanned: 14,
      policy: {} as never,
    } as never);

    const out = await ingestPrealerta(payload(), { eventId: 'evt-b', expectedInboxId: '21' });
    expect(out.status).toBe('rejected');

    const pre = await query<{ estado: string; motivo_rechazo: string }>(
      'SELECT estado, motivo_rechazo FROM prealertas',
    );
    expect(pre.rows[0].estado).toBe('rechazada');
    expect(pre.rows[0].motivo_rechazo).toMatch(/adjunto_bloqueado/);

    const ev = await query<{ tipo: string }>(
      `SELECT tipo FROM operacion_eventos WHERE tipo LIKE 'PREALERTA%'`,
    );
    expect(ev.rows[0].tipo).toBe('PREALERTA_ADJUNTO_BLOQUEADO');

    // Every artifact is still archived — rule R-A keeps what arrived even when we refuse to act on
    // it, so an auditor can see exactly what was sent and why it was rejected.
    const files = await query<{ kind: string }>('SELECT kind FROM files ORDER BY kind');
    expect(files.rows.map((r) => r.kind).sort()).toEqual(['awb', 'manifest', 'prealerta_email']);
    const adj = await query<{ tipo: string }>('SELECT tipo FROM prealerta_adjuntos ORDER BY tipo');
    expect(adj.rows.map((r) => r.tipo)).toEqual(['awb', 'manifiesto']);
  });

  it('files an unrecognized attachment as evidencia, not as the archived message', async () => {
    const out = await ingestPrealerta(
      payload({
        attachments: [
          { id: 9, file_type: 'file', data_url: 'https://agora.test/blob/notes.txt', extension: 'txt' },
        ],
      }),
      { eventId: 'evt-o', expectedInboxId: '21' },
    );
    expect(out.status).toBe('processed');
    const files = await query<{ kind: string }>('SELECT kind FROM files ORDER BY kind');
    expect(files.rows.map((r) => r.kind)).toEqual(['evidencia', 'prealerta_email']);
    const adj = await query<{ tipo: string }>('SELECT tipo FROM prealerta_adjuntos');
    expect(adj.rows[0].tipo).toBe('otro');
  });
});

describe('operacion_eventos is append-only', () => {
  it('refuses UPDATE and DELETE at the database level', async () => {
    await ingestPrealerta(payload(), { eventId: 'evt-1', expectedInboxId: '21' });
    await expect(query(`UPDATE operacion_eventos SET tipo = 'FALSIFICADO'`)).rejects.toThrow(
      /append-only/,
    );
    await expect(query('DELETE FROM operacion_eventos')).rejects.toThrow(/append-only/);
  });

  it('refuses an override event with no motivo', async () => {
    const op = await query<{ id: string }>(
      `INSERT INTO operaciones (mawb) VALUES ('16000000001') RETURNING id`,
    );
    await expect(
      query(
        `INSERT INTO operacion_eventos (operacion_id, operacion_mawb, tipo, ocurrido_at, override)
         VALUES ($1,'16000000001','MANUAL',now(),true)`,
        [op.rows[0].id],
      ),
    ).rejects.toThrow(/override_motivo/);
  });
});
