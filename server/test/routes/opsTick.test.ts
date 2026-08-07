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

const { createApp } = await import('../../src/app');
const app = createApp();

const ORIGINAL = process.env.OPS_TICK_TOKEN;
const TOKEN = 'tick-secret-for-tests';

beforeEach(async () => {
  await truncateAll();
  vi.clearAllMocks();
  refreshVuelosPendientes.mockResolvedValue([]);
  process.env.OPS_TICK_TOKEN = TOKEN;
  // truncateAll wipes the seeded cursor rows, so restore the one the route updates.
  await query(
    `INSERT INTO integracion_cursores (fuente) VALUES ('vuelos') ON CONFLICT (fuente) DO NOTHING`,
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
