import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { query } from '../../src/db/pool';
import { hashPassword } from '../../src/auth/password';
import { signToken } from '../../src/auth/token';
import { truncateAll } from '../helpers/db';
import { createApp } from '../../src/app';
import { REPLAN_RULESET_HASH, REPLAN_RULESET_VERSION } from '../../../shared/operaciones/replan';
import { encryptField } from '../../src/crypto/fieldCrypto';

/**
 * MOTOR DE CONTINGENCIAS — the replanning layer (PRD-02 §8.8, CT-1…CT-7).
 *
 * What each test defends, and the way the paper process failed without it:
 *
 *   - CT-1: a cancelled flight pulls the caso from the day's plan BY ITSELF and says so on the
 *     timeline. Discovered by phone call before, hours late, one shipment at a time.
 *   - CT-7 is a PROPOSAL and never executes. It changes a tarifa, so a human confirms it with a
 *     motivo that lands in the ledger as `override = true` (D6/R20). If this ever self-executed the
 *     platform would be committing spend on its own.
 *   - Discarding is recorded with the same weight as confirming: the coordinator who accepts a flete
 *     en falso has made a decision, and it must have a name and a reason on it.
 *   - The engine does not stutter. `operacion_eventos` is append-only and can never be cleaned, so a
 *     re-run over unchanged facts must write nothing at all — not one duplicate row.
 *   - CT-3: the engine opens the csa hold itself, with `abierto_por` NULL. That null is the record
 *     that no human decided it.
 *   - CT-6: a global freeze reaches every open caso as a suspension of unit requests — the flete en
 *     falso guard.
 *   - Routing: these endpoints share the `/api/operaciones` prefix with `GET /:id` and must not be
 *     shadowed by it.
 */
const app = createApp();

let adminToken: string;
let capturistaToken: string;
let tramitadorToken: string;
let autoridadToken: string;

/** The caso under test, a caso that can absorb a freed unit, and a delivered one. */
let opA: string;
let opCandidata: string;
let guiaA1: string;
let guiaA2: string;
let guiaCand: string;

async function eventosDe(operacionId: string, tipo?: string) {
  const { rows } = await query<{
    id: string;
    tipo: string;
    origen: string;
    override: boolean;
    motivo: string | null;
    payload: Record<string, unknown>;
  }>(
    `SELECT id, tipo, origen, override, motivo, payload
       FROM operacion_eventos
      WHERE operacion_id = $1 AND ($2::text IS NULL OR tipo = $2)
      ORDER BY id ASC`,
    [operacionId, tipo ?? null],
  );
  return rows;
}

async function accionesDe(operacionId: string) {
  const { rows } = await query<{
    id: string;
    contingencia: string;
    tipo: string;
    ejecucion: string;
    estado: string;
    clave: string;
  }>(
    `SELECT id, contingencia, tipo, ejecucion, estado, clave
       FROM replan_acciones WHERE operacion_id = $1 ORDER BY created_at, clave`,
    [operacionId],
  );
  return rows;
}

async function planDe(id: string): Promise<string> {
  const { rows } = await query<{ estado_planeacion: string }>(
    'SELECT estado_planeacion FROM operaciones WHERE id = $1',
    [id],
  );
  return rows[0].estado_planeacion;
}

function replanificar(opId: string, token = adminToken) {
  return request(app).post(`/api/operaciones/${opId}/replan`).set('Authorization', `Bearer ${token}`);
}

