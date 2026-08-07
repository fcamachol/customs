import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

/**
 * AGORA mirror tests (task #24).
 *
 * The mirror is decoration over a system of record, so the properties worth pinning are the ones that
 * decide whether it HELPS or HARMS:
 *
 *   - SELECTIVITY. The four-minute VUELO_ACTUALIZADO poll must never reach the inbox, and a clean
 *     cotejo must not either. A thread that stutters gets muted, and a muted thread is worse than none.
 *   - PRIVACY. Notes are private: internal chatter must not be emailed to the client, and a non-private
 *     note would come back through the ingest webhook.
 *   - IT NEVER THROWS. An AGORA outage cannot be allowed to unwind a committed caso or 500 a
 *     tramitador's field capture.
 *   - THE WHOLE ATTRIBUTE SET. Chatwoot REPLACES custom_attributes, so the state stamp is composed
 *     from the live row; a partial stamp would silently erase the semáforo.
 */

process.env.AGORA_BASE_URL = 'https://agora.test';
process.env.AGORA_ACCOUNT_ID = '9';
process.env.AGORA_API_ACCESS_TOKEN = 'tok';
process.env.OPS_TIMEZONE = 'America/Mexico_City';

interface Call {
  url: string;
  body: Record<string, unknown>;
}
const calls: Call[] = [];
let siguienteFalla: 'http' | 'red' | null = null;

const fetchMock = vi.fn(async (url: unknown, init?: { body?: string }) => {
  calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : {} });
  if (siguienteFalla === 'red') {
    siguienteFalla = null;
    throw new Error('AGORA inalcanzable');
  }
  if (siguienteFalla === 'http') {
    siguienteFalla = null;
    return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
  }
  return { ok: true, status: 200, json: async () => ({ id: 1 }) } as unknown as Response;
});
vi.stubGlobal('fetch', fetchMock);

const {
  esEventoEspejable,
  fechaCorta,
  formatearEvento,
  mirrorEstadoDeOperacion,
  mirrorEstadoToAgora,
  mirrorEventoToAgora,
} = await import('../../src/services/agoraMirror');

const CONV = '77';

beforeEach(async () => {
  await truncateAll();
  await query('TRUNCATE vuelos RESTART IDENTITY CASCADE');
  calls.length = 0;
  siguienteFalla = null;
  vi.clearAllMocks();
});

afterAll(() => {
  delete process.env.AGORA_BASE_URL;
  delete process.env.AGORA_ACCOUNT_ID;
  delete process.env.AGORA_API_ACCESS_TOKEN;
  delete process.env.OPS_TIMEZONE;
});

const CAMPO_SIETE = [
  'CARGA_DISPONIBLE',
  'INGRESO_PATIO',
  'INGRESO_ADUANA',
  'INICIO_CARGA',
  'FIN_CARGA',
  'MODULACION',
  'SALIDA_ROJO',
] as const;

