import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { query } from '../../src/db/pool';
import { hashPassword } from '../../src/auth/password';
import { signToken } from '../../src/auth/token';
import { truncateAll } from '../helpers/db';
import { createApp } from '../../src/app';

/**
 * DESPACHOS — one unit, one trip (PRD-02 R21–R29, R36/D14, CT-7/D10).
 *
 * Each block below corresponds to a way the process this replaces actually fails:
 *
 *  - D7 (`/opciones` refuses without `tipoUnidad`). Luis said the order did not matter; Alfonso
 *    ruled for Fernando's "type first, so we don't phone carriers in vain". A wizard step would have
 *    made that a habit; a 400 makes it a rule, and this pins the 400.
 *  - R29 (partidas). N guías of N clients on one unit to one address — and the four refusals that
 *    keep the record honest, above all the HOLD one: a hold never stops the aircraft, it stops
 *    PLANNING, and loading cargo onto a contracted unit is the planning act that costs money.
 *  - R21 (the FSM). Forward only; `en_espera` only before loading commits; resuming checked against
 *    the pause point read back from the ledger, so a paused trip cannot silently rewind.
 *  - R30 (the delay against the appointment) — "cité 10:00, entró 10:05" is the number, not the state.
 *  - CT-7/D10 (reasignar). The only money-touching action, so the only one that demands a `motivo`
 *    and logs `override = true`.
 *  - R36/D14 (eta vs arribo). It REFUSES to estimate without coordinates rather than inventing a
 *    time, and the observed arrival never overwrites the estimate.
 */
const app = createApp();

let adminToken: string;
let capturistaToken: string;
let tramitadorToken: string;
let autoridadToken: string;

let clientId: string;
let direccionId: string;
let transportistaId: string;
let unidadTractoId: string;
let opA: string;
let opB: string;
let guiaA1: string;
let guiaA2: string;
let guiaB1: string;

const FECHA = '2026-08-14';

async function seedCatalogo(): Promise<void> {
  const c = await query<{ id: string }>(`INSERT INTO clients (name) VALUES ('ACME') RETURNING id`);
  clientId = c.rows[0].id;
  const d = await query<{ id: string }>(
    `INSERT INTO client_direcciones (client_id, alias, lat, lng)
     VALUES ($1,'IMILE Cuautitlán', 19.6697, -99.1817) RETURNING id`,
    [clientId],
  );
  direccionId = d.rows[0].id;

  const t = await query<{ id: string }>(
    `INSERT INTO transportistas (razon_social, estado) VALUES ('Transportes del Bajío','activo') RETURNING id`,
  );
  transportistaId = t.rows[0].id;
  const u = await query<{ id: string }>(
    `INSERT INTO transportista_unidades (transportista_id, placas, tipo_unidad)
     VALUES ($1,'ABC1234','tracto') RETURNING id`,
    [transportistaId],
  );
  unidadTractoId = u.rows[0].id;

  const conv = await query<{ id: string }>(
    `INSERT INTO transportista_convenios (transportista_id, estado_firma, firmado_at, vigencia_desde, vigencia_hasta)
     VALUES ($1,'firmado', now(), '2026-01-01', '2026-12-31') RETURNING id`,
    [transportistaId],
  );
  await query(
    `INSERT INTO transportista_tarifas (convenio_id, tipo_unidad, tarifa, moneda)
     VALUES ($1,'tracto', 8500, 'MXN')`,
    [conv.rows[0].id],
  );
  await query(
    `INSERT INTO transportista_tarifas (convenio_id, tipo_unidad, direccion_entrega_id, tarifa, moneda)
     VALUES ($1,'tracto', $2, 9200, 'MXN')`,
    [conv.rows[0].id, direccionId],
  );
}

beforeEach(async () => {
  await truncateAll();
  const hash = await hashPassword('p');
  const [adm, cap, tram, auto] = await Promise.all([
    query<{ id: string }>(`INSERT INTO users (username,password_hash,role) VALUES ('d_adm',$1,'admin') RETURNING id`, [hash]),
    query<{ id: string }>(`INSERT INTO users (username,password_hash,role) VALUES ('d_cap',$1,'capturista') RETURNING id`, [hash]),
    query<{ id: string }>(`INSERT INTO users (username,password_hash,role) VALUES ('d_tram',$1,'tramitador') RETURNING id`, [hash]),
    query<{ id: string }>(`INSERT INTO users (username,password_hash,role) VALUES ('d_auto',$1,'autoridad') RETURNING id`, [hash]),
  ]);
  adminToken = signToken({ userId: adm.rows[0].id, role: 'admin', tv: 0 });
  capturistaToken = signToken({ userId: cap.rows[0].id, role: 'capturista', tv: 0 });
  tramitadorToken = signToken({ userId: tram.rows[0].id, role: 'tramitador', tv: 0 });
  autoridadToken = signToken({ userId: auto.rows[0].id, role: 'autoridad', tv: 0 });

  await seedCatalogo();

  const ops = await query<{ id: string; mawb: string }>(
    `INSERT INTO operaciones (mawb, mawb_raw, etapa, client_id, destino_iata) VALUES
       ('160-11111111','160-11111111','disponible',$1,'NLU'),
       ('160-22222222','160-22222222','arribado',$1,'NLU')
     RETURNING id, mawb`,
    [clientId],
  );
  opA = ops.rows.find((r) => r.mawb === '160-11111111')!.id;
  opB = ops.rows.find((r) => r.mawb === '160-22222222')!.id;

  const guias = await query<{ id: string; guia_norm: string }>(
    `INSERT INTO operacion_guias (operacion_id, guia_norm, guia_raw, piezas, cartones, estado, client_id) VALUES
       ($1,'AAA0001','AAA-0001',100,10,'declarada',$3),
       ($1,'AAA0002','AAA-0002',50,5,'declarada',$3),
       ($2,'BBB0001','BBB-0001',20,2,'declarada',$3)
     RETURNING id, guia_norm`,
    [opA, opB, clientId],
  );
  guiaA1 = guias.rows.find((r) => r.guia_norm === 'AAA0001')!.id;
  guiaA2 = guias.rows.find((r) => r.guia_norm === 'AAA0002')!.id;
  guiaB1 = guias.rows.find((r) => r.guia_norm === 'BBB0001')!.id;
});