/** Attach a flight in a given state to a caso — the CT-1 trigger. */
async function conVuelo(
  opId: string,
  estado: string,
  fechas: { etaProgramado?: string; etaEstimado?: string } = {},
): Promise<void> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO vuelos (numero_vuelo, callsign, fecha_operacion, estado, eta_programado, eta_estimado, destino_iata)
     VALUES ($1,'CAL5218','2026-08-10',$2,$3,$4,'NLU')
     ON CONFLICT (numero_vuelo, fecha_operacion) DO UPDATE
       SET estado = EXCLUDED.estado,
           eta_programado = EXCLUDED.eta_programado,
           eta_estimado = EXCLUDED.eta_estimado
     RETURNING id`,
    [`CI${Math.floor(Math.random() * 8999) + 1000}`, estado, fechas.etaProgramado ?? null, fechas.etaEstimado ?? null],
  );
  await query('UPDATE operaciones SET vuelo_id = $2, numero_vuelo = $3 WHERE id = $1', [
    opId,
    rows[0].id,
    'CI5218',
  ]);
}

beforeEach(async () => {
  await truncateAll();
  await query('TRUNCATE vuelos RESTART IDENTITY CASCADE');
  const hash = await hashPassword('p');
  const [adm, cap, tram, auto] = await Promise.all([
    query<{ id: string }>(
      `INSERT INTO users (username,password_hash,role) VALUES ('r_adm',$1,'admin') RETURNING id`,
      [hash],
    ),
    query<{ id: string }>(
      `INSERT INTO users (username,password_hash,role) VALUES ('r_cap',$1,'capturista') RETURNING id`,
      [hash],
    ),
    query<{ id: string }>(
      `INSERT INTO users (username,password_hash,role) VALUES ('r_tram',$1,'tramitador') RETURNING id`,
      [hash],
    ),
    query<{ id: string }>(
      `INSERT INTO users (username,password_hash,role) VALUES ('r_auto',$1,'autoridad') RETURNING id`,
      [hash],
    ),
  ]);
  adminToken = signToken({ userId: adm.rows[0].id, role: 'admin', tv: 0 });
  capturistaToken = signToken({ userId: cap.rows[0].id, role: 'capturista', tv: 0 });
  tramitadorToken = signToken({ userId: tram.rows[0].id, role: 'tramitador', tv: 0 });
  autoridadToken = signToken({ userId: auto.rows[0].id, role: 'autoridad', tv: 0 });

  const ops = await query<{ id: string; mawb: string }>(
    `INSERT INTO operaciones (mawb, mawb_raw, etapa, estado_planeacion, destino_iata) VALUES
       ('160-11111111','160-11111111','en_vuelo','planeada','NLU'),
       ('160-22222222','160-22222222','arribado','sin_plan','NLU')
     RETURNING id, mawb`,
  );
  opA = ops.rows.find((r) => r.mawb === '160-11111111')!.id;
  opCandidata = ops.rows.find((r) => r.mawb === '160-22222222')!.id;

  const guias = await query<{ id: string; guia_norm: string }>(
    `INSERT INTO operacion_guias (operacion_id, guia_norm, guia_raw, piezas, estado) VALUES
       ($1,'AAA0001','AAA-0001',100,'declarada'),
       ($1,'AAA0002','AAA-0002',50,'declarada'),
       ($2,'BBB0001','BBB-0001',20,'declarada')
     RETURNING id, guia_norm`,
    [opA, opCandidata],
  );
  guiaA1 = guias.rows.find((r) => r.guia_norm === 'AAA0001')!.id;
  guiaA2 = guias.rows.find((r) => r.guia_norm === 'AAA0002')!.id;
  guiaCand = guias.rows.find((r) => r.guia_norm === 'BBB0001')!.id;
});

// -------------------------------------------------------------------------------------------------
describe('routing: /api/operaciones/:id/replan vs operacionesRouter GET /:id', () => {
  it('reaches the replan router and stamps the ruleset it ran', async () => {
    const res = await replanificar(opA).expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.rulesetVersion).toBe(REPLAN_RULESET_VERSION);
    expect(res.body.rulesetHash).toBe(REPLAN_RULESET_HASH);
  });

  it('404s on an operación that does not exist instead of inventing one', async () => {
    await replanificar('00000000-0000-4000-8000-000000000000').expect(404);
  });

  it('rejects a non-uuid id at validation, never as a caso lookup', async () => {
    await request(app)
      .post('/api/operaciones/no-es-uuid/replan')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
  });
});

describe('un caso sano no se toca', () => {
  it('produces no actions, no evaluation row and no ledger noise', async () => {
    const res = await replanificar(opA).expect(200);
    expect(res.body.accionesNuevas).toBe(0);
    expect(await accionesDe(opA)).toHaveLength(0);
    expect(await eventosDe(opA)).toHaveLength(0);
    expect(await planDe(opA)).toBe('planeada');
    const { rows } = await query('SELECT id FROM replan_evaluaciones WHERE operacion_id = $1', [opA]);
    expect(rows).toHaveLength(0);
  });
});

describe('CT-1 · vuelo cancelado', () => {
  beforeEach(async () => {
    await conVuelo(opA, 'cancelado');
  });

  it('pulls the caso from the plan, writes the ledger and stamps the ruleset', async () => {
    const res = await replanificar(opA).expect(200);
    expect(res.body.contingencias).toContain('CT-1');
    expect(res.body.ejecutadas).toBeGreaterThan(0);
    expect(res.body.propuestas).toBe(0); // nothing was assigned, so no unit to reassign
    expect(await planDe(opA)).toBe('excluida');

    const exclusion = await eventosDe(opA, 'OPERACION_EXCLUIDA_DEL_PLAN');
    expect(exclusion).toHaveLength(1);
    expect(exclusion[0].origen).toBe('sistema');
    expect(exclusion[0].payload.contingencia).toBe('CT-1');
    expect(exclusion[0].payload.rulesetVersion).toBe(REPLAN_RULESET_VERSION);
    expect(exclusion[0].payload.estadoPlaneacionAnterior).toBe('planeada');

    const avisos = await eventosDe(opA, 'NOTIFICACION_REQUERIDA');
    expect(avisos.length).toBeGreaterThanOrEqual(2);
    expect(avisos.map((e) => e.payload.destinatario)).toEqual(
      expect.arrayContaining(['almacen', 'cliente']),
    );
  });

  it('records exactly one audit row for the whole evaluation', async () => {
    await replanificar(opA).expect(200);
    const { rows } = await query<{ entity: string; after: Record<string, unknown> }>(
      `SELECT entity, after FROM audit_log WHERE action = 'REPLAN_EJECUTADO'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].entity).toBe('replan_evaluacion');
    expect(rows[0].after.rulesetHash).toBe(REPLAN_RULESET_HASH);
  });

  it('does not stutter: a second run writes nothing at all', async () => {
    await replanificar(opA).expect(200);
    const antes = await eventosDe(opA);
    const accionesAntes = await accionesDe(opA);

    const res = await replanificar(opA).expect(200);
    expect(res.body.accionesNuevas).toBe(0);
    expect(res.body.omitidas).toBeGreaterThan(0);
    expect(await eventosDe(opA)).toHaveLength(antes.length);
    expect(await accionesDe(opA)).toHaveLength(accionesAntes.length);
    const { rows } = await query('SELECT id FROM replan_evaluaciones WHERE operacion_id = $1', [opA]);
    expect(rows).toHaveLength(1);
  });

  it('stores the exact snapshot it decided on, for replay', async () => {
    await replanificar(opA).expect(200);
    const { rows } = await query<{ snapshot: Record<string, any>; ruleset_hash: string; disparador: string }>(
      'SELECT snapshot, ruleset_hash, disparador FROM replan_evaluaciones WHERE operacion_id = $1',
      [opA],
    );
    expect(rows[0].disparador).toBe('manual');
    expect(rows[0].ruleset_hash).toBe(REPLAN_RULESET_HASH);
    expect(rows[0].snapshot.vuelo.estado).toBe('cancelado');
    expect(rows[0].snapshot.operacion.estadoPlaneacion).toBe('planeada');
    expect(rows[0].snapshot.guias).toHaveLength(2);
  });
});

