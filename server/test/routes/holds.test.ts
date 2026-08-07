import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { query } from '../../src/db/pool';
import { hashPassword } from '../../src/auth/password';
import { signToken } from '../../src/auth/token';
import { truncateAll } from '../helpers/db';
import { createApp } from '../../src/app';

/**
 * HOLDS and RETENCIONES — the blocking layer (PRD-02 §8.4/§8.5, CT-3…CT-6).
 *
 * What these tests defend, and why each one corresponds to a way the paper process failed:
 *
 *   - the GLOBAL hold (CT-6, "un botón que dice auditoría de autoridad… y todo está parado") freezes
 *     every OPEN caso in one call and leaves delivered ones alone. If it over-reached, the board would
 *     light up with shipments already at the client's warehouse and the ones that matter would be lost
 *     in the noise; if it under-reached, a truck gets requested for cargo that cannot be loaded — the
 *     flete en falso the button exists to prevent.
 *   - closing the global hold does NOT unblock a caso that still carries its own hold. This is the
 *     materialization edge case: `hold_activo` is recomputed from the table, never toggled, so an
 *     overlapping CT-3/CT-4 block survives the end of the audit.
 *   - a hold always has a `motivo`. A block with no stated reason is indistinguishable from someone
 *     quietly sitting on a shipment.
 *   - a `guia`-scope hold must name a guía of THIS caso: a block filed against the wrong client's
 *     cargo is worse than no block.
 *   - CT-5: a partial retención walks its guía to `retenida` (so the pedimento cannot declare the
 *     pallet sitting in custody) and `liberar` walks it back.
 *   - every freeze appears on EVERY affected caso's own timeline, because six weeks later the question
 *     is asked one shipment at a time.
 *   - `/api/operaciones/holds/global` is not swallowed by `operacionesRouter`'s `GET /:id`, which is
 *     mounted on the same prefix and registered first.
 */
const app = createApp();

let adminToken: string;
let capturistaToken: string;
let tramitadorToken: string;
let autoridadToken: string;
let adminId: string;

/** Two open casos plus one already delivered — the global-hold blast radius is the interesting part. */
let opA: string;
let opB: string;
let opEntregada: string;
/** Guías: two on A, one on B (the "belongs to another caso" probe). */
let guiaA1: string;
let guiaA2: string;
let guiaB1: string;

async function holdActivoDe(id: string): Promise<boolean> {
  const { rows } = await query<{ hold_activo: boolean }>(
    'SELECT hold_activo FROM operaciones WHERE id = $1',
    [id],
  );
  return rows[0].hold_activo;
}

async function eventosDe(operacionId: string, tipo?: string) {
  const { rows } = await query<{ id: string; tipo: string; origen: string; payload: Record<string, unknown> }>(
    `SELECT id, tipo, origen, payload
       FROM operacion_eventos
      WHERE operacion_id = $1 AND ($2::text IS NULL OR tipo = $2)
      ORDER BY id ASC`,
    [operacionId, tipo ?? null],
  );
  return rows;
}

async function auditoriasDe(action: string) {
  const { rows } = await query<{ action: string; entity: string; entity_id: string; after: Record<string, unknown> }>(
    'SELECT action, entity, entity_id, after FROM audit_log WHERE action = $1 ORDER BY id ASC',
    [action],
  );
  return rows;
}

async function guiaEstado(id: string): Promise<string> {
  const { rows } = await query<{ estado: string }>('SELECT estado FROM operacion_guias WHERE id = $1', [id]);
  return rows[0].estado;
}

function abrirGlobal(body: Record<string, unknown>, token = adminToken) {
  return request(app)
    .post('/api/operaciones/holds/global')
    .set('Authorization', `Bearer ${token}`)
    .send(body);
}

function abrirHold(opId: string, body: Record<string, unknown>, token = adminToken) {
  return request(app)
    .post(`/api/operaciones/${opId}/holds`)
    .set('Authorization', `Bearer ${token}`)
    .send(body);
}

function crearRetencion(opId: string, body: Record<string, unknown>, token = tramitadorToken) {
  return request(app)
    .post(`/api/operaciones/${opId}/retenciones`)
    .set('Authorization', `Bearer ${token}`)
    .send(body);
}

