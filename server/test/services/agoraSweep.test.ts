import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

/**
 * Reconciliation sweep tests. What matters here is NOT field extraction (the ingest suite owns that)
 * but the four properties that decide whether the safety net actually catches anything:
 *
 *   - a message the webhook never delivered is reprocessed through the SAME payload shape, with
 *     `eventId: null` so Message-ID dedupe is the gate
 *   - mail we already hold costs nothing (no ingest, no attachment download)
 *   - the watermark advances only over messages we provably examined, and is HELD BACK on any error —
 *     a bookmark that jumps past an unknown converts a transient failure into lost cargo
 *   - a recovery is visible in the ledger and the audit chain, so "this arrived through the sweep"
 *     is a recorded fact rather than an inference
 */

const ingestPrealerta = vi.fn();
vi.mock('../../src/services/prealertaIngest', () => ({
  ingestPrealerta: (...a: unknown[]) => ingestPrealerta(...(a as [])),
}));

vi.mock('../../src/services/agoraClient', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/agoraClient')>(
    '../../src/services/agoraClient',
  );
  return {
    ...actual,
    loadAgoraConfig: () => ({ baseUrl: 'https://agora.test', accountId: '9', token: 't' }),
  };
});

// ---- The AGORA HTTP surface. The sweep is the only reader of it, so the fetch layer is stubbed here
// rather than the client module: these tests then also cover URL construction and the two payload
// envelopes Chatwoot forks disagree about.
interface StubResponse {
  status?: number;
  body?: unknown;
  /** When set, the call rejects instead of responding — an AGORA outage rather than an HTTP error. */
  throws?: string;
}

let convPages: Record<number, StubResponse> = {};
let convMessages: Record<number, StubResponse> = {};
const fetchCalls: string[] = [];

function respond(stub: StubResponse | undefined): Response {
  const s = stub ?? { body: { payload: [] } };
  if (s.throws) throw new Error(s.throws);
  const status = s.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => s.body,
  } as unknown as Response;
}

const fetchMock = vi.fn(async (url: unknown) => {
  const u = String(url);
  fetchCalls.push(u);
  const msg = u.match(/\/conversations\/(\d+)\/messages/);
  if (msg) return respond(convMessages[Number(msg[1])]);
  if (u.includes('/conversations?')) {
    const page = Number(new URL(u).searchParams.get('page') ?? '1');
    return respond(convPages[page] ?? { body: { data: { payload: [] } } });
  }
  throw new Error(`fetch inesperado en el test: ${u}`);
});
vi.stubGlobal('fetch', fetchMock);

const { runAgoraSweep } = await import('../../src/services/agoraSweep');

const INBOX = '21';
const ORIGINAL_INBOX = process.env.AGORA_PREALERTAS_INBOX_ID;
const ORIGINAL_LOOKBACK = process.env.SWEEP_LOOKBACK_HOURS;
const ORIGINAL_CAP = process.env.SWEEP_MAX_MESSAGES;

/** Unix seconds, which is what Chatwoot serializes `created_at` as. */
function secondsAgo(n: number): number {
  return Math.floor(Date.now() / 1000) - n;
}

const BODY = ['Master AWB: 160-94705516', 'Flight: CI5218', 'Pieces: 1910'].join('\n');

function message(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 5001,
    content: BODY,
    message_type: 0,
    private: false,
    created_at: secondsAgo(600),
    conversation_id: 77,
    content_attributes: {
      email: {
        subject: 'Prealert 160-94705516',
        message_id: '<msg-1@client.example>',
        from: ['robot@shein.example'],
        text_content: { full: BODY },
      },
    },
    sender: { id: 3, email: 'robot@shein.example' },
    attachments: [
      { id: 1, file_type: 'file', data_url: 'https://agora.test/blob/awb.pdf', extension: 'pdf' },
    ],
    ...over,
  };
}

function conversationList(ids: number[]): StubResponse {
  return {
    body: {
      data: {
        payload: ids.map((id) => ({
          id,
          inbox_id: Number(INBOX),
          status: 'open',
          last_activity_at: secondsAgo(60),
          messages: [],
        })),
      },
    },
  };
}