describe('CT-1 · demora que mueve la fecha', () => {
  it('reprograms to the new calendar date and replans an assigned caso', async () => {
    await query(`UPDATE operaciones SET estado_planeacion = 'asignada' WHERE id = $1`, [opA]);
    await conVuelo(opA, 'demorado', {
      etaProgramado: '2026-08-10T22:00:00Z',
      etaEstimado: '2026-08-11T12:00:00Z',
    });

    await replanificar(opA).expect(200);
    const repro = await eventosDe(opA, 'OPERACION_REPROGRAMADA');
    expect(repro).toHaveLength(1);
    expect(repro[0].payload.nuevaFecha).toBe('2026-08-11');
    // The state machine has no asignada → excluida edge: a caso that had a unit gets replanned.
    expect(await planDe(opA)).toBe('replanificada');
  });
});

describe('CT-7 · la reasignación que toca dinero', () => {
  let accionId: string;

  beforeEach(async () => {
    await query(`UPDATE operaciones SET estado_planeacion = 'asignada' WHERE id = $1`, [opA]);
    await conVuelo(opA, 'cancelado');
    const res = await replanificar(opA).expect(200);
    expect(res.body.propuestas).toBe(1);
    const acciones = await accionesDe(opA);
    accionId = acciones.find((a) => a.tipo === 'reasignar_despacho')!.id;
  });

  it('is filed as a proposal, never executed, and carries the candidates it found', async () => {
    const acciones = await accionesDe(opA);
    const prop = acciones.find((a) => a.tipo === 'reasignar_despacho')!;
    expect(prop.ejecucion).toBe('propuesta');
    expect(prop.estado).toBe('propuesta');
    expect(prop.contingencia).toBe('CT-7');

    const ev = await eventosDe(opA, 'REASIGNACION_PROPUESTA');
    expect(ev).toHaveLength(1);
    const candidatas = ev[0].payload.candidatas as Array<{ operacionId: string }>;
    expect(candidatas.map((c) => c.operacionId)).toContain(opCandidata);
  });

  it('shows up in the coordinator queue', async () => {
    const res = await request(app)
      .get(`/api/operaciones/${opA}/replan`)
      .set('Authorization', `Bearer ${autoridadToken}`)
      .expect(200);
    expect(res.body.pendientes).toBe(1);
    expect(res.body.acciones[0].estado).toBe('propuesta');
    expect(res.body.ultimaEvaluacion.rulesetHash).toBe(REPLAN_RULESET_HASH);
  });

  it('cannot be confirmed without a motivo — that motivo IS the override record', async () => {
    await request(app)
      .post(`/api/operaciones/${opA}/replan/acciones/${accionId}/confirmar`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
      .expect(400);
    await request(app)
      .post(`/api/operaciones/${opA}/replan/acciones/${accionId}/confirmar`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ motivo: '   ' })
      .expect(400);
  });

  it('confirming writes override = true with the motivo and names the caso that absorbs the unit', async () => {
    const res = await request(app)
      .post(`/api/operaciones/${opA}/replan/acciones/${accionId}/confirmar`)
      .set('Authorization', `Bearer ${capturistaToken}`)
      .send({ motivo: 'la unidad se manda a la guía de la tarde, mismo destino', nuevaOperacionId: opCandidata })
      .expect(200);
    expect(res.body.estado).toBe('confirmada');

    const ev = await eventosDe(opA, 'REASIGNACION_CONFIRMADA');
    expect(ev).toHaveLength(1);
    expect(ev[0].override).toBe(true);
    expect(ev[0].origen).toBe('coordinador');
    expect(ev[0].motivo).toContain('guía de la tarde');
    expect(ev[0].payload.nuevaOperacionId).toBe(opCandidata);
    expect(String(ev[0].payload.efecto)).toContain('flete en falso');

    const { rows } = await query<{ decision_motivo: string; decidida_por: string }>(
      'SELECT decision_motivo, decidida_por FROM replan_acciones WHERE id = $1',
      [accionId],
    );
    expect(rows[0].decision_motivo).toContain('guía de la tarde');
    expect(rows[0].decidida_por).toBeTruthy();
  });

  it('rejects a target that does not exist, or that is the caso losing the cargo', async () => {
    await request(app)
      .post(`/api/operaciones/${opA}/replan/acciones/${accionId}/confirmar`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ motivo: 'x'.repeat(20), nuevaOperacionId: '00000000-0000-4000-8000-000000000000' })
      .expect(404);
    await request(app)
      .post(`/api/operaciones/${opA}/replan/acciones/${accionId}/confirmar`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ motivo: 'x'.repeat(20), nuevaOperacionId: opA })
      .expect(400);
  });

  it('cannot be decided twice — the ledger must not record an approval that never happened', async () => {
    await request(app)
      .post(`/api/operaciones/${opA}/replan/acciones/${accionId}/confirmar`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ motivo: 'se reasigna a la guía de la tarde' })
      .expect(200);
    await request(app)
      .post(`/api/operaciones/${opA}/replan/acciones/${accionId}/descartar`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ motivo: 'cambio de opinión' })
      .expect(409);
  });

  it('discarding is recorded with the same weight: somebody chose to eat the flete en falso', async () => {
    await request(app)
      .post(`/api/operaciones/${opA}/replan/acciones/${accionId}/descartar`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ motivo: 'el transportista ya venía en camino y se cobra igual' })
      .expect(200);
    const ev = await eventosDe(opA, 'REASIGNACION_DESCARTADA');
    expect(ev[0].override).toBe(true);
    expect(String(ev[0].payload.efecto)).toContain('sin carga');

    const { rows } = await query<{ action: string }>(
      `SELECT action FROM audit_log WHERE action = 'REASIGNACION_DESCARTADA'`,
    );
    expect(rows).toHaveLength(1);
  });

  it('is never re-proposed after a human ruled on it — a nagged alert is an ignored alert', async () => {
    await request(app)
      .post(`/api/operaciones/${opA}/replan/acciones/${accionId}/descartar`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ motivo: 'por ahora se deja así' })
      .expect(200);
    const res = await replanificar(opA).expect(200);
    expect(res.body.propuestas).toBe(0);
    expect((await accionesDe(opA)).filter((a) => a.tipo === 'reasignar_despacho')).toHaveLength(1);
  });
});