beforeEach(async () => {
  await truncateAll();
  const hash = await hashPassword('p');
  const [adm, cap, tram, auto] = await Promise.all([
    query<{ id: string }>(
      `INSERT INTO users (username,password_hash,role) VALUES ('h_adm',$1,'admin') RETURNING id`,
      [hash],
    ),
    query<{ id: string }>(
      `INSERT INTO users (username,password_hash,role) VALUES ('h_cap',$1,'capturista') RETURNING id`,
      [hash],
    ),
    query<{ id: string }>(
      `INSERT INTO users (username,password_hash,role) VALUES ('h_tram',$1,'tramitador') RETURNING id`,
      [hash],
    ),
    query<{ id: string }>(
      `INSERT INTO users (username,password_hash,role) VALUES ('h_auto',$1,'autoridad') RETURNING id`,
      [hash],
    ),
  ]);
  adminId = adm.rows[0].id;
  adminToken = signToken({ userId: adminId, role: 'admin', tv: 0 });
  capturistaToken = signToken({ userId: cap.rows[0].id, role: 'capturista', tv: 0 });
  tramitadorToken = signToken({ userId: tram.rows[0].id, role: 'tramitador', tv: 0 });
  autoridadToken = signToken({ userId: auto.rows[0].id, role: 'autoridad', tv: 0 });

  const ops = await query<{ id: string; mawb: string }>(
    `INSERT INTO operaciones (mawb, mawb_raw, etapa) VALUES
       ('160-11111111','160-11111111','disponible'),
       ('160-22222222','160-22222222','arribado'),
       ('160-33333333','160-33333333','entregado')
     RETURNING id, mawb`,
  );
  opA = ops.rows.find((r) => r.mawb === '160-11111111')!.id;
  opB = ops.rows.find((r) => r.mawb === '160-22222222')!.id;
  opEntregada = ops.rows.find((r) => r.mawb === '160-33333333')!.id;

  const guias = await query<{ id: string; guia_norm: string }>(
    `INSERT INTO operacion_guias (operacion_id, guia_norm, guia_raw, piezas, cartones, estado) VALUES
       ($1,'AAA0001','AAA-0001',100,10,'declarada'),
       ($1,'AAA0002','AAA-0002',50,5,'declarada'),
       ($2,'BBB0001','BBB-0001',20,2,'declarada')
     RETURNING id, guia_norm`,
    [opA, opB],
  );
  guiaA1 = guias.rows.find((r) => r.guia_norm === 'AAA0001')!.id;
  guiaA2 = guias.rows.find((r) => r.guia_norm === 'AAA0002')!.id;
  guiaB1 = guias.rows.find((r) => r.guia_norm === 'BBB0001')!.id;
});