describe('esEventoEspejable — what is worth a human’s attention', () => {
  it.each(CAMPO_SIETE)('mirrors the campo button %s', (tipo) => {
    expect(esEventoEspejable(tipo, {})).toBe(true);
  });

  it.each(['ARRIBO_VUELO', 'VUELO_DEMORADO', 'VUELO_CANCELADO', 'INGESTA_INCIDENCIA'] as const)(
    'mirrors %s',
    (tipo) => {
      expect(esEventoEspejable(tipo, {})).toBe(true);
    },
  );

  it('does NOT mirror VUELO_ACTUALIZADO, the four-minute poll', () => {
    // The single most important exclusion: this fires every cycle and would drown the thread.
    expect(esEventoEspejable('VUELO_ACTUALIZADO', { estado: 'en_ruta' })).toBe(false);
  });

  it('does not mirror the prealerta events, which ARE the AGORA message', () => {
    expect(esEventoEspejable('PREALERTA_RECIBIDA', {})).toBe(false);
    expect(esEventoEspejable('PREALERTA_VERSIONADA', {})).toBe(false);
  });

  it('mirrors a cotejo only when it carries an error-severity finding', () => {
    expect(esEventoEspejable('COTEJO_EJECUTADO', { discrepancias: [] })).toBe(false);
    expect(
      esEventoEspejable('COTEJO_EJECUTADO', {
        discrepancias: [{ codigo: 'PA-08', severidad: 'advertencia', mensaje: 'x' }],
      }),
    ).toBe(false);
    // Including the demoted inferred-value finding: an informativa is not something to interrupt for.
    expect(
      esEventoEspejable('COTEJO_EJECUTADO', {
        discrepancias: [{ codigo: 'PA-01', severidad: 'informativa', mensaje: 'inferido' }],
      }),
    ).toBe(false);
    expect(
      esEventoEspejable('COTEJO_EJECUTADO', {
        discrepancias: [{ codigo: 'PA-02', severidad: 'error', mensaje: 'piezas' }],
      }),
    ).toBe(true);
  });

  it('mirrors risk only when something must be validated before the previo', () => {
    expect(esEventoEspejable('RIESGO_EVALUADO', { summary: { validarEnPrevio: 0 } })).toBe(false);
    expect(esEventoEspejable('RIESGO_EVALUADO', { summary: { validarEnPrevio: 4 } })).toBe(true);
    expect(esEventoEspejable('RIESGO_EVALUADO', {})).toBe(false);
  });

  it('mirrors the freeze layer, because a freeze is what stops a flete en falso (CT-6)', () => {
    expect(esEventoEspejable('HOLD_GLOBAL_ABIERTO', {})).toBe(true);
    expect(esEventoEspejable('HOLD_GLOBAL_CERRADO', {})).toBe(true);
    expect(esEventoEspejable('RETENCION_CREADA', {})).toBe(true);
  });

  it('does not mirror an unknown tipo', () => {
    expect(esEventoEspejable('ALGO_NUEVO', {})).toBe(false);
  });
});

describe('formatearEvento — one compact Spanish line', () => {
  it('renders times in the operation’s timezone, not UTC', () => {
    // A note saying 21:03 for a landing the coordinator watched at 15:03 destroys trust in the mirror.
    expect(fechaCorta('2026-08-07T21:03:00.000Z')).toBe('07 ago 15:03');
    expect(fechaCorta('no es una fecha')).toBeNull();
    expect(fechaCorta(undefined)).toBeNull();
  });

  it('names the flight and the landing time', () => {
    expect(
      formatearEvento('ARRIBO_VUELO', { numeroVuelo: 'VB9521', arriboReal: '2026-08-07T21:03:00.000Z' }),
    ).toBe('🛬 ARRIBO_VUELO — VB9521 aterrizó 07 ago 15:03');
  });

  it('states the semáforo and how late the capture was (R33: phones are banned at the semáforo)', () => {
    const linea = formatearEvento('MODULACION', {
      semaforo: 'red',
      ocurridoAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    });
    expect(linea).toBe('🔴 MODULACION — semáforo red (capturado 5 min después)');
    expect(formatearEvento('MODULACION', { semaforo: 'green' })).toContain('🟢');
  });

  it('summarizes the red flags as declared-vs-manifest pairs', () => {
    const linea = formatearEvento('COTEJO_EJECUTADO', {
      discrepancias: [
        { codigo: 'PA-02', severidad: 'error', mensaje: 'x', detalle: { campo: 'piezas', declarado: 2914, manifiesto: 7732 } },
        { codigo: 'PA-08', severidad: 'advertencia', mensaje: 'remitente' },
      ],
    });
    expect(linea).toBe('⚠️ COTEJO — PA-02: piezas 2914 vs manifiesto 7732');
  });

  it('quotes the hold’s operational consequence verbatim from the ledger payload', () => {
    // The `efecto` sentence is what a coordinator acts on; paraphrasing it here would let the note
    // drift from the timeline row it mirrors.
    const linea = formatearEvento('HOLD_GLOBAL_ABIERTO', {
      tipoHold: 'aduana_cerrada',
      motivo: 'paro de labores',
      efecto: 'Se suspende la solicitud de unidades; la operación no se programa.',
    });
    expect(linea).toBe(
      '🧊 HOLD GLOBAL — se congela la planeación (aduana_cerrada): paro de labores. ' +
        'Se suspende la solicitud de unidades; la operación no se programa.',
    );
  });

  it('warns when a global release leaves casos still frozen by their own hold', () => {
    expect(
      formatearEvento('HOLD_GLOBAL_CERRADO', {
        efecto: 'Se reanuda la solicitud de unidades salvo que persista un hold propio.',
        operacionesAunBloqueadas: 2,
      }),
    ).toBe(
      '♻️ HOLD GLOBAL CERRADO — Se reanuda la solicitud de unidades salvo que persista un hold propio. ' +
        '2 caso(s) siguen con hold propio.',
    );
  });

  it('names the guía and the oficio on a retención', () => {
    expect(
      formatearEvento('RETENCION_CREADA', {
        alcance: 'guia',
        guia: '16094705516001',
        oficioReferencia: 'AGA-123/2026',
        motivo: 'verificación de mercancía',
      }),
    ).toBe('🚫 RETENCIÓN — la autoridad retuvo guía 16094705516001 (oficio AGA-123/2026): verificación de mercancía');
  });

  it('says which ingest step failed and why', () => {
    expect(formatearEvento('INGESTA_INCIDENCIA', { paso: 'manifiesto', error: 'hoja vacía' })).toBe(
      '🛠️ INGESTA_INCIDENCIA — falló el paso «manifiesto»: hoja vacía',
    );
  });

  it('falls back to tipo + timestamp for an unrecognized event instead of dropping it', () => {
    const linea = formatearEvento('ALGO_NUEVO', { ocurridoAt: '2026-08-07T21:03:00.000Z' });
    expect(linea).toBe('• ALGO_NUEVO 07 ago 15:03');
  });

  it('truncates a pathological line rather than posting a wall of text', () => {
    const linea = formatearEvento('INGESTA_INCIDENCIA', { paso: 'manifiesto', error: 'x'.repeat(5000) });
    expect(linea.length).toBeLessThanOrEqual(900);
    expect(linea.endsWith('…')).toBe(true);
  });
});