/**
 * CT-7 against REAL trips — the follow-up to #29.
 *
 * `construirEstado` used to hand the engine `despachos: []` with a comment saying the table did not
 * exist yet, so CT-7 could only fall back to the `asignada` heuristic and propose a reassignment with
 * a NULL despachoId — "there is a unit, I cannot tell you which one". The dispatch module exists now,
 * so the proposal has to name the folio the coordinator is going to phone about.
 */
describe('CT-7 · la propuesta apunta al despacho real (#29)', () => {
  async function conDespacho(opId: string, estado: string): Promise<string> {
    const t = await query<{ id: string }>(
      `INSERT INTO transportistas (razon_social) VALUES ('Fletes del Norte') RETURNING id`,
    );
    const d = await query<{ id: string }>(
      `INSERT INTO despachos (folio, fecha_operacion, tipo_unidad, transportista_id, estado)
       VALUES ($1,'2026-08-10','tracto',$2,$3) RETURNING id`,
      [`D-20260810-${Math.floor(Math.random() * 900) + 100}`, t.rows[0].id, estado],
    );
    await query(`INSERT INTO despacho_partidas (despacho_id, operacion_id) VALUES ($1,$2)`, [
      d.rows[0].id,
      opId,
    ]);
    return d.rows[0].id;
  }

  it('names the despacho id instead of proposing against a null', async () => {
    const despachoId = await conDespacho(opA, 'confirmado');
    await conVuelo(opA, 'cancelado');

    await replanificar(opA).expect(200);

    const ev = await eventosDe(opA, 'REASIGNACION_PROPUESTA');
    expect(ev).toHaveLength(1);
    // The whole point: a folio somebody can call about, not "there is a unit somewhere".
    expect(ev[0].payload.despachoId).toBe(despachoId);
    expect(String(ev[0].payload.motivo)).toContain(despachoId);
  });

  it('carries the real trips into the reproducibility snapshot', async () => {
    const despachoId = await conDespacho(opA, 'en_patio');
    await conVuelo(opA, 'cancelado');
    await replanificar(opA).expect(200);

    const { rows } = await query<{ snapshot: { despachos: Array<Record<string, unknown>> } }>(
      'SELECT snapshot FROM replan_evaluaciones WHERE operacion_id = $1',
      [opA],
    );
    expect(rows[0].snapshot.despachos).toHaveLength(1);
    expect(rows[0].snapshot.despachos[0]).toMatchObject({ id: despachoId, estado: 'en_patio' });
    // Not guessed: a trip's destination is a client address, never an airport code.
    expect(rows[0].snapshot.despachos[0].destinoIata).toBeNull();
  });

  it('ignores a cancelled trip — a cancelled unit has nothing left to reassign', async () => {
    await conDespacho(opA, 'cancelado');
    await conVuelo(opA, 'cancelado');
    await replanificar(opA).expect(200);

    const { rows } = await query<{ snapshot: { despachos: unknown[] } }>(
      'SELECT snapshot FROM replan_evaluaciones WHERE operacion_id = $1',
      [opA],
    );
    expect(rows[0].snapshot.despachos).toHaveLength(0);
    // And with `sin_plan`/`planeada` there is no `asignada` signal either, so nothing is proposed —
    // which is correct: there is no exposure to raise.
    expect(await eventosDe(opA, 'REASIGNACION_PROPUESTA')).toHaveLength(0);
  });

  it('keeps the `asignada` safety net for a caso whose trip row is gone', async () => {
    // The documented fallback. `asignada` MEANS a unit was committed (§8.4 eje 3); a caso in that
    // state with no live trip is still an exposure, and dropping it silently is how a flete en falso
    // goes unnoticed.
    await query(`UPDATE operaciones SET estado_planeacion = 'asignada' WHERE id = $1`, [opA]);
    await conVuelo(opA, 'cancelado');
    await replanificar(opA).expect(200);

    const ev = await eventosDe(opA, 'REASIGNACION_PROPUESTA');
    expect(ev).toHaveLength(1);
    expect(ev[0].payload.despachoId).toBeNull();
  });
});