async function seedCursor(over: {
  lastSyncedAt?: Date | null;
  lastError?: string | null;
  consecutiveErrors?: number;
} = {}): Promise<void> {
  await query(
    `INSERT INTO integracion_cursores (fuente, last_synced_at, last_error, consecutive_errors)
     VALUES ('agora_prealertas', $1, $2, $3)
     ON CONFLICT (fuente) DO UPDATE
       SET last_synced_at = $1, last_error = $2, consecutive_errors = $3,
           last_run_at = NULL, last_event_id = NULL`,
    [over.lastSyncedAt ?? null, over.lastError ?? null, over.consecutiveErrors ?? 0],
  );
}

async function cursor(): Promise<{
  last_synced_at: Date | null;
  last_run_at: Date | null;
  last_error: string | null;
  consecutive_errors: number;
  last_event_id: string | null;
}> {
  const r = await query<{
    last_synced_at: Date | null;
    last_run_at: Date | null;
    last_error: string | null;
    consecutive_errors: number;
    last_event_id: string | null;
  }>(
    `SELECT last_synced_at, last_run_at, last_error, consecutive_errors, last_event_id
       FROM integracion_cursores WHERE fuente = 'agora_prealertas'`,
  );
  return r.rows[0];
}

async function seedOperacion(mawb = '16094705516'): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO operaciones (mawb) VALUES ($1) RETURNING id`,
    [mawb],
  );
  return r.rows[0].id;
}

beforeEach(async () => {
  await truncateAll();
  vi.clearAllMocks();
  fetchCalls.length = 0;
  convPages = {};
  convMessages = {};
  ingestPrealerta.mockResolvedValue({ status: 'ignored', reason: 'sin_guia_master' });
  process.env.AGORA_PREALERTAS_INBOX_ID = INBOX;
  delete process.env.SWEEP_LOOKBACK_HOURS;
  delete process.env.SWEEP_MAX_MESSAGES;
  // `truncateAll` leaves integracion_cursores alone, so state would leak between tests.
  await seedCursor();
});

afterAll(() => {
  if (ORIGINAL_INBOX === undefined) delete process.env.AGORA_PREALERTAS_INBOX_ID;
  else process.env.AGORA_PREALERTAS_INBOX_ID = ORIGINAL_INBOX;
  if (ORIGINAL_LOOKBACK === undefined) delete process.env.SWEEP_LOOKBACK_HOURS;
  else process.env.SWEEP_LOOKBACK_HOURS = ORIGINAL_LOOKBACK;
  if (ORIGINAL_CAP === undefined) delete process.env.SWEEP_MAX_MESSAGES;
  else process.env.SWEEP_MAX_MESSAGES = ORIGINAL_CAP;
});

describe('runAgoraSweep — configuración', () => {
  it('se omite sin inbox configurado, sin llamar a AGORA', async () => {
    delete process.env.AGORA_PREALERTAS_INBOX_ID;
    const out = await runAgoraSweep();
    expect(out.omitido).toBe('inbox_no_configurado');
    expect(out.ok).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    // Missing configuration is not an AGORA failure: the cursor must not start accusing the provider.
    expect((await cursor()).consecutive_errors).toBe(0);
  });
});

describe('runAgoraSweep — recuperación', () => {
  it('reprocesa un mensaje nuevo con el payload del webhook y eventId null', async () => {
    convPages[1] = conversationList([77]);
    convMessages[77] = { body: { payload: [message()] } };

    const out = await runAgoraSweep();

    expect(out.ok).toBe(true);
    expect(out.conversaciones).toBe(1);
    expect(out.candidatos).toBe(1);
    expect(out.revisados).toBe(1);
    expect(ingestPrealerta).toHaveBeenCalledTimes(1);

    const [payload, opts] = ingestPrealerta.mock.calls[0] as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    // The ingest must not be able to tell this apart from a webhook delivery — same event name, same
    // string message_type (Chatwoot's numeric 0 mapped over), same nesting.
    expect(payload).toMatchObject({
      event: 'message_created',
      id: 5001,
      message_type: 'incoming',
      private: false,
      content: BODY,
      conversation: { id: 77, inbox_id: 21 },
      sender: { email: 'robot@shein.example' },
    });
    expect(
      (payload.content_attributes as { email: { message_id: string } }).email.message_id,
    ).toBe('<msg-1@client.example>');
    expect(payload.attachments).toHaveLength(1);
    // eventId is null on purpose: there is no AGORA event id for a message we pulled, and inventing
    // one would defeat the redelivery guard. Message-ID is the key that works on both routes.
    expect(opts).toEqual({ eventId: null, expectedInboxId: INBOX });
  });

  it('no vuelve a ingerir un Message-ID que ya está en la base', async () => {
    const operacionId = await seedOperacion();
    await query(
      `INSERT INTO prealertas (operacion_id, version, message_id, estado)
       VALUES ($1, 1, '<msg-1@client.example>', 'parseada')`,
      [operacionId],
    );
    convPages[1] = conversationList([77]);
    convMessages[77] = { body: { payload: [message()] } };

    const out = await runAgoraSweep();

    expect(ingestPrealerta).not.toHaveBeenCalled();
    expect(out.conocidas).toBe(1);
    expect(out.recuperadas).toBe(0);
    expect(out.detalle[0].status).toBe('conocida');
    // A known message still counts as examined, so the bookmark moves past it.
    expect(out.hasta).toBeTruthy();
  });

  it('avanza el cursor al created_at más reciente y limpia el estado de error', async () => {
    await seedCursor({ lastError: 'fallo anterior', consecutiveErrors: 3 });
    const viejo = secondsAgo(900);
    const nuevo = secondsAgo(120);
    convPages[1] = conversationList([77]);
    convMessages[77] = {
      body: {
        payload: [
          message({ id: 5001, created_at: viejo }),
          message({
            id: 5002,
            created_at: nuevo,
            content_attributes: {
              email: { message_id: '<msg-2@client.example>', text_content: { full: BODY } },
            },
          }),
        ],
      },
    };

    const out = await runAgoraSweep();

    expect(ingestPrealerta).toHaveBeenCalledTimes(2);
    expect(out.hasta).toBe(new Date(nuevo * 1000).toISOString());
    const cur = await cursor();
    expect(new Date(cur.last_synced_at as Date).getTime()).toBe(nuevo * 1000);
    expect(cur.last_error).toBeNull();
    expect(cur.consecutive_errors).toBe(0);
    expect(cur.last_run_at).toBeTruthy();
    expect(cur.last_event_id).toBe('5002');
  });

  it('procesa el resto del inbox cuando una conversación falla, y NO avanza el cursor', async () => {
    await seedCursor({ consecutiveErrors: 2 });
    convPages[1] = conversationList([77, 78]);
    convMessages[77] = { body: { payload: [message()] } };
    convMessages[78] = { throws: 'ECONNRESET al leer la conversación 78' };

    const out = await runAgoraSweep();

    // The healthy conversation is still swept…
    expect(ingestPrealerta).toHaveBeenCalledTimes(1);
    expect(out.errores).toBe(1);
    expect(out.ok).toBe(false);
    expect(out.erroresDetalle[0].conversationId).toBe(78);
    // …but the watermark is held back: we cannot prove what conversation 78 contained, and moving the
    // bookmark past an unknown is how a transient failure turns into cargo nobody planned for.
    expect(out.hasta).toBeNull();
    const cur = await cursor();
    expect(cur.last_synced_at).toBeNull();
    expect(cur.last_error).toMatch(/ECONNRESET/);
    expect(cur.consecutive_errors).toBe(3);
  });

  it('falla en bloque si no puede listar conversaciones, sin tocar la marca de agua', async () => {
    await seedCursor({ lastSyncedAt: new Date(Date.now() - 3_600_000) });
    convPages[1] = { throws: 'AGORA fuera de línea' };

    const out = await runAgoraSweep();

    expect(out.ok).toBe(false);
    expect(out.errores).toBe(1);
    expect(ingestPrealerta).not.toHaveBeenCalled();
    const cur = await cursor();
    expect(cur.last_error).toMatch(/no se pudieron listar conversaciones/);
    expect(cur.consecutive_errors).toBe(1);
    expect(cur.last_synced_at).toBeTruthy();
  });

  it('respeta la ventana de lookback cuando el cursor está vacío', async () => {
    process.env.SWEEP_LOOKBACK_HOURS = '1';
    convPages[1] = conversationList([77]);
    convMessages[77] = {
      body: {
        payload: [
          message({ id: 4000, created_at: secondsAgo(7200) }), // fuera de ventana
          message({
            id: 4001,
            created_at: secondsAgo(600),
            content_attributes: {
              email: { message_id: '<fresh@client.example>', text_content: { full: BODY } },
            },
          }),
        ],
      },
    };

    const out = await runAgoraSweep();

    expect(out.candidatos).toBe(1);
    expect(ingestPrealerta).toHaveBeenCalledTimes(1);
    const [payload] = ingestPrealerta.mock.calls[0] as [Record<string, unknown>];
    expect(payload.id).toBe(4001);
  });

  it('ignora salientes y notas privadas', async () => {
    convPages[1] = conversationList([77]);
    convMessages[77] = {
      body: {
        payload: [
          message({ id: 6001, message_type: 1 }),
          message({ id: 6002, message_type: 'outgoing' }),
          message({ id: 6003, private: true }),
        ],
      },
    };

    const out = await runAgoraSweep();

    expect(out.candidatos).toBe(0);
    expect(ingestPrealerta).not.toHaveBeenCalled();
  });

  it('aplica el tope por corrida de lo más viejo a lo más nuevo y marca truncado', async () => {
    process.env.SWEEP_MAX_MESSAGES = '2';
    const mk = (id: number, ago: number) =>
      message({
        id,
        created_at: secondsAgo(ago),
        content_attributes: {
          email: { message_id: `<m-${id}@client.example>`, text_content: { full: BODY } },
        },
      });
    convPages[1] = conversationList([77]);
    convMessages[77] = { body: { payload: [mk(1, 100), mk(2, 900), mk(3, 500)] } };

    const out = await runAgoraSweep();

    expect(out.truncado).toBe(true);
    expect(out.candidatos).toBe(3);
    expect(out.revisados).toBe(2);
    // Oldest first, so the watermark left behind is safe: nothing older than it went unexamined.
    const ids = ingestPrealerta.mock.calls.map((c) => (c[0] as { id: number }).id);
    expect(ids).toEqual([2, 3]);
    expect(out.hasta).toBeTruthy();
    const cur = await cursor();
    expect(new Date(cur.last_synced_at as Date).getTime()).toBeLessThan(Date.now() - 99_000);
  });
});

describe('runAgoraSweep — evidencia de la recuperación', () => {
  it('escribe el evento y la auditoría sólo cuando el ingest realmente procesó', async () => {
    const operacionId = await seedOperacion('16011122233');
    ingestPrealerta
      .mockResolvedValueOnce({
        status: 'processed',
        operacionId,
        prealertaId: '00000000-0000-0000-0000-000000000001',
        version: 1,
        operacionCreated: true,
        warnings: 0,
      })
      .mockResolvedValueOnce({ status: 'duplicate', prealertaId: 'x' });

    convPages[1] = conversationList([77]);
    convMessages[77] = {
      body: {
        payload: [
          message({ id: 7001, created_at: secondsAgo(900) }),
          message({
            id: 7002,
            created_at: secondsAgo(300),
            content_attributes: {
              email: { message_id: '<dup@client.example>', text_content: { full: BODY } },
            },
          }),
        ],
      },
    };

    const out = await runAgoraSweep();

    expect(out.recuperadas).toBe(1);
    expect(out.duplicadas).toBe(1);

    const ev = await query<{
      tipo: string;
      origen: string;
      operacion_mawb: string;
      payload: { messageId: string; conversationId: number };
    }>(`SELECT tipo, origen, operacion_mawb, payload FROM operacion_eventos`);
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0].tipo).toBe('PREALERTA_RECUPERADA_POR_BARRIDO');
    expect(ev.rows[0].origen).toBe('sistema');
    expect(ev.rows[0].operacion_mawb).toBe('16011122233');
    expect(ev.rows[0].payload).toEqual({
      messageId: '<msg-1@client.example>',
      conversationId: 77,
    });

    // Same fact in the hash chain, so GET /api/audit/verify covers the recovery too.
    const aud = await query<{ action: string; entity: string; entity_id: string }>(
      `SELECT action, entity, entity_id FROM audit_log`,
    );
    expect(aud.rows).toHaveLength(1);
    expect(aud.rows[0].action).toBe('PREALERTA_RECUPERADA_POR_BARRIDO');
    expect(aud.rows[0].entity).toBe('operacion');
    expect(aud.rows[0].entity_id).toBe(operacionId);
  });

  it('no deja rastro de recuperación cuando el mensaje fue ignorado o rechazado', async () => {
    ingestPrealerta
      .mockResolvedValueOnce({ status: 'ignored', reason: 'sin_guia_master' })
      .mockResolvedValueOnce({ status: 'rejected', reason: 'adjunto_bloqueado:x.pdf' });
    convPages[1] = conversationList([77]);
    convMessages[77] = {
      body: {
        payload: [
          message({ id: 8001, created_at: secondsAgo(900) }),
          message({
            id: 8002,
            created_at: secondsAgo(300),
            content_attributes: {
              email: { message_id: '<rej@client.example>', text_content: { full: BODY } },
            },
          }),
        ],
      },
    };

    const out = await runAgoraSweep();

    expect(out.ignoradas).toBe(1);
    expect(out.rechazadas).toBe(1);
    expect(out.recuperadas).toBe(0);
    const ev = await query(`SELECT 1 FROM operacion_eventos`);
    expect(ev.rows).toHaveLength(0);
    const aud = await query(`SELECT 1 FROM audit_log`);
    expect(aud.rows).toHaveLength(0);
  });

  it('un mensaje que revienta no cancela los demás ni mueve el cursor', async () => {
    ingestPrealerta
      .mockRejectedValueOnce(new Error('storage lleno'))
      .mockResolvedValueOnce({ status: 'ignored', reason: 'sin_guia_master' });
    convPages[1] = conversationList([77]);
    convMessages[77] = {
      body: {
        payload: [
          message({ id: 9001, created_at: secondsAgo(900) }),
          message({
            id: 9002,
            created_at: secondsAgo(300),
            content_attributes: {
              email: { message_id: '<second@client.example>', text_content: { full: BODY } },
            },
          }),
        ],
      },
    };

    const out = await runAgoraSweep();

    expect(ingestPrealerta).toHaveBeenCalledTimes(2);
    expect(out.errores).toBe(1);
    expect(out.detalle.map((d) => d.status)).toEqual(['error', 'ignorada']);
    expect(out.hasta).toBeNull();
    expect((await cursor()).last_synced_at).toBeNull();
  });
});

describe('runAgoraSweep — llamadas a la API', () => {
  it('consulta el inbox vigilado con status=all y pagina hasta agotar', async () => {
    convPages[1] = conversationList([77]);
    convPages[2] = { body: { payload: [] } };
    convMessages[77] = { body: { payload: [] } };

    await runAgoraSweep();

    expect(fetchCalls[0]).toBe(
      'https://agora.test/api/v1/accounts/9/conversations?inbox_id=21&status=all&page=1',
    );
    expect(fetchCalls).toContain(
      'https://agora.test/api/v1/accounts/9/conversations?inbox_id=21&status=all&page=2',
    );
    expect(fetchCalls).toContain(
      'https://agora.test/api/v1/accounts/9/conversations/77/messages',
    );
  });

  it('deja de paginar cuando una página entera es anterior a la ventana', async () => {
    convPages[1] = {
      body: {
        data: {
          payload: [{ id: 77, inbox_id: 21, last_activity_at: secondsAgo(48 * 3600) }],
        },
      },
    };
    convMessages[77] = { body: { payload: [] } };

    await runAgoraSweep();

    expect(fetchCalls.filter((u) => u.includes('/conversations?'))).toHaveLength(1);
  });
});