describe('mirrorEventoToAgora', () => {
  it('posts a PRIVATE note into the conversation', async () => {
    const ok = await mirrorEventoToAgora({
      operacionId: 'op-1',
      agoraConversationId: CONV,
      tipo: 'CARGA_DISPONIBLE',
      payloadResumen: { ocurridoAt: '2026-08-07T21:03:00.000Z' },
    });
    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://agora.test/api/v1/accounts/9/conversations/77/messages');
    // private: the client must not receive our operational chatter, AND a non-private note would come
    // back through the message_created webhook and look like inbound mail.
    expect(calls[0].body.private).toBe(true);
    expect(calls[0].body.content).toContain('CARGA_DISPONIBLE');
  });

  it('no-ops silently when the caso has no AGORA conversation', async () => {
    const ok = await mirrorEventoToAgora({
      operacionId: 'op-1',
      agoraConversationId: null,
      tipo: 'MODULACION',
      payloadResumen: { semaforo: 'red' },
    });
    expect(ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('no-ops when AGORA is not configured', async () => {
    const saved = process.env.AGORA_BASE_URL;
    delete process.env.AGORA_BASE_URL;
    try {
      const ok = await mirrorEventoToAgora({
        operacionId: 'op-1',
        agoraConversationId: CONV,
        tipo: 'MODULACION',
        payloadResumen: {},
      });
      expect(ok).toBe(false);
      expect(calls).toHaveLength(0);
    } finally {
      process.env.AGORA_BASE_URL = saved;
    }
  });

  it('posts nothing for a non-significant event', async () => {
    const ok = await mirrorEventoToAgora({
      operacionId: 'op-1',
      agoraConversationId: CONV,
      tipo: 'VUELO_ACTUALIZADO',
      payloadResumen: { estado: 'en_ruta' },
    });
    expect(ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('swallows an HTTP error and a network failure alike', async () => {
    siguienteFalla = 'http';
    await expect(
      mirrorEventoToAgora({
        operacionId: 'op-1',
        agoraConversationId: CONV,
        tipo: 'FIN_CARGA',
        payloadResumen: {},
      }),
    ).resolves.toBe(false);

    siguienteFalla = 'red';
    await expect(
      mirrorEventoToAgora({
        operacionId: 'op-1',
        agoraConversationId: CONV,
        tipo: 'FIN_CARGA',
        payloadResumen: {},
      }),
    ).resolves.toBe(false);
  });
});

describe('mirrorEstadoToAgora', () => {
  it('stamps the full attribute set', async () => {
    const ok = await mirrorEstadoToAgora({
      agoraConversationId: CONV,
      attrs: {
        mawb: '16094705516',
        operacion_id: 'op-1',
        etapa: 'arribado',
        semaforo: 'red',
        vuelo_estado: 'aterrizado',
        banderas: 3,
      },
    });
    expect(ok).toBe(true);
    expect(calls[0].url).toBe(
      'https://agora.test/api/v1/accounts/9/conversations/77/custom_attributes',
    );
    expect(calls[0].body.custom_attributes).toEqual({
      mawb: '16094705516',
      operacion_id: 'op-1',
      etapa: 'arribado',
      semaforo: 'red',
      vuelo_estado: 'aterrizado',
      banderas: 3,
    });
  });

  it('omits unknown values instead of writing them as null into the sidebar', async () => {
    await mirrorEstadoToAgora({
      agoraConversationId: CONV,
      attrs: { mawb: 'm', operacion_id: 'o', etapa: 'prealerta', semaforo: null, vuelo_estado: null, banderas: 0 },
    });
    expect(calls[0].body.custom_attributes).toEqual({
      mawb: 'm',
      operacion_id: 'o',
      etapa: 'prealerta',
      banderas: 0,
    });
  });

  it('never throws when AGORA rejects the write', async () => {
    siguienteFalla = 'http';
    await expect(
      mirrorEstadoToAgora({
        agoraConversationId: CONV,
        attrs: { mawb: 'm', operacion_id: 'o', etapa: 'prealerta' },
      }),
    ).resolves.toBe(false);
  });
});

describe('mirrorEstadoDeOperacion — composed from the live row', () => {
  async function seedOperacion(over: Record<string, unknown> = {}): Promise<string> {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO operaciones (mawb, etapa, semaforo, agora_conversation_id, discrepancias)
       VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING id`,
      [
        (over.mawb as string) ?? '16094705516',
        (over.etapa as string) ?? 'arribado',
        (over.semaforo as string | null) ?? null,
        over.agora_conversation_id === undefined ? CONV : (over.agora_conversation_id as string | null),
        over.discrepancias === undefined
          ? JSON.stringify([
              { codigo: 'PA-02', severidad: 'error', mensaje: 'piezas' },
              { codigo: 'PA-08', severidad: 'advertencia', mensaje: 'remitente' },
            ])
          : (over.discrepancias as string | null),
      ],
    );
    return rows[0].id;
  }

  it('reads mawb, etapa, semáforo, flight state and the bandera count off the row', async () => {
    const id = await seedOperacion({ semaforo: 'red' });
    const v = await query<{ id: string }>(
      `INSERT INTO vuelos (numero_vuelo, fecha_operacion, estado)
       VALUES ('CI5218','2026-08-07','aterrizado') RETURNING id`,
    );
    await query('UPDATE operaciones SET vuelo_id = $2 WHERE id = $1', [id, v.rows[0].id]);

    const ok = await mirrorEstadoDeOperacion(id);
    expect(ok).toBe(true);
    expect(calls[0].body.custom_attributes).toEqual({
      mawb: '16094705516',
      operacion_id: id,
      etapa: 'arribado',
      semaforo: 'red',
      vuelo_estado: 'aterrizado',
      // The COUNT, not a boolean: "2 banderas" tells a coordinator more than "sí", and it sorts.
      banderas: 2,
    });
  });

  it('reports zero banderas for a clean caso', async () => {
    const id = await seedOperacion({ discrepancias: null });
    await mirrorEstadoDeOperacion(id);
    expect(calls[0].body.custom_attributes).toMatchObject({ banderas: 0 });
  });

  it('no-ops for a caso with no AGORA conversation', async () => {
    const id = await seedOperacion({ agora_conversation_id: null });
    expect(await mirrorEstadoDeOperacion(id)).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('no-ops rather than throwing for an operación that does not exist', async () => {
    expect(await mirrorEstadoDeOperacion('00000000-0000-0000-0000-000000000000')).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