// -------------------------------------------------------------------------------------------------
describe('routing collision: /api/operaciones/holds/* vs /api/operaciones/:id', () => {
  /**
   * `operacionesRouter` owns `GET /:id` and is mounted on `/api/operaciones` BEFORE `holdsRouter`.
   * If `holds` were ever captured as an operación id the authority-audit button would answer 404 or
   * 500 instead of freezing the operation, so this is regression-tested explicitly rather than
   * assumed from the shape of the paths.
   */
  it('GET /api/operaciones/holds/global reaches the holds router, not operaciones/:id', async () => {
    const res = await request(app)
      .get('/api/operaciones/holds/global')
      .set('Authorization', `Bearer ${autoridadToken}`)
      .expect(200);
    // The operaciones detail route would answer with a caso object (or a 404/500 for a non-uuid id).
    expect(res.body).toEqual({ holdGlobalActivo: false, holds: [] });
  });

  it('POST and DELETE on /api/operaciones/holds/global are not captured by /:id/holds', async () => {
    const abrir = await abrirGlobal({ motivo: 'auditoría de la autoridad al almacén' }).expect(201);
    expect(abrir.body.alcance).toBe('global');

    await request(app)
      .delete(`/api/operaciones/holds/global/${abrir.body.holdId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
  });

  it('the operaciones detail route still works for a real uuid (holdsRouter did not shadow it)', async () => {
    const res = await request(app)
      .get(`/api/operaciones/${opA}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(res.body.mawb).toBe('160-11111111');
  });

  it('a non-uuid operación id on a holds route is a 400, never a 500', async () => {
    await request(app)
      .get('/api/operaciones/no-un-uuid/holds')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
  });
});

// -------------------------------------------------------------------------------------------------
describe('role gates', () => {
  it('only admin may open a global hold', async () => {
    await abrirGlobal({ motivo: 'x' }, capturistaToken).expect(403);
    await abrirGlobal({ motivo: 'x' }, tramitadorToken).expect(403);
    await abrirGlobal({ motivo: 'x' }, autoridadToken).expect(403);
    await abrirGlobal({ motivo: 'auditoría' }, adminToken).expect(201);
  });

  it('only admin may close a global hold', async () => {
    const { body } = await abrirGlobal({ motivo: 'auditoría' }).expect(201);
    await request(app)
      .delete(`/api/operaciones/holds/global/${body.holdId}`)
      .set('Authorization', `Bearer ${capturistaToken}`)
      .expect(403);
    await request(app)
      .delete(`/api/operaciones/holds/global/${body.holdId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
  });

  it('any authenticated role may read the global hold; anonymous may not', async () => {
    await request(app).get('/api/operaciones/holds/global').expect(401);
    await request(app)
      .get('/api/operaciones/holds/global')
      .set('Authorization', `Bearer ${tramitadorToken}`)
      .expect(200);
  });

  it('admin and capturista may open an operación hold; tramitador and autoridad may not', async () => {
    await abrirHold(opA, { tipo: 'csa', alcance: 'operacion', motivo: 'm' }, tramitadorToken).expect(403);
    await abrirHold(opA, { tipo: 'csa', alcance: 'operacion', motivo: 'm' }, autoridadToken).expect(403);
    await abrirHold(opA, { tipo: 'csa', alcance: 'operacion', motivo: 'falta la cesión' }, capturistaToken).expect(201);
    await abrirHold(opB, { tipo: 'riesgo', alcance: 'operacion', motivo: 'plazo vencido' }, adminToken).expect(201);
  });

  it('tramitador may not close an operación hold', async () => {
    const { body } = await abrirHold(opA, { tipo: 'csa', alcance: 'operacion', motivo: 'm' }).expect(201);
    await request(app)
      .delete(`/api/operaciones/${opA}/holds/${body.holdId}`)
      .set('Authorization', `Bearer ${tramitadorToken}`)
      .expect(403);
    await request(app)
      .delete(`/api/operaciones/${opA}/holds/${body.holdId}`)
      .set('Authorization', `Bearer ${capturistaToken}`)
      .expect(200);
  });

  it('the tramitador is allowed ONLY on retención creation, never on liberación', async () => {
    // CT-5: he is the person watching the pallet get pulled off the load.
    const { body } = await crearRetencion(
      opA,
      { alcance: 'parcial', unidad: 'pallet', cantidad: 1, motivo: 'la autoridad detuvo un pallet' },
      tramitadorToken,
    ).expect(201);

    await request(app)
      .post(`/api/operaciones/${opA}/retenciones/${body.retencionId}/liberar`)
      .set('Authorization', `Bearer ${tramitadorToken}`)
      .expect(403);
    await request(app)
      .post(`/api/operaciones/${opA}/retenciones/${body.retencionId}/liberar`)
      .set('Authorization', `Bearer ${capturistaToken}`)
      .expect(200);
  });

  it('autoridad may not create a retención', async () => {
    await crearRetencion(opA, { alcance: 'total', motivo: 'm' }, autoridadToken).expect(403);
  });
});

// -------------------------------------------------------------------------------------------------
describe('motivo is mandatory everywhere', () => {
  it('rejects a global hold with no motivo', async () => {
    await abrirGlobal({}).expect(400);
  });

  it('rejects a global hold whose motivo is only whitespace', async () => {
    await abrirGlobal({ motivo: '    ' }).expect(400);
  });

  it('rejects an operación hold with no motivo', async () => {
    await abrirHold(opA, { tipo: 'csa', alcance: 'operacion' }).expect(400);
  });

  it('rejects a retención with no motivo', async () => {
    await crearRetencion(opA, { alcance: 'parcial', unidad: 'pallet', cantidad: 1 }).expect(400);
  });

  it('a rejected hold leaves no row and no event behind', async () => {
    await abrirHold(opA, { tipo: 'csa', alcance: 'operacion', motivo: ' ' }).expect(400);
    const { rows } = await query('SELECT id FROM operacion_holds');
    expect(rows).toHaveLength(0);
    expect(await eventosDe(opA)).toHaveLength(0);
  });
});

// -------------------------------------------------------------------------------------------------
describe('global hold — CT-6', () => {
  it('freezes every OPEN caso and leaves the entregada one alone', async () => {
    const res = await abrirGlobal({
      motivo: 'auditoría de la autoridad al almacén: todo parado, no se piden unidades',
    }).expect(201);

    expect(res.body.tipo).toBe('auditoria_autoridad'); // the default IS the button
    expect(res.body.operacionesAfectadas).toBe(2);
    expect(await holdActivoDe(opA)).toBe(true);
    expect(await holdActivoDe(opB)).toBe(true);
    expect(await holdActivoDe(opEntregada)).toBe(false);
  });

  it('refuses a second active global hold of the same tipo (409)', async () => {
    const primero = await abrirGlobal({ motivo: 'auditoría' }).expect(201);
    const dup = await abrirGlobal({ motivo: 'auditoría otra vez' }).expect(409);
    expect(dup.body.holdId).toBe(primero.body.holdId);
    const { rows } = await query('SELECT id FROM operacion_holds WHERE activo AND operacion_id IS NULL');
    expect(rows).toHaveLength(1);
  });

  it('allows a second global hold of a DIFFERENT tipo, and closing one leaves the other frozen', async () => {
    const auditoria = await abrirGlobal({ motivo: 'auditoría' }).expect(201);
    await abrirGlobal({ tipo: 'documental', motivo: 'caída del sistema aduanero' }).expect(201);

    await request(app)
      .delete(`/api/operaciones/holds/global/${auditoria.body.holdId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    // The other systemic freeze is still open, so nothing resumes.
    expect(await holdActivoDe(opA)).toBe(true);
    expect(await holdActivoDe(opB)).toBe(true);
  });

  it('closing it clears hold_activo — EXCEPT where an operación-level hold remains active', async () => {
    // The materialization edge case. opB carries its own CT-3 block that outlives the audit.
    await abrirHold(opB, { tipo: 'csa', alcance: 'operacion', motivo: 'falta la carta de cesión' }).expect(201);
    const global = await abrirGlobal({ motivo: 'auditoría de la autoridad' }).expect(201);

    expect(await holdActivoDe(opA)).toBe(true);
    expect(await holdActivoDe(opB)).toBe(true);

    const cierre = await request(app)
      .delete(`/api/operaciones/holds/global/${global.body.holdId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(await holdActivoDe(opA)).toBe(false); // audit over, nothing else pending → resumes
    expect(await holdActivoDe(opB)).toBe(true); // CSA still unresolved → stays frozen
    expect(cierre.body.operacionesAunBloqueadas).toBe(1);
  });

  it('closing an already-closed global hold is a 404, not a second unfreeze', async () => {
    const { body } = await abrirGlobal({ motivo: 'auditoría' }).expect(201);
    await request(app)
      .delete(`/api/operaciones/holds/global/${body.holdId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    await request(app)
      .delete(`/api/operaciones/holds/global/${body.holdId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(404);
  });

  it('a per-operación hold cannot be closed through the global endpoint', async () => {
    const { body } = await abrirHold(opA, { tipo: 'csa', alcance: 'operacion', motivo: 'm' }).expect(201);
    await request(app)
      .delete(`/api/operaciones/holds/global/${body.holdId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(404);
    expect(await holdActivoDe(opA)).toBe(true);
  });

  it('GET /holds/global reports the active freeze with who opened it', async () => {
    await abrirGlobal({ motivo: 'auditoría de la autoridad' }).expect(201);
    const res = await request(app)
      .get('/api/operaciones/holds/global')
      .set('Authorization', `Bearer ${autoridadToken}`)
      .expect(200);
    expect(res.body.holdGlobalActivo).toBe(true);
    expect(res.body.holds).toHaveLength(1);
    expect(res.body.holds[0].abiertoPorUsuario).toBe('h_adm');
    expect(res.body.holds[0].tipo).toBe('auditoria_autoridad');
  });

  it('writes ONE timeline event per affected caso, and none on the entregada one', async () => {
    await abrirGlobal({ motivo: 'auditoría de la autoridad al almacén' }).expect(201);

    const evA = await eventosDe(opA, 'HOLD_GLOBAL_ABIERTO');
    const evB = await eventosDe(opB, 'HOLD_GLOBAL_ABIERTO');
    const evDone = await eventosDe(opEntregada, 'HOLD_GLOBAL_ABIERTO');
    expect(evA).toHaveLength(1);
    expect(evB).toHaveLength(1);
    expect(evDone).toHaveLength(0);

    // Each caso's timeline has to explain the freeze on its own terms.
    expect(evA[0].origen).toBe('coordinador');
    expect(evA[0].payload.motivo).toBe('auditoría de la autoridad al almacén');
    expect(evA[0].payload.tipoHold).toBe('auditoria_autoridad');
    expect(String(evA[0].payload.efecto)).toContain('unidades');
    // Same decision in both timelines: one holdId, collapsible back to one act.
    expect(evA[0].payload.holdId).toBe(evB[0].payload.holdId);

    // The denormalized mawb travels with the event so it survives its parent (§8.5 decisión #2).
    const { rows } = await query<{ operacion_mawb: string }>(
      `SELECT operacion_mawb FROM operacion_eventos WHERE tipo='HOLD_GLOBAL_ABIERTO' ORDER BY operacion_mawb`,
    );
    expect(rows.map((r) => r.operacion_mawb)).toEqual(['160-11111111', '160-22222222']);
  });

  it('closing writes a HOLD_GLOBAL_CERRADO event on every affected caso', async () => {
    const { body } = await abrirGlobal({ motivo: 'auditoría' }).expect(201);
    await request(app)
      .delete(`/api/operaciones/holds/global/${body.holdId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(await eventosDe(opA, 'HOLD_GLOBAL_CERRADO')).toHaveLength(1);
    expect(await eventosDe(opB, 'HOLD_GLOBAL_CERRADO')).toHaveLength(1);
    expect(await eventosDe(opEntregada, 'HOLD_GLOBAL_CERRADO')).toHaveLength(0);
  });

  it('records ONE audit row per API action, not one per affected caso', async () => {
    const { body } = await abrirGlobal({ motivo: 'auditoría de la autoridad' }).expect(201);
    const abiertos = await auditoriasDe('HOLD_GLOBAL_ABIERTO');
    expect(abiertos).toHaveLength(1);
    expect(abiertos[0].entity).toBe('operacion_hold');
    expect(abiertos[0].entity_id).toBe(body.holdId);
    expect(abiertos[0].after.operacionesAfectadas).toBe(2);
    expect(abiertos[0].after.motivo).toBe('auditoría de la autoridad');

    await request(app)
      .delete(`/api/operaciones/holds/global/${body.holdId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(await auditoriasDe('HOLD_GLOBAL_CERRADO')).toHaveLength(1);
  });
});

// -------------------------------------------------------------------------------------------------
describe('operación-level holds — CT-3 / CT-4', () => {
  it('opening one flips hold_activo on that caso only', async () => {
    const res = await abrirHold(opA, {
      tipo: 'csa',
      alcance: 'operacion',
      motivo: 'consignada a otra agencia; falta la cesión',
    }).expect(201);
    expect(res.body.holdActivo).toBe(true);
    expect(await holdActivoDe(opA)).toBe(true);
    expect(await holdActivoDe(opB)).toBe(false);
  });

  it('closing one clears hold_activo, unless a second hold is still open', async () => {
    const csa = await abrirHold(opA, { tipo: 'csa', alcance: 'operacion', motivo: 'falta cesión' }).expect(201);
    await abrirHold(opA, { tipo: 'riesgo', alcance: 'operacion', motivo: 'plazo vencido' }).expect(201);

    const cierre = await request(app)
      .delete(`/api/operaciones/${opA}/holds/${csa.body.holdId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    // Recomputed, not toggled: the riesgo hold is still open.
    expect(cierre.body.holdActivo).toBe(true);
    expect(await holdActivoDe(opA)).toBe(true);
  });

  it('a hold closed while a global freeze is in force leaves the caso frozen', async () => {
    const csa = await abrirHold(opA, { tipo: 'csa', alcance: 'operacion', motivo: 'falta cesión' }).expect(201);
    await abrirGlobal({ motivo: 'auditoría' }).expect(201);
    const cierre = await request(app)
      .delete(`/api/operaciones/${opA}/holds/${csa.body.holdId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(cierre.body.holdActivo).toBe(true);
    expect(await holdActivoDe(opA)).toBe(true);
  });

  it('closes the row instead of deleting it, keeping who and when', async () => {
    const { body } = await abrirHold(opA, { tipo: 'csa', alcance: 'operacion', motivo: 'falta cesión' }).expect(201);
    await request(app)
      .delete(`/api/operaciones/${opA}/holds/${body.holdId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const { rows } = await query<{
      activo: boolean;
      cerrado_at: Date | null;
      cerrado_por: string | null;
      abierto_por: string | null;
      motivo: string;
    }>('SELECT activo, cerrado_at, cerrado_por, abierto_por, motivo FROM operacion_holds WHERE id = $1', [
      body.holdId,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].activo).toBe(false);
    expect(rows[0].cerrado_at).not.toBeNull();
    expect(rows[0].cerrado_por).toBe(adminId);
    expect(rows[0].abierto_por).toBe(adminId);
    expect(rows[0].motivo).toBe('falta cesión');
  });

  it("a 'guia' hold must name a guía of THIS operación", async () => {
    const ajena = await abrirHold(opA, {
      tipo: 'no_transmitida',
      alcance: 'guia',
      operacionGuiaId: guiaB1, // belongs to opB
      motivo: 'guía no transmitida',
    }).expect(400);
    expect(ajena.body.error).toContain('no pertenece');
    expect(await holdActivoDe(opA)).toBe(false);

    const propia = await abrirHold(opA, {
      tipo: 'no_transmitida',
      alcance: 'guia',
      operacionGuiaId: guiaA2,
      motivo: 'guía no transmitida',
    }).expect(201);
    expect(propia.body.operacionGuiaId).toBe(guiaA2);
    expect(await holdActivoDe(opA)).toBe(true);
  });

  it("a 'guia' hold without operacionGuiaId is a 400", async () => {
    await abrirHold(opA, { tipo: 'no_transmitida', alcance: 'guia', motivo: 'm' }).expect(400);
  });

  it("an 'operacion' hold carrying a guía id is a 400 rather than a silent discard", async () => {
    await abrirHold(opA, {
      tipo: 'csa',
      alcance: 'operacion',
      operacionGuiaId: guiaA1,
      motivo: 'm',
    }).expect(400);
  });

  it("rejects alcance 'global' on the per-operación endpoint", async () => {
    await abrirHold(opA, { tipo: 'auditoria_autoridad', alcance: 'global', motivo: 'm' }).expect(400);
  });

  it('404s for an unknown operación and for a hold that belongs to another caso', async () => {
    await abrirHold('11111111-1111-4111-8111-111111111111', {
      tipo: 'csa',
      alcance: 'operacion',
      motivo: 'm',
    }).expect(404);

    const { body } = await abrirHold(opA, { tipo: 'csa', alcance: 'operacion', motivo: 'm' }).expect(201);
    await request(app)
      .delete(`/api/operaciones/${opB}/holds/${body.holdId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(404);
    expect(await holdActivoDe(opA)).toBe(true);
  });

  it('writes HOLD_ABIERTO / HOLD_CERRADO on the caso timeline and one audit row each', async () => {
    const { body } = await abrirHold(opA, {
      tipo: 'csa',
      alcance: 'guia',
      operacionGuiaId: guiaA1,
      motivo: 'consignada a otra agencia',
    }).expect(201);

    const abierto = await eventosDe(opA, 'HOLD_ABIERTO');
    expect(abierto).toHaveLength(1);
    expect(abierto[0].origen).toBe('coordinador');
    expect(abierto[0].payload.motivo).toBe('consignada a otra agencia');
    expect(abierto[0].payload.alcance).toBe('guia');
    expect(abierto[0].payload.guia).toBe('AAA0001');

    await request(app)
      .delete(`/api/operaciones/${opA}/holds/${body.holdId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const cerrado = await eventosDe(opA, 'HOLD_CERRADO');
    expect(cerrado).toHaveLength(1);
    expect(cerrado[0].payload.holdActivoTrasCierre).toBe(false);

    expect(await auditoriasDe('HOLD_ABIERTO')).toHaveLength(1);
    expect(await auditoriasDe('HOLD_CERRADO')).toHaveLength(1);
  });

  it('GET /:id/holds lists this caso only, active first, closed ones included', async () => {
    const cerrado = await abrirHold(opA, { tipo: 'documental', alcance: 'operacion', motivo: 'faltaba factura' }).expect(201);
    await request(app)
      .delete(`/api/operaciones/${opA}/holds/${cerrado.body.holdId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    await abrirHold(opA, { tipo: 'riesgo', alcance: 'operacion', motivo: 'plazo vencido' }).expect(201);
    await abrirHold(opB, { tipo: 'csa', alcance: 'operacion', motivo: 'otra caso' }).expect(201);

    const res = await request(app)
      .get(`/api/operaciones/${opA}/holds`)
      .set('Authorization', `Bearer ${autoridadToken}`)
      .expect(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].activo).toBe(true);
    expect(res.body[0].tipo).toBe('riesgo');
    expect(res.body[1].activo).toBe(false);
    expect(res.body[1].cerradoPorUsuario).toBe('h_adm');
  });

  it('GET /:id/holds does NOT merge in the global hold', async () => {
    await abrirGlobal({ motivo: 'auditoría' }).expect(201);
    const res = await request(app)
      .get(`/api/operaciones/${opA}/holds`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(res.body).toEqual([]);
    // …but the materialized flag does account for it.
    expect(await holdActivoDe(opA)).toBe(true);
  });

  it('404s reading holds of an unknown operación', async () => {
    await request(app)
      .get('/api/operaciones/11111111-1111-4111-8111-111111111111/holds')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(404);
  });
});

// -------------------------------------------------------------------------------------------------
describe('retenciones — CT-5', () => {
  it('a parcial retención flips its guía to retenida and liberar walks it back', async () => {
    const creada = await crearRetencion(opA, {
      alcance: 'parcial',
      unidad: 'pallet',
      cantidad: 1,
      motivo: 'la autoridad detuvo un pallet a revisión; el resto sale',
      oficioReferencia: 'OF-2026-0001',
      operacionGuiaId: guiaA1,
    }).expect(201);

    expect(creada.body.estado).toBe('retenida');
    expect(creada.body.guiaEstado).toBe('retenida');
    expect(await guiaEstado(guiaA1)).toBe('retenida');
    // The rest of the caso keeps moving — that is the entire point of a PARTIAL retention.
    expect(await guiaEstado(guiaA2)).toBe('declarada');

    const liberada = await request(app)
      .post(`/api/operaciones/${opA}/retenciones/${creada.body.retencionId}/liberar`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(liberada.body.estado).toBe('liberada');
    expect(liberada.body.guiaEstado).toBe('liberada');
    expect(await guiaEstado(guiaA1)).toBe('liberada');

    const { rows } = await query<{ estado: string; liberada_at: Date | null; oficio_referencia: string }>(
      'SELECT estado, liberada_at, oficio_referencia FROM retenciones WHERE id = $1',
      [creada.body.retencionId],
    );
    expect(rows[0].estado).toBe('liberada');
    expect(rows[0].liberada_at).not.toBeNull();
    expect(rows[0].oficio_referencia).toBe('OF-2026-0001');
  });

  it('a retención does NOT set hold_activo: it is not a hold', async () => {
    await crearRetencion(opA, {
      alcance: 'parcial',
      unidad: 'pallet',
      cantidad: 1,
      motivo: 'un pallet a revisión',
      operacionGuiaId: guiaA1,
    }).expect(201);
    // A hold inhibits planning for the whole caso; a partial retención only removes one guía from it.
    expect(await holdActivoDe(opA)).toBe(false);
  });

  it('a total retención does not touch guía states', async () => {
    await crearRetencion(opA, { alcance: 'total', motivo: 'toda la carga retenida' }).expect(201);
    expect(await guiaEstado(guiaA1)).toBe('declarada');
    expect(await guiaEstado(guiaA2)).toBe('declarada');
  });

  it('rejects a guía from another operación', async () => {
    const res = await crearRetencion(opA, {
      alcance: 'parcial',
      unidad: 'pallet',
      cantidad: 1,
      motivo: 'm',
      operacionGuiaId: guiaB1,
    }).expect(400);
    expect(res.body.error).toContain('no pertenece');
    const { rows } = await query('SELECT id FROM retenciones');
    expect(rows).toHaveLength(0);
  });

  it('refuses to liberar twice (409) and refuses a terminal estado', async () => {
    const creada = await crearRetencion(opA, {
      alcance: 'parcial',
      unidad: 'carton',
      cantidad: 3,
      motivo: 'tres cartones detenidos',
      operacionGuiaId: guiaA1,
    }).expect(201);

    await request(app)
      .post(`/api/operaciones/${opA}/retenciones/${creada.body.retencionId}/liberar`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    await request(app)
      .post(`/api/operaciones/${opA}/retenciones/${creada.body.retencionId}/liberar`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(409);

    // Terminal outcomes are not "releasable" either: nothing came back from a destroyed pallet.
    const otra = await crearRetencion(opA, {
      alcance: 'parcial',
      unidad: 'pallet',
      cantidad: 1,
      motivo: 'pallet destruido por la autoridad',
      operacionGuiaId: guiaA2,
    }).expect(201);
    await query("UPDATE retenciones SET estado='destruida' WHERE id=$1", [otra.body.retencionId]);
    const res = await request(app)
      .post(`/api/operaciones/${opA}/retenciones/${otra.body.retencionId}/liberar`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(409);
    expect(res.body.estado).toBe('destruida');
  });

  it('404s for a retención that belongs to another operación', async () => {
    const creada = await crearRetencion(opA, { alcance: 'total', motivo: 'm' }).expect(201);
    await request(app)
      .post(`/api/operaciones/${opB}/retenciones/${creada.body.retencionId}/liberar`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(404);
  });

  it('does not drag a cancelada guía back to liberada', async () => {
    const creada = await crearRetencion(opA, {
      alcance: 'parcial',
      unidad: 'pallet',
      cantidad: 1,
      motivo: 'm',
      operacionGuiaId: guiaA1,
    }).expect(201);
    await query("UPDATE operacion_guias SET estado='cancelada' WHERE id=$1", [guiaA1]);

    const res = await request(app)
      .post(`/api/operaciones/${opA}/retenciones/${creada.body.retencionId}/liberar`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(res.body.guiaEstado).toBe('cancelada');
    expect(await guiaEstado(guiaA1)).toBe('cancelada');
  });

  it('writes RETENCION_CREADA / RETENCION_LIBERADA on the timeline plus one audit row each', async () => {
    const creada = await crearRetencion(opA, {
      alcance: 'parcial',
      unidad: 'pallet',
      cantidad: 1,
      motivo: 'un pallet a revisión',
      operacionGuiaId: guiaA1,
    }).expect(201);

    const ev = await eventosDe(opA, 'RETENCION_CREADA');
    expect(ev).toHaveLength(1);
    expect(ev[0].origen).toBe('coordinador');
    expect(ev[0].payload.unidad).toBe('pallet');
    expect(ev[0].payload.cantidad).toBe(1);
    expect(ev[0].payload.guiaEstadoAnterior).toBe('declarada');
    expect(ev[0].payload.guiaEstado).toBe('retenida');
    // The pedimento consequence has to be legible in the timeline, not folded into code somewhere.
    expect(String(ev[0].payload.efecto)).toContain('carga real');

    await request(app)
      .post(`/api/operaciones/${opA}/retenciones/${creada.body.retencionId}/liberar`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(await eventosDe(opA, 'RETENCION_LIBERADA')).toHaveLength(1);

    const auditCreada = await auditoriasDe('RETENCION_CREADA');
    expect(auditCreada).toHaveLength(1);
    expect(auditCreada[0].entity).toBe('retencion');
    expect(auditCreada[0].entity_id).toBe(creada.body.retencionId);
    expect(await auditoriasDe('RETENCION_LIBERADA')).toHaveLength(1);
  });

  it('rejects a cantidad of zero and an unknown unidad', async () => {
    await crearRetencion(opA, { alcance: 'parcial', unidad: 'pallet', cantidad: 0, motivo: 'm' }).expect(400);
    await crearRetencion(opA, { alcance: 'parcial', unidad: 'tarima', cantidad: 1, motivo: 'm' }).expect(400);
    await crearRetencion(opA, { alcance: 'otra', motivo: 'm' }).expect(400);
  });
});

// -------------------------------------------------------------------------------------------------
describe('database invariants', () => {
  it('a global hold cannot be pinned to an operación, nor an operación hold left orphan', async () => {
    await expect(
      query(
        `INSERT INTO operacion_holds (operacion_id, tipo, alcance, motivo)
         VALUES ($1,'auditoria_autoridad','global','mal')`,
        [opA],
      ),
    ).rejects.toThrow(/operacion_holds_alcance_global_check/);

    await expect(
      query(
        `INSERT INTO operacion_holds (operacion_id, tipo, alcance, motivo)
         VALUES (NULL,'csa','operacion','mal')`,
      ),
    ).rejects.toThrow(/operacion_holds_alcance_global_check/);
  });

  it('a hold cannot be inserted without a motivo', async () => {
    await expect(
      query(
        `INSERT INTO operacion_holds (operacion_id, tipo, alcance) VALUES ($1,'csa','operacion')`,
        [opA],
      ),
    ).rejects.toThrow(/motivo/);
  });

  it('holds and retenciones cascade with their operación', async () => {
    // Seeded directly, on the caso with no ledger events: a hold has no meaning without its caso, and
    // the durable record of the freeze is the timeline, not this row.
    await query(
      `INSERT INTO operacion_holds (operacion_id, tipo, alcance, motivo) VALUES ($1,'csa','operacion','falta cesión')`,
      [opB],
    );
    await query(
      `INSERT INTO retenciones (operacion_id, alcance, motivo) VALUES ($1,'total','toda la carga')`,
      [opB],
    );
    await query('DELETE FROM operaciones WHERE id = $1', [opB]);
    expect((await query('SELECT id FROM operacion_holds WHERE operacion_id = $1', [opB])).rows).toHaveLength(0);
    expect((await query('SELECT id FROM retenciones WHERE operacion_id = $1', [opB])).rows).toHaveLength(0);
  });

  it('once a hold has been logged, the operación can no longer be deleted at all', async () => {
    /**
     * PRE-EXISTING repo property, asserted here so it is not mistaken for a bug in this route.
     * §8.5 decisión #2 makes `operacion_eventos.operacion_id` ON DELETE SET NULL so that deleting an
     * operación cannot erase its history — but the append-only trigger blocks UPDATE as well as
     * DELETE, so the cascade's SET NULL is itself rejected and the parent DELETE fails outright.
     * The net effect is stronger than the PRD described: a caso that has ever been touched (a hold, a
     * retención, a field capture) is undeletable. That is the right answer for this system; it just
     * means the "orphaned but verifiable events" path in the PRD is unreachable in practice.
     */
    await abrirHold(opA, { tipo: 'csa', alcance: 'operacion', motivo: 'falta cesión' }).expect(201);
    await crearRetencion(opA, { alcance: 'total', motivo: 'toda la carga' }).expect(201);
    await expect(query('DELETE FROM operaciones WHERE id = $1', [opA])).rejects.toThrow(
      /append-only/,
    );

    // Everything is still there, including the two ledger rows that made the caso undeletable.
    expect((await query('SELECT id FROM operaciones WHERE id = $1', [opA])).rows).toHaveLength(1);
    expect(await eventosDe(opA)).toHaveLength(2);
  });
});
