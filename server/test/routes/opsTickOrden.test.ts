import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

/**
 * POST /api/ops/tick — THE ORDER OF THE FOUR PHASES.
 *
 * WHY THIS FILE IS SEPARATE FROM `opsTick.test.ts`. That file asks whether each phase runs, reports
 * and survives its neighbours' failures, and it deliberately leaves the contingency engine unmocked.
 * This one asks a different question — in WHICH ORDER — and answering it needs all four phases
 * stubbed, which would take the engine's real behaviour away from the other file's tests.
 *
 * WHY THE ORDER IS WORTH A TEST AT ALL. `routes/ops.ts` documents the sequence at length: flights,
 * then the AGORA sweep, then the risk requirements, then the contingency engine. It is not
 * alphabetical and it is not arbitrary — each phase WRITES facts the next one READS, so the whole
 * chain resolves inside one tick instead of leaking a five-minute cycle of latency per hop. The
 * load-bearing pair is 3 → 4: expiring a risk deadline OPENS a CT-4 hold and walks the caso to
 * `riesgo_vencido`, and the contingency engine's pre-filter selects on exactly those two facts. Run
 * the engine first and a deadline that ran out at 09:58 does not reach the dispatch plan until the
 * NEXT tick — which is one more cycle in which a truck can be contracted against frozen cargo.
 *
 * Nothing about that survives a refactor by itself: the phases are four independent `try/catch`
 * blocks in one handler and moving one is a two-line edit that no other test would notice. Hence an
 * assertion on the sequence, and — more importantly — an assertion on the CONSEQUENCE, which is what
 * the order exists for and what would still be true if the code were rewritten some other way.
 */

const orden: string[] = [];

const refreshVuelosPendientes = vi.fn(async () => {
  orden.push('vuelos');
  return [] as unknown[];
});
vi.mock('../../src/services/vuelosService', () => ({
  refreshVuelosPendientes: (...a: unknown[]) => refreshVuelosPendientes(...(a as [])),
  refreshVueloForOperacion: async () => undefined,
}));

const runAgoraSweep = vi.fn(async () => {
  orden.push('sweep');
  return { ok: true } as unknown;
});
vi.mock('../../src/services/agoraSweep', () => ({
  runAgoraSweep: (...a: unknown[]) => runAgoraSweep(...(a as [])),
}));

/**
 * The genuine phase-3 and phase-4 implementations, captured as the mock factories run.
 *
 * A dynamic `import()` inside a test would hand back the MOCK, and `vi.importActual` would build a
 * second copy of the module graph — including a second `pg` pool that nothing closes. Keeping the
 * original functions here is the only way to run the real chain in one test while every other test in
 * this file observes the order through stubs.
 */
const reales = vi.hoisted(() => ({
  requerimientos: null as null | (() => Promise<unknown>),
  replan: null as null | ((limit?: number) => Promise<unknown[]>),
}));

const runRequerimientosSweep = vi.fn(async () => {
  orden.push('requerimientos');
  return { ok: true } as unknown;
});
vi.mock('../../src/services/requerimientosService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/requerimientosService')>();
  reales.requerimientos = actual.runRequerimientosSweep as () => Promise<unknown>;
  return { ...actual, runRequerimientosSweep: (...a: unknown[]) => runRequerimientosSweep(...(a as [])) };
});

const evaluarPendientes = vi.fn(async () => {
  orden.push('replan');
  return [] as unknown[];
});
vi.mock('../../src/services/replanService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/replanService')>();
  reales.replan = actual.evaluarPendientes as (limit?: number) => Promise<unknown[]>;
  return { ...actual, evaluarPendientes: (...a: unknown[]) => evaluarPendientes(...(a as [])) };
});

const { createApp } = await import('../../src/app');
const app = createApp();

const ORIGINAL = process.env.OPS_TICK_TOKEN;
const TOKEN = 'tick-secret-for-orden-tests';

