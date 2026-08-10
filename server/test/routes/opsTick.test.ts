import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

/**
 * Route tests for POST /api/ops/tick.
 *
 * These exist because of a real bug that reached production: the cursor UPDATE used a bare `$n`
 * inside a CASE, which Postgres rejects with 42P08 ("could not determine data type of parameter").
 * The service had thorough unit coverage but nothing executed the ROUTE's own SQL against a real
 * database, so a syntactically fine query failed only at runtime. Hence: mock the flight work, run
 * the route, and let Postgres judge the statement.
 */

const refreshVuelosPendientes = vi.fn(async () => [] as unknown[]);
vi.mock('../../src/services/vuelosService', () => ({
  refreshVuelosPendientes: (...a: unknown[]) => refreshVuelosPendientes(...(a as [])),
  refreshVueloForOperacion: async () => undefined,
}));

// The prealerta sweep is the tick's second phase; its own behaviour is covered in
// services/agoraSweep.test.ts, so here it is stubbed and the questions are only about the ROUTE:
// does the summary reach the caller, and can one phase take the other down?
const SWEEP_OK = {
  ok: true,
  omitido: null,
  desde: '2026-08-06T00:00:00.000Z',
  hasta: '2026-08-06T01:00:00.000Z',
  conversaciones: 2,
  candidatos: 1,
  revisados: 1,
  recuperadas: 1,
  conocidas: 0,
  duplicadas: 0,
  ignoradas: 0,
  rechazadas: 0,
  errores: 0,
  truncado: false,
  detalle: [],
  erroresDetalle: [],
};
const runAgoraSweep = vi.fn(async () => SWEEP_OK as unknown);
vi.mock('../../src/services/agoraSweep', () => ({
  runAgoraSweep: (...a: unknown[]) => runAgoraSweep(...(a as [])),
}));

const { createApp } = await import('../../src/app');
const app = createApp();

const ORIGINAL = process.env.OPS_TICK_TOKEN;
const TOKEN = 'tick-secret-for-tests';

beforeEach(async () => {
  await truncateAll();
  vi.clearAllMocks();
  refreshVuelosPendientes.mockResolvedValue([]);
  runAgoraSweep.mockResolvedValue(SWEEP_OK);
  process.env.OPS_TICK_TOKEN = TOKEN;
  // truncateAll wipes the seeded cursor rows, so restore the one the route updates.
  await query(
    `INSERT INTO integracion_cursores (fuente) VALUES ('vuelos') ON CONFLICT (fuente) DO NOTHING`,
  );
  await query(
    `INSERT INTO integracion_cursores (fuente) VALUES ('replan') ON CONFLICT (fuente) DO NOTHING`,
  );
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.OPS_TICK_TOKEN;
  else process.env.OPS_TICK_TOKEN = ORIGINAL;
});

describe('POST /api/ops/tick — authorization', () => {
  it('refuses a request with no token', async () => {
    await request(app).post('/api/ops/tick').expect(401);
  });

  it('refuses a wrong token', async () => {
    await request(app).post('/api/ops/tick').set('x-ops-token', 'nope').expect(401);
  });

  it('accepts the token via x-ops-token', async () => {
    await request(app).post('/api/ops/tick').set('x-ops-token', TOKEN).expect(200);
  });

  it('accepts the token as a bearer, for schedulers that only send Authorization', async () => {
    await request(app).post('/api/ops/tick').set('authorization', `Bearer ${TOKEN}`).expect(200);
  });

  it('fails closed with 503 when no secret is configured', async () => {
    delete process.env.OPS_TICK_TOKEN;
    await request(app).post('/api/ops/tick').set('x-ops-token', TOKEN).expect(503);
  });
});

