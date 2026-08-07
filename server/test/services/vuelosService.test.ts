import { beforeEach, describe, expect, it, vi } from 'vitest';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';
import type { FlightSnapshot } from '../../src/services/flightProviders';
import { COTEJO_RULESET_VERSION } from '../../../shared/operaciones/cotejo';
import type { MirrorEventoInput } from '../../src/services/agoraMirror';

/**
 * Flight refresh: the behaviours that matter are (a) etapa is DERIVED from the feed and only ever
 * advances, (b) a provider outage is never mistaken for evidence about the flight, and (c) re-running
 * the poll does not accumulate duplicate findings or duplicate events.
 */

const lookupFlight = vi.fn();

vi.mock('../../src/services/flightProviders', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/flightProviders')>(
    '../../src/services/flightProviders',
  );
  return { ...actual, lookupFlight: (...a: unknown[]) => lookupFlight(...(a as [])) };
});

/** The AGORA mirror (task #24), stubbed at the module boundary — see agoraMirror.test.ts for wording. */
const mirrorEventoToAgora = vi.fn(async (_input: MirrorEventoInput) => true);
const mirrorEstadoDeOperacion = vi.fn(async (_operacionId: string) => true);
vi.mock('../../src/services/agoraMirror', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/agoraMirror')>(
    '../../src/services/agoraMirror',
  );
  return {
    ...actual,
    mirrorEventoToAgora: (...a: unknown[]) =>
      mirrorEventoToAgora(...(a as Parameters<typeof mirrorEventoToAgora>)),
    mirrorEstadoDeOperacion: (...a: unknown[]) =>
      mirrorEstadoDeOperacion(...(a as Parameters<typeof mirrorEstadoDeOperacion>)),
  };
});

const { refreshVueloForOperacion, refreshVuelosPendientes } = await import(
  '../../src/services/vuelosService'
);

function snapshot(over: Partial<FlightSnapshot> = {}): FlightSnapshot {
  return {
    fuente: 'flightaware.aeroapi',
    tieneItinerario: true,
    aerolinea: 'CI',
    origenIata: 'HKG',
    destinoIata: 'NLU',
    etdProgramado: '2026-08-16T02:00:00.000Z',
    etaProgramado: '2026-08-18T06:00:00.000Z',
    etdReal: null,
    etaEstimado: null,
    arriboReal: null,
    estado: 'en_ruta',
    posicion: null,
    raw: { probe: true },
    ...over,
  };
}

async function seedOperacion(over: Partial<Record<string, unknown>> = {}): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO operaciones
       (mawb, mawb_raw, origen_iata, destino_iata, numero_vuelo, etd_origen, eta_pais,
        agora_conversation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [
      (over.mawb as string) ?? '16094705516',
      '160-94705516',
      (over.origen_iata as string) ?? 'HKG',
      (over.destino_iata as string) ?? 'NLU',
      over.numero_vuelo === undefined ? 'CI5218' : (over.numero_vuelo as string | null),
      '2026-08-16T02:00:00.000Z',
      (over.eta_pais as string) ?? '2026-08-18T06:00:00.000Z',
      // The caso came in as client mail, so there is a thread for the mirror to post into (task #24).
      over.agora_conversation_id === undefined ? '77' : (over.agora_conversation_id as string | null),
    ],
  );
  return rows[0].id;
}

beforeEach(async () => {
  await truncateAll();
  await query(`TRUNCATE vuelos RESTART IDENTITY CASCADE`);
  vi.clearAllMocks();
  lookupFlight.mockResolvedValue({ snapshot: snapshot(), errors: [] });
});