beforeEach(async () => {
  await truncateAll();
  orden.length = 0;
  vi.clearAllMocks();
  process.env.OPS_TICK_TOKEN = TOKEN;
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

describe('POST /api/ops/tick — el orden de las fases es contractual', () => {
  it('runs vuelos → sweep → requerimientos → replan, in that order, exactly once each', async () => {
    await request(app).post('/api/ops/tick').set('x-ops-token', TOKEN).expect(200);
    expect(orden).toEqual(['vuelos', 'sweep', 'requerimientos', 'replan']);
  });

  it('keeps requerimientos strictly BEFORE replan — the pair the whole ordering exists for', async () => {
    await request(app).post('/api/ops/tick').set('x-ops-token', TOKEN).expect(200);
    // Stated as its own assertion rather than left implicit in the array above: this is the edge that
    // costs a cycle of latency (and a truck) if it is ever inverted, and a failure here should name it.
    expect(orden.indexOf('requerimientos')).toBeLessThan(orden.indexOf('replan'));
  });

  it('keeps vuelos before replan — the delay facts the engine reacts to are produced in phase 1', async () => {
    await request(app).post('/api/ops/tick').set('x-ops-token', TOKEN).expect(200);
    expect(orden.indexOf('vuelos')).toBeLessThan(orden.indexOf('replan'));
  });

  it('holds the order even when an earlier phase blows up — the later ones still run, still in order', async () => {
    // Each phase is behind its own try/catch precisely so one provider outage cannot silence the
    // others. That independence must not come at the cost of the sequence.
    refreshVuelosPendientes.mockImplementationOnce(async () => {
      orden.push('vuelos');
      throw new Error('proveedor caído');
    });
    await request(app).post('/api/ops/tick').set('x-ops-token', TOKEN).expect(200);
    expect(orden).toEqual(['vuelos', 'sweep', 'requerimientos', 'replan']);
  });

  it('does not start the engine before the requerimientos sweep has finished', async () => {
    // The order of CALLS is not the order of COMPLETIONS unless every phase is awaited. If somebody
    // ever fires these off and awaits them together, the array above would still read correctly while
    // the engine read a hold that had not been written yet.
    let requerimientosTerminado = false;
    runRequerimientosSweep.mockImplementationOnce(async () => {
      orden.push('requerimientos');
      await new Promise((r) => setTimeout(r, 25));
      requerimientosTerminado = true;
      return { ok: true } as unknown;
    });
    evaluarPendientes.mockImplementationOnce(async () => {
      orden.push('replan');
      expect(requerimientosTerminado).toBe(true);
      return [] as unknown[];
    });
    await request(app).post('/api/ops/tick').set('x-ops-token', TOKEN).expect(200);
    expect(requerimientosTerminado).toBe(true);
  });
});

/**
 * The consequence, end to end, with the real phase-3 and phase-4 code.
 *
 * The assertions above pin the sequence; this one pins WHY it is that sequence. A risk deadline that
 * ran out must reach the dispatch plan on the SAME tick it expires — the hold phase 3 opens is read
 * by phase 4 within the one call, not five minutes later.
 */
describe('POST /api/ops/tick — un plazo vencido llega al plan en el mismo tick', () => {
  it('expires the deadline, opens the CT-4 hold, and excludes the caso from the plan in one call', async () => {
    // The two phases under test run for real here; only the outbound-facing ones stay stubbed.
    runRequerimientosSweep.mockImplementationOnce(async () => {
      orden.push('requerimientos');
      return reales.requerimientos!();
    });
    evaluarPendientes.mockImplementationOnce(async () => {
      orden.push('replan');
      return reales.replan!();
    });

    const cliente = await query<{ id: string }>(
      `INSERT INTO clients (name) VALUES ($1) RETURNING id`,
      [`Cliente ${randomUUID().slice(0, 8)}`],
    );
    const op = await query<{ id: string }>(
      `INSERT INTO operaciones (mawb, etapa, estado_planeacion, estado_documental, client_id)
       VALUES ($1,'arribado','planeada','riesgo_con_hallazgos',$2) RETURNING id`,
      [`160-${Math.floor(Math.random() * 1e8)}`, cliente.rows[0].id],
    );
    // Notified (so the clock legitimately runs against this client) and already past its deadline.
    await query(
      `INSERT INTO riesgo_requerimientos
         (operacion_id, reason_codes, vence_at, estado, notificacion_estado, notificado_at)
       VALUES ($1,'[]'::jsonb, now() - interval '1 hour', 'abierto', 'enviada', now() - interval '4 hours')`,
      [op.rows[0].id],
    );

    await request(app).post('/api/ops/tick').set('x-ops-token', TOKEN).expect(200);

    const { rows } = await query<{
      estado_planeacion: string;
      estado_documental: string;
      hold_activo: boolean;
    }>(
      'SELECT estado_planeacion, estado_documental, hold_activo FROM operaciones WHERE id = $1',
      [op.rows[0].id],
    );
    expect(rows[0].estado_documental).toBe('riesgo_vencido');
    expect(rows[0].hold_activo).toBe(true);
    // The payoff: phase 4 SAW what phase 3 wrote. Invert the two phases and this is still
    // `planeada` at the end of the tick.
    expect(rows[0].estado_planeacion).toBe('excluida');

    const holds = await query(
      `SELECT id FROM operacion_holds WHERE operacion_id = $1 AND tipo = 'riesgo' AND activo`,
      [op.rows[0].id],
    );
    expect(holds.rows).toHaveLength(1);
  });
});