describe('POST /api/ops/tick — behaviour', () => {
  it('runs the refresh and advances the cursor', async () => {
    const res = await request(app).post('/api/ops/tick').set('x-ops-token', TOKEN).expect(200);
    expect(res.body.ok).toBe(true);
    expect(refreshVuelosPendientes).toHaveBeenCalled();

    const cur = await query<{ last_run_at: string; last_error: string | null; consecutive_errors: number }>(
      `SELECT last_run_at, last_error, consecutive_errors FROM integracion_cursores WHERE fuente='vuelos'`,
    );
    expect(cur.rows[0].last_run_at).toBeTruthy();
    expect(cur.rows[0].last_error).toBeNull();
    expect(Number(cur.rows[0].consecutive_errors)).toBe(0);
  });

  it('summarizes each outcome bucket', async () => {
    refreshVuelosPendientes.mockResolvedValue([
      { operacionId: 'a', mawb: '1', status: 'actualizado' },
      { operacionId: 'b', mawb: '2', status: 'sin_cambio' },
      { operacionId: 'c', mawb: '3', status: 'no_identificado' },
      { operacionId: 'd', mawb: '4', status: 'sin_vuelo_declarado' },
    ]);
    const res = await request(app).post('/api/ops/tick').set('x-ops-token', TOKEN).expect(200);
    expect(res.body.vuelos).toMatchObject({
      revisadas: 4, actualizadas: 1, sinCambio: 1, noIdentificadas: 1, sinVueloDeclarado: 1, errores: 0,
    });
  });

  it('records a provider outage on the cursor and counts consecutive failures', async () => {
    refreshVuelosPendientes.mockResolvedValue([
      { operacionId: 'a', mawb: '1', status: 'error_proveedor', errores: [{ provider: 'adsb.lol', message: 'timeout' }] },
    ]);
    await request(app).post('/api/ops/tick').set('x-ops-token', TOKEN).expect(200);
    await request(app).post('/api/ops/tick').set('x-ops-token', TOKEN).expect(200);

    const cur = await query<{ last_error: string | null; consecutive_errors: number }>(
      `SELECT last_error, consecutive_errors FROM integracion_cursores WHERE fuente='vuelos'`,
    );
    expect(cur.rows[0].last_error).toMatch(/error de proveedor/);
    expect(Number(cur.rows[0].consecutive_errors)).toBe(2);
  });

  it('clears the error state once a later run succeeds', async () => {
    refreshVuelosPendientes.mockResolvedValue([
      { operacionId: 'a', mawb: '1', status: 'error_proveedor' },
    ]);
    await request(app).post('/api/ops/tick').set('x-ops-token', TOKEN).expect(200);
    refreshVuelosPendientes.mockResolvedValue([]);
    await request(app).post('/api/ops/tick').set('x-ops-token', TOKEN).expect(200);

    const cur = await query<{ last_error: string | null; consecutive_errors: number }>(
      `SELECT last_error, consecutive_errors FROM integracion_cursores WHERE fuente='vuelos'`,
    );
    expect(cur.rows[0].last_error).toBeNull();
    expect(Number(cur.rows[0].consecutive_errors)).toBe(0);
  });

  it('caps the batch size so one tick cannot run away', async () => {
    await request(app).post('/api/ops/tick?limit=99999').set('x-ops-token', TOKEN).expect(200);
    expect(refreshVuelosPendientes).toHaveBeenCalledWith(500);
  });
});