describe('refreshVueloForOperacion — etapa is derived from the feed', () => {
  it('advances prealerta → en_vuelo when the flight is airborne', async () => {
    const id = await seedOperacion();
    const r = await refreshVueloForOperacion(id);
    expect(r.status).toBe('actualizado');
    expect(r.estadoVuelo).toBe('en_ruta');

    const op = await query<{ etapa: string; vuelo_id: string; cotejo_version: string }>(
      'SELECT etapa, vuelo_id, cotejo_version FROM operaciones WHERE id = $1', [id]);
    expect(op.rows[0].etapa).toBe('en_vuelo');
    expect(op.rows[0].vuelo_id).toBeTruthy();
    // The stamp is the ruleset the finding can be re-derived from, so assert it tracks the engine
    // rather than a literal this test would have to chase on every rule addition.
    expect(op.rows[0].cotejo_version).toBe(COTEJO_RULESET_VERSION);

    const ev = await query<{ tipo: string; origen: string }>(
      'SELECT tipo, origen FROM operacion_eventos WHERE operacion_id = $1', [id]);
    expect(ev.rows.map((e) => e.tipo)).toEqual(['VUELO_ACTUALIZADO']);
    expect(ev.rows[0].origen).toBe('feed_vuelo');
  });

  it('advances to arribado and stamps arribo_vuelo_at on landing', async () => {
    const id = await seedOperacion();
    lookupFlight.mockResolvedValue({
      snapshot: snapshot({ estado: 'aterrizado', arriboReal: '2026-08-18T06:12:00.000Z' }),
      errors: [],
    });
    const r = await refreshVueloForOperacion(id);
    expect(r.etapaAvanzada).toBe('arribado');

    const op = await query<{ etapa: string; arribo_vuelo_at: string }>(
      'SELECT etapa, arribo_vuelo_at FROM operaciones WHERE id = $1', [id]);
    expect(op.rows[0].etapa).toBe('arribado');
    expect(new Date(op.rows[0].arribo_vuelo_at).toISOString()).toBe('2026-08-18T06:12:00.000Z');

    const ev = await query<{ tipo: string }>('SELECT tipo FROM operacion_eventos');
    expect(ev.rows[0].tipo).toBe('ARRIBO_VUELO');
  });

  it('never regresses the etapa when the feed reports something earlier', async () => {
    const id = await seedOperacion();
    lookupFlight.mockResolvedValue({ snapshot: snapshot({ estado: 'aterrizado' }), errors: [] });
    await refreshVueloForOperacion(id);
    lookupFlight.mockResolvedValue({ snapshot: snapshot({ estado: 'en_ruta' }), errors: [] });
    await refreshVueloForOperacion(id);
    const op = await query<{ etapa: string }>('SELECT etapa FROM operaciones WHERE id = $1', [id]);
    expect(op.rows[0].etapa).toBe('arribado');
  });

  it('emits a distinct event for a delay and for a cancellation', async () => {
    const id = await seedOperacion();
    lookupFlight.mockResolvedValue({ snapshot: snapshot({ estado: 'demorado' }), errors: [] });
    await refreshVueloForOperacion(id);
    lookupFlight.mockResolvedValue({ snapshot: snapshot({ estado: 'cancelado' }), errors: [] });
    await refreshVueloForOperacion(id);
    const ev = await query<{ tipo: string }>('SELECT tipo FROM operacion_eventos ORDER BY id');
    expect(ev.rows.map((e) => e.tipo)).toEqual(['VUELO_DEMORADO', 'VUELO_CANCELADO']);
  });
});

describe('refreshVueloForOperacion — cotejo', () => {
  it('persists PA-04 when the real route contradicts the declaration', async () => {
    const id = await seedOperacion();
    lookupFlight.mockResolvedValue({ snapshot: snapshot({ destinoIata: 'MEX' }), errors: [] });
    await refreshVueloForOperacion(id);
    const op = await query<{ discrepancias: Array<{ codigo: string; severidad: string }> }>(
      'SELECT discrepancias FROM operaciones WHERE id = $1', [id]);
    const ds = op.rows[0].discrepancias;
    expect(ds.map((d) => d.codigo)).toContain('PA-04');
    expect(ds.find((d) => d.codigo === 'PA-04')?.severidad).toBe('error');
  });

  it('does not accumulate duplicate findings across repeated polls', async () => {
    const id = await seedOperacion();
    lookupFlight.mockResolvedValue({ snapshot: snapshot({ destinoIata: 'MEX' }), errors: [] });
    await refreshVueloForOperacion(id);
    await refreshVueloForOperacion(id);
    await refreshVueloForOperacion(id);
    const op = await query<{ discrepancias: Array<{ codigo: string }> }>(
      'SELECT discrepancias FROM operaciones WHERE id = $1', [id]);
    expect(op.rows[0].discrepancias.filter((d) => d.codigo === 'PA-04')).toHaveLength(1);
  });

  it('records PA-10 when the flight is declared as bare digits', async () => {
    const id = await seedOperacion({ numero_vuelo: '160' });
    const r = await refreshVueloForOperacion(id);
    expect(r.status).toBe('sin_vuelo_declarado');
    expect(lookupFlight).not.toHaveBeenCalled(); // nothing to ask any provider
    const op = await query<{ discrepancias: Array<{ codigo: string }> }>(
      'SELECT discrepancias FROM operaciones WHERE id = $1', [id]);
    expect(op.rows[0].discrepancias.map((d) => d.codigo)).toEqual(['PA-10']);
  });

  it('records PA-10 when every provider answered but none identified the flight', async () => {
    const id = await seedOperacion();
    lookupFlight.mockResolvedValue({ snapshot: null, errors: [] });
    const r = await refreshVueloForOperacion(id);
    expect(r.status).toBe('no_identificado');
    const op = await query<{ discrepancias: Array<{ codigo: string }> }>(
      'SELECT discrepancias FROM operaciones WHERE id = $1', [id]);
    expect(op.rows[0].discrepancias.map((d) => d.codigo)).toEqual(['PA-10']);
  });
});