/**
 * NOTIFICACION_REQUERIDA — the obligation and the delivery are two facts (#22 + #31).
 *
 * The engine records that somebody HAS to be told, in the append-only ledger, inside the
 * transaction. The attempt happens afterwards and its outcome lands on the `replan_acciones` payload.
 * With no SMTP and no WhatsApp instance in a test process every attempt must come back `omitido` —
 * and the ledger event must still say the advice was owed.
 */
describe('NOTIFICACION_REQUERIDA · la obligación y la entrega son hechos distintos', () => {
  it('records the delivery attempt on the action, never on the ledger event', async () => {
    const cliente = await query<{ id: string }>(
      `INSERT INTO clients (name, email, phone) VALUES ('Cliente Aviso','ops@cliente.example','+525599887766')
       RETURNING id`,
    );
    await query('UPDATE operaciones SET client_id = $2 WHERE id = $1', [opA, cliente.rows[0].id]);
    await conVuelo(opA, 'cancelado');

    const res = await replanificar(opA).expect(200);

    const avisos = await eventosDe(opA, 'NOTIFICACION_REQUERIDA');
    expect(avisos.length).toBeGreaterThan(0);
    // The ledger event is the OBLIGATION. It must not have acquired a delivery claim.
    for (const a of avisos) expect(a.payload.notificacion).toBeUndefined();

    const { rows } = await query<{ payload: Record<string, any> }>(
      `SELECT payload FROM replan_acciones WHERE operacion_id = $1 AND tipo = 'notificar'`,
      [opA],
    );
    expect(rows.length).toBeGreaterThan(0);
    const alCliente = rows.find((r) => r.payload.destinatario === 'cliente')!;
    expect(alCliente.payload.notificacion).toBeTruthy();
    // Two contacts on file (email + phone), neither channel provisioned: two honest `omitido`s.
    expect(alCliente.payload.notificacion.intentados).toBe(2);
    expect(alCliente.payload.notificacion.enviados).toBe(0);
    expect(alCliente.payload.notificacion.omitidos).toBe(2);
    expect(res.body).toBeTruthy();
  });

  it('says so when there is nobody to tell, rather than leaving an unexplained absence', async () => {
    // No client on the caso and no NOTIFICACION_ALMACEN roster in a test process.
    await conVuelo(opA, 'cancelado');
    await replanificar(opA).expect(200);

    const { rows } = await query<{ payload: Record<string, any> }>(
      `SELECT payload FROM replan_acciones WHERE operacion_id = $1 AND tipo = 'notificar'`,
      [opA],
    );
    const alAlmacen = rows.find((r) => r.payload.destinatario === 'almacen')!;
    expect(alAlmacen.payload.notificacion.intentados).toBe(0);
    expect(alAlmacen.payload.notificacion.motivo).toMatch(/sin contacto/);
  });

  /**
   * THE CARRIER'S CONTACT IS ENCRYPTED AT REST, AND THE NOTIFIER WAS BEING HANDED THE CIPHERTEXT.
   *
   * `transportistas.contacto_email` / `contacto_telefono` are AES-GCM envelopes (`v1:iv:tag:ct`,
   * PRD-02 §8.5) — `routes/transportistas.ts` encrypts on the way in and decrypts on the way out.
   * `resolverDestinos` read the columns raw, so `services/notificaciones.ts` classified a base64
   * envelope as neither an email nor a phone and every carrier advice came back `omitido`: the engine
   * reporting "no channel on file" for a carrier whose number had been on file all along, which is
   * precisely the *flete en falso* phone call CT-1 exists to make. And the envelope itself was
   * written into `replan_acciones.payload.detalle`, putting ciphertext in a record a human reads.
   *
   * Seeded through the REAL `encryptField`, not a hand-written literal: a test that fakes the
   * envelope proves nothing about the envelope the application actually writes.
   */
  it('descifra el contacto del transportista antes de notificarlo (PII cifrada en reposo)', async () => {
    const correo = 'despacho@fletesdelnorte.example';
    const telefono = '+525512345678';
    const t = await query<{ id: string }>(
      `INSERT INTO transportistas (razon_social, contacto_email, contacto_telefono)
         VALUES ('Fletes del Norte',$1,$2) RETURNING id`,
      [encryptField(correo), encryptField(telefono)],
    );
    // Sanity: the row really is stored as ciphertext, so what follows is not a tautology.
    const enReposo = await query<{ contacto_email: string; contacto_telefono: string }>(
      'SELECT contacto_email, contacto_telefono FROM transportistas WHERE id = $1', [t.rows[0].id]);
    expect(enReposo.rows[0].contacto_email.startsWith('v1:')).toBe(true);
    expect(enReposo.rows[0].contacto_telefono.startsWith('v1:')).toBe(true);

    const d = await query<{ id: string }>(
      `INSERT INTO despachos (folio, fecha_operacion, tipo_unidad, transportista_id, estado)
         VALUES ('D-20260810-777','2026-08-10','tracto',$1,'confirmado') RETURNING id`,
      [t.rows[0].id],
    );
    await query(`INSERT INTO despacho_partidas (despacho_id, operacion_id) VALUES ($1,$2)`, [d.rows[0].id, opA]);

    await conVuelo(opA, 'cancelado');
    await replanificar(opA).expect(200);

    const { rows } = await query<{ payload: Record<string, any> }>(
      `SELECT payload FROM replan_acciones WHERE operacion_id = $1 AND tipo = 'notificar'`,
      [opA],
    );
    const alTransportista = rows.find((r) => r.payload.destinatario === 'transportista')!;
    expect(alTransportista).toBeTruthy();
    const n = alTransportista.payload.notificacion;

    // Both handles were resolved and CLASSIFIED — one email, one WhatsApp. Neither channel is
    // provisioned in a test process, so both are honest `omitido`s; the point is that the notifier
    // knew what they WERE, which it could not have with the envelope.
    expect(n.intentados).toBe(2);
    expect(n.motivo).toBeUndefined(); // never again "sin contacto en archivo"
    const canales = (n.detalle as Array<{ destino: string; canal: string | null }>);
    expect(canales.map((x) => x.canal).sort()).toEqual(['email', 'whatsapp']);
    expect(canales.map((x) => x.destino).sort()).toEqual([correo, telefono].sort());

    // AND NO CIPHERTEXT ANYWHERE IN THE STORED RECORD.
    const serializado = JSON.stringify(alTransportista.payload);
    expect(serializado).not.toContain('v1:');
    expect(serializado).not.toContain(enReposo.rows[0].contacto_email);
  });

  it('trata un contacto ilegible como ausente en lugar de enviar un sobre cifrado', async () => {
    // A rotated key or a corrupted row. `decryptField` throws on it; the notifier must never see it.
    const t = await query<{ id: string }>(
      `INSERT INTO transportistas (razon_social, contacto_email)
         VALUES ('Fletes Ilegibles','v1:AAAA:BBBB:CCCC') RETURNING id`,
    );
    const d = await query<{ id: string }>(
      `INSERT INTO despachos (folio, fecha_operacion, tipo_unidad, transportista_id, estado)
         VALUES ('D-20260810-778','2026-08-10','tracto',$1,'confirmado') RETURNING id`,
      [t.rows[0].id],
    );
    await query(`INSERT INTO despacho_partidas (despacho_id, operacion_id) VALUES ($1,$2)`, [d.rows[0].id, opA]);

    await conVuelo(opA, 'cancelado');
    await replanificar(opA).expect(200);

    const { rows } = await query<{ payload: Record<string, any> }>(
      `SELECT payload FROM replan_acciones WHERE operacion_id = $1 AND tipo = 'notificar'`,
      [opA],
    );
    const alTransportista = rows.find((r) => r.payload.destinatario === 'transportista')!;
    expect(alTransportista.payload.notificacion.intentados).toBe(0);
    expect(alTransportista.payload.notificacion.motivo).toMatch(/sin contacto/);
    expect(JSON.stringify(alTransportista.payload)).not.toContain('v1:');
  });

  it('does not re-attempt an advice already on record — the anti-stutter rule covers delivery too', async () => {
    await conVuelo(opA, 'cancelado');
    await replanificar(opA).expect(200);
    const primera = await query<{ payload: Record<string, any> }>(
      `SELECT payload FROM replan_acciones WHERE operacion_id = $1 AND tipo = 'notificar'`,
      [opA],
    );
    const sellos = primera.rows.map((r) => r.payload.notificacion.intentadoAt);

    const res = await replanificar(opA).expect(200);
    expect(res.body.accionesNuevas).toBe(0);

    const segunda = await query<{ payload: Record<string, any> }>(
      `SELECT payload FROM replan_acciones WHERE operacion_id = $1 AND tipo = 'notificar'`,
      [opA],
    );
    expect(segunda.rows).toHaveLength(primera.rows.length);
    expect(segunda.rows.map((r) => r.payload.notificacion.intentadoAt)).toEqual(sellos);
  });
});