function crearDespacho(body: Record<string, unknown> = {}, token = adminToken) {
  return request(app)
    .post('/api/despachos')
    .set('Authorization', `Bearer ${token}`)
    .send({ fechaOperacion: FECHA, tipoUnidad: 'tracto', ...body });
}

function agregarPartida(id: string, body: Record<string, unknown>, token = adminToken) {
  return request(app)
    .post(`/api/despachos/${id}/partidas`)
    .set('Authorization', `Bearer ${token}`)
    .send(body);
}

function estado(id: string, body: Record<string, unknown>, token = adminToken) {
  return request(app).post(`/api/despachos/${id}/estado`).set('Authorization', `Bearer ${token}`).send(body);
}

async function eventosDe(operacionId: string, tipo?: string) {
  const { rows } = await query<{ tipo: string; origen: string; payload: Record<string, unknown>; override: boolean; despacho_id: string | null }>(
    `SELECT tipo, origen, payload, override, despacho_id
       FROM operacion_eventos
      WHERE operacion_id = $1 AND ($2::text IS NULL OR tipo = $2)
      ORDER BY id ASC`,
    [operacionId, tipo ?? null],
  );
  return rows;
}

// -------------------------------------------------------------------------------------------------
describe('D7 — tipo de unidad primero, transportista después', () => {
  it('refuses to list carriers until the unit type is decided', async () => {
    // THE decision, as a 400. This is what stops the round of calls to carriers who cannot serve it.
    await request(app)
      .get('/api/despachos/opciones')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);

    const res = await request(app)
      .get(`/api/despachos/opciones?tipoUnidad=tracto&fecha=${FECHA}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(res.body.orden).toContain('D7');
    expect(res.body.opciones).toHaveLength(1);
    expect(res.body.opciones[0].transportista).toBe('Transportes del Bajío');
  });

  it('rejects a unit type outside the glossary', async () => {
    await request(app)
      .get('/api/despachos/opciones?tipoUnidad=trailer')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
  });

  it('offers only carriers that have an ACTIVE unit of that type', async () => {
    const res = await request(app)
      .get(`/api/despachos/opciones?tipoUnidad=torton&fecha=${FECHA}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(res.body.opciones).toHaveLength(0);
  });

  it('prefers the destination-specific rate over the general one', async () => {
    const general = await request(app)
      .get(`/api/despachos/opciones?tipoUnidad=tracto&fecha=${FECHA}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(Number(general.body.opciones[0].tarifa)).toBe(8500);

    const especifica = await request(app)
      .get(`/api/despachos/opciones?tipoUnidad=tracto&direccionEntregaId=${direccionId}&fecha=${FECHA}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(Number(especifica.body.opciones[0].tarifa)).toBe(9200);
    expect(especifica.body.opciones[0].especificaDestino).toBe(true);
  });

  it('ignores rates from an unsigned convenio — a draft price is a negotiation, not a rate', async () => {
    await query(`UPDATE transportista_convenios SET estado_firma='enviado', firmado_at=NULL`);
    const res = await request(app)
      .get(`/api/despachos/opciones?tipoUnidad=tracto&fecha=${FECHA}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    // Still listed — a carrier with no current agreement is a fact to act on, not one to hide.
    expect(res.body.opciones).toHaveLength(1);
    expect(res.body.opciones[0].tarifaId).toBeNull();
    expect(res.body.opciones[0].advertencia).toContain('Sin tarifa vigente');
  });

  it('excludes suspended carriers entirely', async () => {
    await query(`UPDATE transportistas SET estado='suspendido'`);
    const res = await request(app)
      .get(`/api/despachos/opciones?tipoUnidad=tracto&fecha=${FECHA}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(res.body.opciones).toHaveLength(0);
  });

  it('is closed to the field and authority roles', async () => {
    await request(app)
      .get('/api/despachos/opciones?tipoUnidad=tracto')
      .set('Authorization', `Bearer ${tramitadorToken}`)
      .expect(403);
    await request(app)
      .get('/api/despachos/opciones?tipoUnidad=tracto')
      .set('Authorization', `Bearer ${autoridadToken}`)
      .expect(403);
  });

  it("the literal 'opciones' is never captured as a despacho id", async () => {
    await request(app)
      .get('/api/despachos/no-un-uuid')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
  });
});

// -------------------------------------------------------------------------------------------------
describe('alta del despacho — R22', () => {
  it('needs only a date and a unit type: the carrier comes later, by design', async () => {
    const res = await crearDespacho().expect(201);
    expect(res.body.tipoUnidad).toBe('tracto');
    expect(res.body.tipoUnidadLabel).toBe('Tracto');
    expect(res.body.transportistaId).toBeNull();
    expect(res.body.estado).toBe('planeado');
    expect(res.body.folio).toBe(`D-20260814-001`);
  });

  it('rejects a creation with no unit type at all', async () => {
    await request(app)
      .post('/api/despachos')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ fechaOperacion: FECHA })
      .expect(400);
  });

  it('mints consecutive folios per operating day', async () => {
    const a = await crearDespacho().expect(201);
    const b = await crearDespacho().expect(201);
    const otroDia = await crearDespacho({ fechaOperacion: '2026-08-15' }).expect(201);
    expect(a.body.folio).toBe('D-20260814-001');
    expect(b.body.folio).toBe('D-20260814-002');
    expect(otroDia.body.folio).toBe('D-20260815-001');
  });

  it('resolves the agreed rate when a carrier is named, preferring the destination', async () => {
    const res = await crearDespacho({ transportistaId, direccionEntregaId: direccionId }).expect(201);
    expect(Number(res.body.tarifaMonto)).toBe(9200);
    expect(res.body.moneda).toBe('MXN');
    expect(res.body.advertencia).toBeNull();
  });

  it('says out loud when a carrier was assigned with no agreed rate', async () => {
    await query(`UPDATE transportista_convenios SET estado_firma='borrador', firmado_at=NULL`);
    const res = await crearDespacho({ transportistaId }).expect(201);
    expect(res.body.tarifaMonto).toBeNull();
    expect(res.body.advertencia).toContain('sin tarifa');
  });

  it('refuses a unit whose type is not the trip type — that is D7, enforced', async () => {
    const torton = await query<{ id: string }>(
      `INSERT INTO transportista_unidades (transportista_id, placas, tipo_unidad)
       VALUES ($1,'TOR9999','torton') RETURNING id`,
      [transportistaId],
    );
    const res = await crearDespacho({ transportistaId, unidadId: torton.rows[0].id }).expect(409);
    expect(res.body.error).toContain('D7');
  });

  it('refuses a unit with no carrier, and a unit belonging to another carrier', async () => {
    await crearDespacho({ unidadId: unidadTractoId }).expect(400);
    const otro = await query<{ id: string }>(
      `INSERT INTO transportistas (razon_social) VALUES ('Fletes del Norte') RETURNING id`,
    );
    await crearDespacho({ transportistaId: otro.rows[0].id, unidadId: unidadTractoId }).expect(400);
  });

  it('refuses a suspended carrier and a deactivated unit', async () => {
    await query(`UPDATE transportista_unidades SET activo=false WHERE id=$1`, [unidadTractoId]);
    await crearDespacho({ transportistaId, unidadId: unidadTractoId }).expect(409);
    await query(`UPDATE transportista_unidades SET activo=true WHERE id=$1`, [unidadTractoId]);
    await query(`UPDATE transportistas SET estado='baja'`);
    await crearDespacho({ transportistaId }).expect(409);
  });

  it('denormalizes the plates from the assigned unit', async () => {
    const res = await crearDespacho({ transportistaId, unidadId: unidadTractoId }).expect(201);
    expect(res.body.placas).toBe('ABC1234');
  });

  it('is closed to the field and authority roles', async () => {
    await crearDespacho({}, tramitadorToken).expect(403);
    await crearDespacho({}, autoridadToken).expect(403);
    await crearDespacho({}, capturistaToken).expect(201);
  });

  it('writes exactly one audit row and no ledger events for an empty trip', async () => {
    const res = await crearDespacho().expect(201);
    const { rows } = await query(`SELECT entity_id FROM audit_log WHERE action='DESPACHO_CREADO'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].entity_id).toBe(res.body.id);
    // No cargo yet, so nobody's timeline changed.
    expect((await query('SELECT id FROM operacion_eventos')).rows).toHaveLength(0);
  });
});

// -------------------------------------------------------------------------------------------------
describe('edición de la asignación — R28', () => {
  let id: string;
  beforeEach(async () => {
    id = (await crearDespacho().expect(201)).body.id;
  });

  function editar(body: Record<string, unknown>, token = adminToken) {
    return request(app).put(`/api/despachos/${id}`).set('Authorization', `Bearer ${token}`).send(body);
  }

  it('assigning the carrier is its own ledger event, distinct from creating the trip', async () => {
    await agregarPartida(id, { operacionId: opA, operacionGuiaId: guiaA1 }).expect(201);
    await editar({ transportistaId, unidadId: unidadTractoId }).expect(200);
    const ev = await eventosDe(opA, 'DESPACHO_ASIGNADO');
    expect(ev).toHaveLength(1);
    expect(ev[0].payload.placas).toBe('ABC1234');
    expect(ev[0].despacho_id).toBe(id);
  });

  it('unassigns with an explicit null, and demands the unit go with the carrier', async () => {
    await editar({ transportistaId, unidadId: unidadTractoId }).expect(200);
    await editar({ transportistaId: null }).expect(400);
    const res = await editar({ transportistaId: null, unidadId: null }).expect(200);
    expect(res.body.transportistaId).toBeNull();
    expect(res.body.tarifaMonto).toBeNull();
  });

  it('refuses to change the unit type while a unit is attached — the type is what everything hangs off', async () => {
    await editar({ transportistaId, unidadId: unidadTractoId }).expect(200);
    const res = await editar({ tipoUnidad: 'torton' }).expect(409);
    expect(res.body.error).toContain('D7');
  });

  it('re-resolves the rate when the destination changes, instead of carrying a stale amount', async () => {
    await editar({ transportistaId }).expect(200);
    const antes = await query<{ tarifa_monto: string }>('SELECT tarifa_monto FROM despachos WHERE id=$1', [id]);
    expect(Number(antes.rows[0].tarifa_monto)).toBe(8500);

    const res = await editar({ direccionEntregaId: direccionId }).expect(200);
    expect(Number(res.body.tarifaMonto)).toBe(9200);
  });

  it('is refused once the load is closed — the assignment is then a record, not a plan', async () => {
    await estado(id, { estado: 'cargado' }).expect(201);
    const res = await editar({ operadorNombre: 'Otro' }).expect(409);
    expect(res.body.error).toContain('cerrada');
  });

  it('400s when there is nothing to update, and 404s for an unknown trip', async () => {
    await editar({}).expect(400);
    await request(app)
      .put('/api/despachos/11111111-1111-4111-8111-111111111111')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ operadorNombre: 'X' })
      .expect(404);
  });
});

// -------------------------------------------------------------------------------------------------
describe('partidas — R29: N guías, N clientes, un destino', () => {
  let id: string;
  beforeEach(async () => {
    id = (await crearDespacho({ transportistaId, unidadId: unidadTractoId, direccionEntregaId: direccionId }).expect(201)).body.id;
  });

  it('carries guías from DIFFERENT casos on one unit to one address', async () => {
    await agregarPartida(id, { operacionId: opA, operacionGuiaId: guiaA1 }).expect(201);
    await agregarPartida(id, { operacionId: opB, operacionGuiaId: guiaB1 }).expect(201);

    const res = await request(app)
      .get(`/api/despachos/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(res.body.partidas).toHaveLength(2);
    expect(res.body.partidas.map((p: { guia: string }) => p.guia)).toEqual(['AAA0001', 'BBB0001']);
    expect(res.body.destino).toBe('IMILE Cuautitlán');
  });

  it('assigns the loading consecutive the warehouse stages by (R14)', async () => {
    const a = await agregarPartida(id, { operacionId: opA, operacionGuiaId: guiaA1 }).expect(201);
    const b = await agregarPartida(id, { operacionId: opA, operacionGuiaId: guiaA2 }).expect(201);
    expect(a.body.ordenCarga).toBe(1);
    expect(b.body.ordenCarga).toBe(2);
  });

  it('refuses two lines at the same loading position', async () => {
    await agregarPartida(id, { operacionId: opA, operacionGuiaId: guiaA1, ordenCarga: 1 }).expect(201);
    await agregarPartida(id, { operacionId: opA, operacionGuiaId: guiaA2, ordenCarga: 1 }).expect(409);
  });

  it('falls back to the quantities the guía already declares', async () => {
    const res = await agregarPartida(id, { operacionId: opA, operacionGuiaId: guiaA1 }).expect(201);
    expect(res.body.cartonesPlaneados).toBe(10);
    expect(res.body.piezas).toBe(100);
  });

  it('REFUSES a caso under an active hold — this is what prevents the flete en falso', async () => {
    await request(app)
      .post(`/api/operaciones/${opA}/holds`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ tipo: 'csa', alcance: 'operacion', motivo: 'consignada a otra agencia; falta la cesión' })
      .expect(201);

    const res = await agregarPartida(id, { operacionId: opA, operacionGuiaId: guiaA1 }).expect(409);
    expect(res.body.error).toContain('hold activo');
    expect((await query('SELECT id FROM despacho_partidas')).rows).toHaveLength(0);
  });

  it('refuses a caso frozen by the GLOBAL authority-audit hold too', async () => {
    await request(app)
      .post('/api/operaciones/holds/global')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ motivo: 'auditoría de la autoridad al almacén' })
      .expect(201);
    await agregarPartida(id, { operacionId: opA, operacionGuiaId: guiaA1 }).expect(409);
  });

  it('refuses a guía that must not be declared as leaving, and says which case it is', async () => {
    await query(`UPDATE operacion_guias SET estado='retenida' WHERE id=$1`, [guiaA1]);
    const retenida = await agregarPartida(id, { operacionId: opA, operacionGuiaId: guiaA1 }).expect(409);
    expect(retenida.body.error).toContain('CT-5');

    await query(`UPDATE operacion_guias SET estado='no_transmitida' WHERE id=$1`, [guiaA2]);
    const noTransmitida = await agregarPartida(id, { operacionId: opA, operacionGuiaId: guiaA2 }).expect(409);
    expect(noTransmitida.body.error).toContain('CT-2');

    await query(`UPDATE operacion_guias SET estado='csa_pendiente' WHERE id=$1`, [guiaB1]);
    const csa = await agregarPartida(id, { operacionId: opB, operacionGuiaId: guiaB1 }).expect(409);
    expect(csa.body.error).toContain('CT-3');
  });

  it('refuses a guía that belongs to another caso', async () => {
    const res = await agregarPartida(id, { operacionId: opA, operacionGuiaId: guiaB1 }).expect(400);
    expect(res.body.error).toContain('no pertenece');
  });

  it('refuses the same guía twice on the same truck', async () => {
    await agregarPartida(id, { operacionId: opA, operacionGuiaId: guiaA1 }).expect(201);
    await agregarPartida(id, { operacionId: opA, operacionGuiaId: guiaA1 }).expect(409);
  });

  it('refuses more cargo once the load is closed', async () => {
    await agregarPartida(id, { operacionId: opA, operacionGuiaId: guiaA1 }).expect(201);
    await estado(id, { estado: 'cargado' }).expect(201);
    const res = await agregarPartida(id, { operacionId: opA, operacionGuiaId: guiaA2 }).expect(409);
    expect(res.body.error).toContain('cerrada');
  });

  it('writes the event on THAT caso only, linked to the trip', async () => {
    await agregarPartida(id, { operacionId: opA, operacionGuiaId: guiaA1 }).expect(201);
    await agregarPartida(id, { operacionId: opB, operacionGuiaId: guiaB1 }).expect(201);
    const evA = await eventosDe(opA, 'DESPACHO_PARTIDA_AGREGADA');
    const evB = await eventosDe(opB, 'DESPACHO_PARTIDA_AGREGADA');
    expect(evA).toHaveLength(1);
    expect(evB).toHaveLength(1);
    expect(evA[0].payload.guia).toBe('AAA0001');
    expect(evA[0].despacho_id).toBe(id);
  });

  it('removing a guía leaves the removal on the timeline, even though the row is gone', async () => {
    const p = await agregarPartida(id, { operacionId: opA, operacionGuiaId: guiaA1 }).expect(201);
    await request(app)
      .delete(`/api/despachos/${id}/partidas/${p.body.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect((await query('SELECT id FROM despacho_partidas')).rows).toHaveLength(0);
    const ev = await eventosDe(opA, 'DESPACHO_PARTIDA_RETIRADA');
    expect(ev).toHaveLength(1);
    expect(ev[0].payload.guia).toBe('AAA0001');
  });

  it('records what was actually loaded beside what was planned, and reports the gap', async () => {
    const p = await agregarPartida(id, { operacionId: opA, operacionGuiaId: guiaA1 }).expect(201);
    const res = await request(app)
      .put(`/api/despachos/${id}/partidas/${p.body.id}`)
      // The tramitador may report this: he is the one counting cartons at the dock.
      .set('Authorization', `Bearer ${tramitadorToken}`)
      .send({ cartonesCargados: 8 })
      .expect(200);
    expect(res.body.cartonesCargados).toBe(8);
    expect(res.body.diferencia).toBe(-2);
  });

  it('404s for an unknown caso and an unknown trip', async () => {
    await agregarPartida(id, { operacionId: '11111111-1111-4111-8111-111111111111' }).expect(404);
    await agregarPartida('11111111-1111-4111-8111-111111111111', { operacionId: opA }).expect(404);
  });
});

// -------------------------------------------------------------------------------------------------
describe('máquina de estados — R21', () => {
  let id: string;
  beforeEach(async () => {
    id = (await crearDespacho({ transportistaId, citaAt: '2026-08-14T16:00:00Z' }).expect(201)).body.id;
    await agregarPartida(id, { operacionId: opA, operacionGuiaId: guiaA1 }).expect(201);
  });

  it('walks the trip forward and stamps each timestamp', async () => {
    await estado(id, { estado: 'solicitado' }).expect(201);
    await estado(id, { estado: 'confirmado' }).expect(201);
    await estado(id, { estado: 'en_patio', ocurridoAt: '2026-08-14T16:05:00Z' }).expect(201);
    await estado(id, { estado: 'cargando', ocurridoAt: '2026-08-14T17:00:00Z' }).expect(201);
    await estado(id, { estado: 'cargado', ocurridoAt: '2026-08-14T18:30:00Z' }).expect(201);

    const { rows } = await query<Record<string, Date | null>>(
      'SELECT ingreso_patio_at, inicio_carga_at, fin_carga_at, estado FROM despachos WHERE id = $1',
      [id],
    );
    expect(rows[0].estado).toBe('cargado');
    expect(rows[0].ingreso_patio_at).not.toBeNull();
    expect(rows[0].fin_carga_at).not.toBeNull();
  });

  it('reports the delay against the appointment — R30, the number the requirement is about', async () => {
    const res = await estado(id, { estado: 'en_patio', ocurridoAt: '2026-08-14T16:05:00Z' }).expect(201);
    expect(res.body.demoraMin).toBe(5);
    const ev = await eventosDe(opA, 'DESPACHO_ESTADO');
    expect(ev[0].payload.demoraMin).toBe(5);
  });

  it('reports the loading dwell time', async () => {
    await estado(id, { estado: 'cargando', ocurridoAt: '2026-08-14T17:00:00Z' }).expect(201);
    const res = await estado(id, { estado: 'cargado', ocurridoAt: '2026-08-14T18:30:00Z' }).expect(201);
    expect(res.body.tiempoCargaMin).toBe(90);
  });

  it('treats a repeat as a noop, not as an error and not as a second event', async () => {
    await estado(id, { estado: 'confirmado' }).expect(201);
    const res = await estado(id, { estado: 'confirmado' }).expect(200);
    expect(res.body.noop).toBe(true);
    expect(await eventosDe(opA, 'DESPACHO_ESTADO')).toHaveLength(1);
  });

  it('never goes backwards', async () => {
    await estado(id, { estado: 'cargando' }).expect(201);
    const res = await estado(id, { estado: 'en_patio' }).expect(409);
    expect(res.body.error).toContain('monótono');
  });

  it('pauses only before the load commits', async () => {
    await estado(id, { estado: 'confirmado' }).expect(201);
    await estado(id, { estado: 'en_espera' }).expect(201);
    await estado(id, { estado: 'confirmado' }).expect(201); // resumed where it stopped

    await estado(id, { estado: 'cargando' }).expect(201);
    // From here the flete is owed whether the load finishes or not: pausing would hide a cost.
    const res = await estado(id, { estado: 'en_espera' }).expect(409);
    expect(res.body.error).toContain('espera');
  });

  it('resumes against the pause point read back from the ledger, never rewinding through it', async () => {
    await estado(id, { estado: 'en_aduana' }).expect(201);
    await estado(id, { estado: 'en_espera' }).expect(201);
    const atras = await estado(id, { estado: 'solicitado' }).expect(409);
    expect(atras.body.error).toContain('en espera');

    const res = await estado(id, { estado: 'cargando' }).expect(201);
    expect(res.body.reanudadoDesde).toBe('en_aduana');
  });

  it('lets the tramitador report physical facts but not cancel the trip', async () => {
    await estado(id, { estado: 'en_patio' }, tramitadorToken).expect(201);
    const ev = await eventosDe(opA, 'DESPACHO_ESTADO');
    expect(ev[0].origen).toBe('tramitador');

    const res = await estado(id, { estado: 'cancelado' }, tramitadorToken).expect(403);
    expect(res.body.error).toContain('oficina');
  });

  it('cancels from anywhere and stays cancelled', async () => {
    await estado(id, { estado: 'en_aduana' }).expect(201);
    await estado(id, { estado: 'cancelado', motivo: 'el vuelo se demoró 14 h' }).expect(201);
    expect(await eventosDe(opA, 'DESPACHO_CANCELADO')).toHaveLength(1);
    await estado(id, { estado: 'en_transito' }).expect(409);
  });

  it('does not rewrite the first time a state happened when it is re-entered after a pause', async () => {
    await estado(id, { estado: 'en_patio', ocurridoAt: '2026-08-14T16:05:00Z' }).expect(201);
    const primera = (
      await query<{ ingreso_patio_at: Date }>('SELECT ingreso_patio_at FROM despachos WHERE id=$1', [id])
    ).rows[0].ingreso_patio_at;
    await estado(id, { estado: 'en_espera' }).expect(201);
    await estado(id, { estado: 'en_patio', ocurridoAt: '2026-08-14T19:00:00Z' }).expect(201);
    const segunda = (
      await query<{ ingreso_patio_at: Date }>('SELECT ingreso_patio_at FROM despachos WHERE id=$1', [id])
    ).rows[0].ingreso_patio_at;
    expect(new Date(segunda).getTime()).toBe(new Date(primera).getTime());
  });
});

// -------------------------------------------------------------------------------------------------
describe('reasignación — CT-7 / D10, la única acción que toca dinero', () => {
  let id: string;
  beforeEach(async () => {
    id = (
      await crearDespacho({ transportistaId, unidadId: unidadTractoId, direccionEntregaId: direccionId }).expect(201)
    ).body.id;
    await agregarPartida(id, { operacionId: opA, operacionGuiaId: guiaA1 }).expect(201);
  });

  function reasignar(body: Record<string, unknown>, token = adminToken) {
    return request(app).post(`/api/despachos/${id}/reasignar`).set('Authorization', `Bearer ${token}`).send(body);
  }

  it('demands a motivo — automating a spend decision without recording who approved it is the trace we would not have', async () => {
    await reasignar({}).expect(400);
    await reasignar({ motivo: '   ' }).expect(400);
  });

  it('cancels the original and hands the contracted unit to a new trip', async () => {
    const res = await reasignar({ motivo: 'el vuelo se demoró 14 h; se reasigna el tracto ya contratado' }).expect(201);
    expect(res.body.reasignadoDeDespachoId).toBe(id);
    expect(res.body.transportistaId).toBe(transportistaId);
    expect(res.body.unidadId).toBe(unidadTractoId);
    expect(res.body.placas).toBe('ABC1234');

    const { rows } = await query<{ estado: string }>('SELECT estado FROM despachos WHERE id=$1', [id]);
    expect(rows[0].estado).toBe('cancelado');
  });

  it('starts the new trip EMPTY unless asked otherwise — the original cargo is usually not coming', async () => {
    const res = await reasignar({ motivo: 'vuelo demorado' }).expect(201);
    const { rows } = await query('SELECT id FROM despacho_partidas WHERE despacho_id=$1', [res.body.id]);
    expect(rows).toHaveLength(0);

    const conCarga = await request(app)
      .post(`/api/despachos/${res.body.id}/reasignar`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ motivo: 'otra contingencia', copiarPartidas: true })
      .expect(201);
    expect(conCarga.body.partidasCopiadas).toBe(0);
  });

  it('recomputes the rate and reports the delta, because the point of the move is that the money changed', async () => {
    // Same destination retained: the delta is zero and STATED, rather than left to be inferred.
    const igual = await reasignar({ motivo: 'vuelo demorado' }).expect(201);
    expect(Number(igual.body.tarifaAnterior)).toBe(9200);
    expect(Number(igual.body.tarifaNueva)).toBe(9200);
    expect(igual.body.deltaTarifa).toBe(0);

    // A different destination falls back to the general rate, and the difference is the number a
    // human is confirming when they approve the move.
    const otraDireccion = await query<{ id: string }>(
      `INSERT INTO client_direcciones (client_id, alias) VALUES ($1,'Bodega Norte') RETURNING id`,
      [clientId],
    );
    const distinto = await request(app)
      .post(`/api/despachos/${igual.body.id}/reasignar`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ motivo: 'segunda contingencia', direccionEntregaId: otraDireccion.rows[0].id })
      .expect(201);
    expect(Number(distinto.body.tarifaNueva)).toBe(8500);
    expect(distinto.body.deltaTarifa).toBe(-700);
  });

  it('logs override = true with the motivo on every affected caso, plus one audit row', async () => {
    await reasignar({ motivo: 'el vuelo se demoró 14 h' }).expect(201);
    const ev = await eventosDe(opA, 'DESPACHO_REASIGNADO');
    expect(ev).toHaveLength(1);
    expect(ev[0].override).toBe(true);
    expect(String(ev[0].payload.efecto)).toContain('flete en falso');

    const { rows } = await query<{ after: Record<string, unknown> }>(
      `SELECT after FROM audit_log WHERE action='DESPACHO_REASIGNADO'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].after.override).toBe(true);
    expect(rows[0].after.motivo).toBe('el vuelo se demoró 14 h');
  });

  it('refuses when there is no contracted unit to save', async () => {
    const sinTransportista = (await crearDespacho().expect(201)).body.id;
    const res = await request(app)
      .post(`/api/despachos/${sinTransportista}/reasignar`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ motivo: 'x' })
      .expect(409);
    expect(res.body.error).toContain('cancelarlo');
  });

  it('refuses on a delivered or already cancelled trip', async () => {
    await estado(id, { estado: 'cancelado', motivo: 'ya' }).expect(201);
    await reasignar({ motivo: 'tarde' }).expect(409);
  });
});