describe('refreshVueloForOperacion — a provider outage is not evidence', () => {
  it('reports error_proveedor and writes NO discrepancy about the flight', async () => {
    // The distinction that matters: "we could not ask" must never be recorded as "the flight does
    // not exist", or an API outage would start flagging every shipment as suspicious.
    const id = await seedOperacion();
    lookupFlight.mockResolvedValue({
      snapshot: null,
      errors: [{ provider: 'adsb.lol', message: 'timeout' }],
    });
    const r = await refreshVueloForOperacion(id);
    expect(r.status).toBe('error_proveedor');
    expect(r.errores?.[0].provider).toBe('adsb.lol');

    const op = await query<{ discrepancias: unknown }>(
      'SELECT discrepancias FROM operaciones WHERE id = $1', [id]);
    expect(op.rows[0].discrepancias).toBeNull();
    const ev = await query('SELECT 1 FROM operacion_eventos WHERE operacion_id = $1', [id]);
    expect(ev.rows).toHaveLength(0);
    // But the attempt is recorded, so a persistent outage is visible.
    const v = await query<{ ultima_consulta_at: string }>('SELECT ultima_consulta_at FROM vuelos');
    expect(v.rows[0].ultima_consulta_at).toBeTruthy();
  });
});

describe('shared flight rows', () => {
  it('two operaciones on the same leg share one vuelos row, so a delay cascades once', async () => {
    const a = await seedOperacion({ mawb: '16000000001' });
    const b = await seedOperacion({ mawb: '16000000002' });
    await refreshVueloForOperacion(a);
    await refreshVueloForOperacion(b);
    const v = await query('SELECT 1 FROM vuelos');
    expect(v.rows).toHaveLength(1);
    const ops = await query<{ vuelo_id: string }>('SELECT vuelo_id FROM operaciones ORDER BY mawb');
    expect(ops.rows[0].vuelo_id).toBe(ops.rows[1].vuelo_id);
  });
});

describe('the AGORA mirror (task #24) — selective by design', () => {
  it('does NOT mirror the routine poll, which fires every four minutes', async () => {
    // The exclusion that decides whether humans keep reading the thread at all.
    const id = await seedOperacion();
    await refreshVueloForOperacion(id);
    const ev = await query<{ tipo: string }>('SELECT tipo FROM operacion_eventos WHERE operacion_id = $1', [id]);
    expect(ev.rows.map((e) => e.tipo)).toEqual(['VUELO_ACTUALIZADO']);
    expect(mirrorEventoToAgora).not.toHaveBeenCalled();
    expect(mirrorEstadoDeOperacion).not.toHaveBeenCalled();
  });

  it('mirrors a landing, with the flight number and the real arrival', async () => {
    const id = await seedOperacion();
    lookupFlight.mockResolvedValue({
      snapshot: snapshot({ estado: 'aterrizado', arriboReal: '2026-08-18T06:12:00.000Z' }),
      errors: [],
    });
    await refreshVueloForOperacion(id);
    expect(mirrorEventoToAgora).toHaveBeenCalledTimes(1);
    expect(mirrorEventoToAgora.mock.calls[0][0]).toMatchObject({
      operacionId: id,
      agoraConversationId: '77',
      tipo: 'ARRIBO_VUELO',
      payloadResumen: { numeroVuelo: 'CI5218', estado: 'aterrizado', arriboReal: '2026-08-18T06:12:00.000Z' },
    });
    // Re-read and re-stamped from the live row, so the field capture's semáforo is not erased.
    expect(mirrorEstadoDeOperacion).toHaveBeenCalledWith(id);
  });

  it.each(['demorado', 'cancelado'] as const)('mirrors a %s', async (estado) => {
    const id = await seedOperacion();
    lookupFlight.mockResolvedValue({ snapshot: snapshot({ estado }), errors: [] });
    await refreshVueloForOperacion(id);
    expect(mirrorEventoToAgora).toHaveBeenCalledTimes(1);
  });

  it('never lets a mirror failure unwind the refresh', async () => {
    const id = await seedOperacion();
    mirrorEventoToAgora.mockRejectedValueOnce(new Error('AGORA caída'));
    lookupFlight.mockResolvedValue({ snapshot: snapshot({ estado: 'cancelado' }), errors: [] });
    await expect(refreshVueloForOperacion(id)).resolves.toMatchObject({ status: 'actualizado' });
    const ev = await query<{ tipo: string }>('SELECT tipo FROM operacion_eventos WHERE operacion_id = $1', [id]);
    expect(ev.rows.map((e) => e.tipo)).toEqual(['VUELO_CANCELADO']);
  });
});

describe('refreshVuelosPendientes', () => {
  it('only polls casos still in motion', async () => {
    const moving = await seedOperacion({ mawb: '16000000003' });
    const delivered = await seedOperacion({ mawb: '16000000004' });
    await query(`UPDATE operaciones SET etapa = 'entregado' WHERE id = $1`, [delivered]);

    const results = await refreshVuelosPendientes(50);
    expect(results.map((r) => r.operacionId)).toEqual([moving]);
  });

  it('skips a flight queried moments ago, to avoid burning metered provider calls', async () => {
    const id = await seedOperacion();
    await refreshVueloForOperacion(id);
    const again = await refreshVuelosPendientes(50);
    expect(again).toHaveLength(0);
  });
});