describe('CT-2 · guía no transmitida', () => {
  function marcar(opId: string, guiaId: string, body: Record<string, unknown>, token = capturistaToken) {
    return request(app)
      .post(`/api/operaciones/${opId}/guias/${guiaId}/no-transmitida`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  it('marks the guía, logs it and evaluates the contingency on the same request', async () => {
    const res = await marcar(opA, guiaA1, { motivo: 'el cliente confirmó que no se transmitió' }).expect(201);
    expect(res.body.estado).toBe('no_transmitida');
    expect(res.body.replan).toBeTruthy();

    const { rows } = await query<{ estado: string }>('SELECT estado FROM operacion_guias WHERE id = $1', [
      guiaA1,
    ]);
    expect(rows[0].estado).toBe('no_transmitida');

    const ev = await eventosDe(opA, 'GUIA_NO_TRANSMITIDA');
    expect(ev).toHaveLength(1);
    expect(ev[0].payload.guia).toBe('AAA0001');

    // One guía is blocked but the other can still ship: the caso stays in the plan and the client is
    // asked to transmit.
    expect(await planDe(opA)).toBe('planeada');
    const avisos = await eventosDe(opA, 'NOTIFICACION_REQUERIDA');
    expect(avisos.map((e) => e.payload.plantilla)).toContain('guia_no_transmitida');
  });

  it('excludes the caso once nothing on it can be dispatched, and warns about the second guía too', async () => {
    await marcar(opA, guiaA1, { motivo: 'no transmitida' }).expect(201);
    await marcar(opA, guiaA2, { motivo: 'tampoco transmitida' }).expect(201);
    expect(await planDe(opA)).toBe('excluida');
    const exclusiones = await eventosDe(opA, 'OPERACION_EXCLUIDA_DEL_PLAN');
    expect(exclusiones.map((e) => e.payload.contingencia)).toContain('CT-2');
    // Two notices, not one: the second guía is a second thing the client has to fix, and the
    // fingerprint carries the guía ids precisely so it does not get swallowed as a repeat.
    const avisos = (await eventosDe(opA, 'NOTIFICACION_REQUERIDA')).filter(
      (e) => e.payload.plantilla === 'guia_no_transmitida',
    );
    expect(avisos).toHaveLength(2);
  });

  it('refuses a guía that belongs to another caso', async () => {
    await marcar(opA, guiaCand, { motivo: 'no transmitida' }).expect(400);
  });

  it('refuses to record the same fact twice', async () => {
    await marcar(opA, guiaA1, { motivo: 'no transmitida' }).expect(201);
    await marcar(opA, guiaA1, { motivo: 'otra vez' }).expect(409);
  });

  it('demands a motivo', async () => {
    await marcar(opA, guiaA1, {}).expect(400);
  });
});

describe('CT-3 · el motor abre el hold de CSA por sí mismo', () => {
  it('opens the csa hold with abierto_por NULL — the null is the record that no human decided it', async () => {
    await query(
      `UPDATE operaciones SET discrepancias = '[{"codigo":"PA-09","severidad":"error","mensaje":"consignada a otra agencia"}]'::jsonb WHERE id = $1`,
      [opA],
    );
    await replanificar(opA).expect(200);

    const { rows } = await query<{ tipo: string; alcance: string; abierto_por: string | null; motivo: string }>(
      'SELECT tipo, alcance, abierto_por, motivo FROM operacion_holds WHERE operacion_id = $1',
      [opA],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].tipo).toBe('csa');
    expect(rows[0].alcance).toBe('operacion');
    expect(rows[0].abierto_por).toBeNull();

    const { rows: op } = await query<{ hold_activo: boolean }>(
      'SELECT hold_activo FROM operaciones WHERE id = $1',
      [opA],
    );
    expect(op[0].hold_activo).toBe(true);

    const holdEv = await eventosDe(opA, 'HOLD_ABIERTO');
    expect(holdEv).toHaveLength(1);
    expect(holdEv[0].origen).toBe('sistema');
    expect(holdEv[0].payload.contingencia).toBe('CT-3');
  });

  it('never opens a second hold when a coordinator already opened one', async () => {
    await query(
      `UPDATE operaciones SET discrepancias = '[{"codigo":"PA-09"}]'::jsonb WHERE id = $1`,
      [opA],
    );
    await request(app)
      .post(`/api/operaciones/${opA}/holds`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ tipo: 'csa', alcance: 'operacion', motivo: 'falta la cesión de derechos' })
      .expect(201);

    await replanificar(opA).expect(200);
    const { rows } = await query('SELECT id FROM operacion_holds WHERE operacion_id = $1', [opA]);
    expect(rows).toHaveLength(1);
    // …and the caso still leaves the plan because the hold is active.
    expect(await planDe(opA)).toBe('excluida');
  });
});