// -------------------------------------------------------------------------------------------------
describe('arribo estimado contra arribo real — R36 / D14', () => {
  let id: string;
  beforeEach(async () => {
    id = (
      await crearDespacho({ transportistaId, direccionEntregaId: direccionId }).expect(201)
    ).body.id;
    await agregarPartida(id, { operacionId: opA, operacionGuiaId: guiaA1 }).expect(201);
  });

  function eta(body: Record<string, unknown> = {}) {
    return request(app).post(`/api/despachos/${id}/eta`).set('Authorization', `Bearer ${adminToken}`).send(body);
  }

  it('estimates from the customs point the cargo actually arrived at, and stores how it did it', async () => {
    const res = await eta({ salidaAt: '2026-08-14T18:00:00Z' }).expect(201);
    expect(res.body.etaCalculado).toBeTruthy();
    expect(res.body.calculo.metodo).toBe('estimacion_deterministica');
    // Resolved from operaciones.destino_iata = 'NLU'.
    expect(res.body.calculo.origen).toContain('NLU');
    expect(res.body.calculo.confianza).toBe('baja');

    const { rows } = await query<{ eta_calculado: Date; eta_calculo: Record<string, unknown> }>(
      'SELECT eta_calculado, eta_calculo FROM despachos WHERE id=$1',
      [id],
    );
    expect(rows[0].eta_calculado).not.toBeNull();
    expect(rows[0].eta_calculo.rulesetVersion).toBeTruthy();
  });

  it('is deterministic: the same departure gives the same estimate', async () => {
    const a = await eta({ salidaAt: '2026-08-14T18:00:00Z' }).expect(201);
    const b = await eta({ salidaAt: '2026-08-14T18:00:00Z' }).expect(201);
    expect(a.body.etaCalculado).toBe(b.body.etaCalculado);
  });

  it('REFUSES rather than inventing a time when the destination has no coordinates', async () => {
    await query('UPDATE client_direcciones SET lat=NULL, lng=NULL');
    const res = await eta().expect(409);
    expect(res.body.error).toContain('no se estima');
    expect((await query('SELECT eta_calculado FROM despachos WHERE id=$1', [id])).rows[0].eta_calculado).toBeNull();
  });

  it('refuses when the trip has no destination at all', async () => {
    const sinDestino = (await crearDespacho().expect(201)).body.id;
    await request(app)
      .post(`/api/despachos/${sinDestino}/eta`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
      .expect(409);
  });

  it('refuses when the origin cannot be resolved, and names the code it could not resolve', async () => {
    await query(`UPDATE operaciones SET destino_iata='XXX'`);
    const res = await eta().expect(409);
    expect(res.body.error).toContain('XXX');
  });

  it('accepts explicit origin coordinates as the most specific source', async () => {
    const res = await eta({ origenLat: 19.4361, origenLng: -99.0719, salidaAt: '2026-08-14T18:00:00Z' }).expect(201);
    expect(res.body.calculo.origen).toContain('coordenadas indicadas');
  });

  it('marks the estimate as system-derived on the timeline, not as somebody\'s judgement', async () => {
    await eta({ salidaAt: '2026-08-14T18:00:00Z' }).expect(201);
    const ev = await eventosDe(opA, 'ETA_CALCULADA');
    expect(ev).toHaveLength(1);
    expect(ev[0].origen).toBe('sistema');
    expect(ev[0].payload.confianza).toBe('baja');
  });

  it('records the observed arrival BESIDE the estimate and reports the gap', async () => {
    await eta({ salidaAt: '2026-08-14T18:00:00Z' }).expect(201);
    const etaGuardado = (
      await query<{ eta_calculado: Date }>('SELECT eta_calculado FROM despachos WHERE id=$1', [id])
    ).rows[0].eta_calculado;

    const res = await request(app)
      .post(`/api/despachos/${id}/arribo`)
      .set('Authorization', `Bearer ${tramitadorToken}`)
      .send({ arriboAt: new Date(new Date(etaGuardado).getTime() + 25 * 60_000).toISOString() })
      .expect(201);
    expect(res.body.desviacionMin).toBe(25);

    // D14: the estimate is EXACTLY as it was made. Reality never overwrites it.
    const despues = (
      await query<{ eta_calculado: Date; arribo_real: Date }>(
        'SELECT eta_calculado, arribo_real FROM despachos WHERE id=$1',
        [id],
      )
    ).rows[0];
    expect(new Date(despues.eta_calculado).getTime()).toBe(new Date(etaGuardado).getTime());
    expect(despues.arribo_real).not.toBeNull();
  });

  it('reports a null deviation, not zero, when there was never an estimate', async () => {
    const res = await request(app)
      .post(`/api/despachos/${id}/arribo`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
      .expect(201);
    expect(res.body.desviacionMin).toBeNull();
  });

  it('does not mark the trip delivered — arriving at the gate is not a signed POD', async () => {
    await estado(id, { estado: 'en_transito' }).expect(201);
    await request(app)
      .post(`/api/despachos/${id}/arribo`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
      .expect(201);
    const { rows } = await query<{ estado: string }>('SELECT estado FROM despachos WHERE id=$1', [id]);
    expect(rows[0].estado).toBe('en_transito');
  });

  it('refuses to overwrite an arrival already recorded', async () => {
    await request(app).post(`/api/despachos/${id}/arribo`).set('Authorization', `Bearer ${adminToken}`).send({}).expect(201);
    await request(app).post(`/api/despachos/${id}/arribo`).set('Authorization', `Bearer ${adminToken}`).send({}).expect(409);
  });

  it('refuses an arrival on a cancelled trip', async () => {
    await estado(id, { estado: 'cancelado', motivo: 'ya' }).expect(201);
    await request(app).post(`/api/despachos/${id}/arribo`).set('Authorization', `Bearer ${adminToken}`).send({}).expect(409);
  });
});