describe('POST /api/ops/tick — barrido de prealertas', () => {
  it('runs the sweep and reports its summary alongside the flights', async () => {
    const res = await request(app).post('/api/ops/tick').set('x-ops-token', TOKEN).expect(200);
    expect(runAgoraSweep).toHaveBeenCalled();
    expect(res.body.sweep).toMatchObject({ ok: true, recuperadas: 1, truncado: false });
  });

  it('does not 500 the tick when the sweep blows up', async () => {
    // A dropped prealerta is bad; a scheduler that stops running because of a sweep bug is worse,
    // because then the flight phase stops too and nothing is being polled at all.
    runAgoraSweep.mockRejectedValue(new Error('AGORA fuera de línea'));
    const res = await request(app).post('/api/ops/tick').set('x-ops-token', TOKEN).expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.sweep).toEqual({ ok: false, error: 'AGORA fuera de línea' });
    // The flight phase still ran and still reported.
    expect(refreshVuelosPendientes).toHaveBeenCalled();
    expect(res.body.vuelos).toMatchObject({ revisadas: 0 });
  });

  it('still sweeps when the flight phase blows up', async () => {
    refreshVuelosPendientes.mockRejectedValue(new Error('proveedor caído'));
    const res = await request(app).post('/api/ops/tick').set('x-ops-token', TOKEN).expect(200);
    expect(runAgoraSweep).toHaveBeenCalled();
    expect(res.body.sweep).toMatchObject({ ok: true });
    expect(res.body.vuelos.error).toMatch(/proveedor caído/);

    const cur = await query<{ last_error: string | null; consecutive_errors: number }>(
      `SELECT last_error, consecutive_errors FROM integracion_cursores WHERE fuente='vuelos'`,
    );
    expect(cur.rows[0].last_error).toMatch(/la fase de vuelos falló/);
    expect(Number(cur.rows[0].consecutive_errors)).toBe(1);
  });
});

/**
 * Phase 3 — the contingency engine (PRD-02 §8.8). NOT mocked: its own behaviour is covered in
 * routes/replan.test.ts, and what is asked here is the route's question — does the phase run, does it
 * advance its own cursor, and can it be taken down by (or take down) the other two?
 *
 * The cursor matters more than it looks. Without a row of its own, "no contingencies today" and
 * "nothing has evaluated contingencies since Tuesday" are indistinguishable from the outside, and the
 * second one is how a truck gets contracted against cancelled cargo.
 */
describe('POST /api/ops/tick — motor de contingencias', () => {
  it('runs the engine, reports it, and advances its own cursor', async () => {
    const res = await request(app).post('/api/ops/tick').set('x-ops-token', TOKEN).expect(200);
    expect(res.body.replan).toMatchObject({ evaluadas: 0, conAcciones: 0, ejecutadas: 0, propuestas: 0 });

    const cur = await query<{ last_run_at: string | null; last_error: string | null }>(
      `SELECT last_run_at, last_error FROM integracion_cursores WHERE fuente='replan'`,
    );
    expect(cur.rows[0].last_run_at).toBeTruthy();
    expect(cur.rows[0].last_error).toBeNull();
  });

  it('evaluates a caso whose flight was cancelled and pulls it from the plan', async () => {
    const vuelo = await query<{ id: string }>(
      `INSERT INTO vuelos (numero_vuelo, fecha_operacion, estado)
       VALUES ('CI9999','2026-08-10','cancelado') RETURNING id`,
    );
    const op = await query<{ id: string }>(
      `INSERT INTO operaciones (mawb, etapa, estado_planeacion, numero_vuelo, vuelo_id)
       VALUES ('160-99999999','en_vuelo','planeada','CI9999',$1) RETURNING id`,
      [vuelo.rows[0].id],
    );

    const res = await request(app).post('/api/ops/tick').set('x-ops-token', TOKEN).expect(200);
    expect(res.body.replan.conAcciones).toBe(1);
    expect(res.body.replan.ejecutadas).toBeGreaterThan(0);

    const { rows } = await query<{ estado_planeacion: string }>(
      'SELECT estado_planeacion FROM operaciones WHERE id = $1',
      [op.rows[0].id],
    );
    expect(rows[0].estado_planeacion).toBe('excluida');

    // And it does not stutter on the next tick: the same facts write nothing more.
    await request(app).post('/api/ops/tick').set('x-ops-token', TOKEN).expect(200);
    const eventos = await query(
      `SELECT id FROM operacion_eventos WHERE operacion_id = $1 AND tipo = 'OPERACION_EXCLUIDA_DEL_PLAN'`,
      [op.rows[0].id],
    );
    expect(eventos.rows).toHaveLength(1);
    await query('TRUNCATE vuelos RESTART IDENTITY CASCADE');
  });
});