describe('CT-6 · el freno global llega a cada caso', () => {
  it('suspends unit requests on the caso and takes it out of the plan', async () => {
    await request(app)
      .post('/api/operaciones/holds/global')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ motivo: 'auditoría de la autoridad en el almacén' })
      .expect(201);

    await replanificar(opA).expect(200);
    const suspension = await eventosDe(opA, 'SOLICITUD_UNIDADES_SUSPENDIDA');
    expect(suspension).toHaveLength(1);
    expect(suspension[0].payload.contingencia).toBe('CT-6');
    expect(await planDe(opA)).toBe('excluida');
  });
});

describe('roles', () => {
  it('the field role reports facts but does not replan the day', async () => {
    await replanificar(opA, tramitadorToken).expect(403);
    await request(app)
      .post(`/api/operaciones/${opA}/guias/${guiaA1}/no-transmitida`)
      .set('Authorization', `Bearer ${tramitadorToken}`)
      .send({ motivo: 'no transmitida' })
      .expect(403);
  });

  it('everyone authenticated can READ why a shipment is not moving', async () => {
    await request(app)
      .get(`/api/operaciones/${opA}/replan`)
      .set('Authorization', `Bearer ${tramitadorToken}`)
      .expect(200);
    await request(app).get(`/api/operaciones/${opA}/replan`).expect(401);
  });
});
