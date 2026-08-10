import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { query } from '../../src/db/pool';
import { hashPassword } from '../../src/auth/password';
import { signToken } from '../../src/auth/token';
import { truncateAll } from '../helpers/db';
import { createApp } from '../../src/app';

/**
 * PLANEACIÓN — the living plan (PRD-02 R13, R14, R16, R19, P4).
 *
 * The thing being replaced is a chain of emailed spreadsheets in which nobody can prove which
 * version they hold. So what is tested is exactly the properties that fix that:
 *
 *  - a published version is a FROZEN snapshot. Changing the tables afterwards must not change what
 *    version 1 says, or "what did we tell the warehouse on Tuesday?" becomes unanswerable again.
 *  - every version after the first carries a diff AND a stated motivo. A plan that changed for no
 *    declared reason is the Excel problem with better storage.
 *  - republishing an identical document is refused. Publishing noise trains three organisations to
 *    ignore the notification, which costs the attention the versioning exists to buy.
 *  - EXCLUSIONS travel in the document WITH their cause. A caso that is not on the list is either
 *    held, carrying cargo that must not be declared as leaving, or simply not ready — and the
 *    difference decides who has to act. This is the part the spreadsheet never had.
 *  - every caso on the plan gets the publication on its own timeline, because the plan is asked
 *    about one shipment at a time.
 */
const app = createApp();

let adminToken: string;
let capturistaToken: string;
let autoridadToken: string;
let tramitadorToken: string;

let clientId: string;
let direccionId: string;
let transportistaId: string;
let opA: string;
let opB: string;
let guiaA1: string;
let guiaB1: string;

const FECHA = '2026-08-14';

beforeEach(async () => {
  await truncateAll();
  const hash = await hashPassword('p');
  const [adm, cap, auto, tram] = await Promise.all([
    query<{ id: string }>(`INSERT INTO users (username,password_hash,role) VALUES ('p_adm',$1,'admin') RETURNING id`, [hash]),
    query<{ id: string }>(`INSERT INTO users (username,password_hash,role) VALUES ('p_cap',$1,'capturista') RETURNING id`, [hash]),
    query<{ id: string }>(`INSERT INTO users (username,password_hash,role) VALUES ('p_auto',$1,'autoridad') RETURNING id`, [hash]),
    query<{ id: string }>(`INSERT INTO users (username,password_hash,role) VALUES ('p_tram',$1,'tramitador') RETURNING id`, [hash]),
  ]);
  adminToken = signToken({ userId: adm.rows[0].id, role: 'admin', tv: 0 });
  capturistaToken = signToken({ userId: cap.rows[0].id, role: 'capturista', tv: 0 });
  autoridadToken = signToken({ userId: auto.rows[0].id, role: 'autoridad', tv: 0 });
  tramitadorToken = signToken({ userId: tram.rows[0].id, role: 'tramitador', tv: 0 });

  const c = await query<{ id: string }>(`INSERT INTO clients (name) VALUES ('ACME') RETURNING id`);
  clientId = c.rows[0].id;
  const d = await query<{ id: string }>(
    `INSERT INTO client_direcciones (client_id, alias) VALUES ($1,'IMILE Cuautitlán') RETURNING id`,
    [clientId],
  );
  direccionId = d.rows[0].id;
  const t = await query<{ id: string }>(
    `INSERT INTO transportistas (razon_social) VALUES ('Transportes del Bajío') RETURNING id`,
  );
  transportistaId = t.rows[0].id;

  const ops = await query<{ id: string; mawb: string }>(
    `INSERT INTO operaciones (mawb, mawb_raw, etapa, client_id) VALUES
       ('160-11111111','160-11111111','disponible',$1),
       ('160-22222222','160-22222222','en_vuelo',$1)
     RETURNING id, mawb`,
    [clientId],
  );
  opA = ops.rows.find((r) => r.mawb === '160-11111111')!.id;
  opB = ops.rows.find((r) => r.mawb === '160-22222222')!.id;

  const guias = await query<{ id: string; guia_norm: string }>(
    `INSERT INTO operacion_guias (operacion_id, guia_norm, piezas, cartones, estado, client_id) VALUES
       ($1,'AAA0001',100,10,'declarada',$3),
       ($2,'BBB0001',20,2,'declarada',$3)
     RETURNING id, guia_norm`,
    [opA, opB, clientId],
  );
  guiaA1 = guias.rows.find((r) => r.guia_norm === 'AAA0001')!.id;
  guiaB1 = guias.rows.find((r) => r.guia_norm === 'BBB0001')!.id;
});

async function crearDespachoCon(guias: Array<{ operacionId: string; operacionGuiaId: string }>): Promise<string> {
  const d = await request(app)
    .post('/api/despachos')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ fechaOperacion: FECHA, tipoUnidad: 'tracto', transportistaId, direccionEntregaId: direccionId, placas: 'ABC1234' })
    .expect(201);
  for (const g of guias) {
    await request(app)
      .post(`/api/despachos/${d.body.id}/partidas`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send(g)
      .expect(201);
  }
  return d.body.id;
}

function publicar(body: Record<string, unknown> = {}, token = adminToken) {
  return request(app)
    .post('/api/planeacion/publicar')
    .set('Authorization', `Bearer ${token}`)
    .send({ fechaOperacion: FECHA, ...body });
}

// -------------------------------------------------------------------------------------------------
describe('vista del día — R13 / R16', () => {
  it('lists loadable guías not yet on a unit as the planner worklist', async () => {
    const res = await request(app)
      .get(`/api/planeacion?fecha=${FECHA}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(res.body.elegibles).toHaveLength(2);
    expect(res.body.despachos).toHaveLength(0);
  });

  it('keeps a caso still in the air eligible — planning the day before is the point (R13)', async () => {
    const res = await request(app)
      .get(`/api/planeacion?fecha=${FECHA}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    // opB is `en_vuelo`. Etapa never excludes; only holds and guía states do.
    expect(res.body.elegibles.map((e: { mawb: string }) => e.mawb)).toContain('160-22222222');
  });

  it('drops a guía from the worklist once it is on a unit for that date', async () => {
    await crearDespachoCon([{ operacionId: opA, operacionGuiaId: guiaA1 }]);
    const res = await request(app)
      .get(`/api/planeacion?fecha=${FECHA}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(res.body.elegibles).toHaveLength(1);
    expect(res.body.elegibles[0].guia).toBe('BBB0001');
    expect(res.body.despachos).toHaveLength(1);
    expect(res.body.despachos[0].partidas).toHaveLength(1);
  });

  it('publishes exclusions WITH their cause — the part the spreadsheet never had', async () => {
    await request(app)
      .post(`/api/operaciones/${opA}/holds`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ tipo: 'csa', alcance: 'operacion', motivo: 'consignada a otra agencia; falta la cesión' })
      .expect(201);
    await query(`UPDATE operacion_guias SET estado='no_transmitida' WHERE id=$1`, [guiaB1]);

    const res = await request(app)
      .get(`/api/planeacion?fecha=${FECHA}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const causas = res.body.exclusiones.map((e: { causa: string }) => e.causa).sort();
    expect(causas).toEqual(['guia_no_transmitida', 'hold_activo']);
    const hold = res.body.exclusiones.find((e: { causa: string }) => e.causa === 'hold_activo');
    expect(hold.mawb).toBe('160-11111111');
    expect(hold.detalle).toContain('falta la cesión');
    // Neither caso is offered for planning any more.
    expect(res.body.elegibles).toHaveLength(0);
  });

  it('is readable by the authority — the exclusions with causes are exactly what gets asked for', async () => {
    await request(app)
      .get(`/api/planeacion?fecha=${FECHA}`)
      .set('Authorization', `Bearer ${autoridadToken}`)
      .expect(200);
    await request(app).get('/api/planeacion').expect(401);
  });
});

// -------------------------------------------------------------------------------------------------
describe('publicación — R19 / P4', () => {
  beforeEach(async () => {
    await crearDespachoCon([{ operacionId: opA, operacionGuiaId: guiaA1 }]);
  });

  it('mints version 1 with no motivo required and no diff', async () => {
    const res = await publicar().expect(201);
    expect(res.body.version).toBe(1);
    expect(res.body.diff.esPrimeraVersion).toBe(true);
    expect(res.body.resumen).toContain('Plan inicial');

    const { rows } = await query<{ diff: unknown }>('SELECT diff FROM plan_publicaciones');
    expect(rows[0].diff).toBeNull();
  });

  it('refuses to publish an empty day', async () => {
    const res = await publicar({ fechaOperacion: '2026-09-01' }).expect(409);
    expect(res.body.error).toContain('no hay plan');
  });

  it('demands a motivo from version 2 onward', async () => {
    await publicar().expect(201);
    await crearDespachoCon([{ operacionId: opB, operacionGuiaId: guiaB1 }]);
    const sinMotivo = await publicar().expect(400);
    expect(sinMotivo.body.error).toContain('motivo');
    const conMotivo = await publicar({ motivo: 'se agregó una unidad por el arribo adelantado' }).expect(201);
    expect(conMotivo.body.version).toBe(2);
  });

  it('refuses an identical republication rather than versioning noise', async () => {
    await publicar().expect(201);
    const res = await publicar({ motivo: 'por si acaso' }).expect(409);
    expect(res.body.version).toBe(1);
    expect((await query('SELECT id FROM plan_publicaciones')).rows).toHaveLength(1);
  });

  it('freezes the snapshot: changing the tables afterwards does not change what version 1 says', async () => {
    const v1 = await publicar().expect(201);
    expect(v1.body.snapshot.despachos[0].placas).toBe('ABC1234');

    await query(`UPDATE despachos SET placas = 'XYZ9876'`);
    const guardada = await request(app)
      .get(`/api/planeacion/publicaciones/${v1.body.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(guardada.body.snapshot.despachos[0].placas).toBe('ABC1234');
  });

  it('ships the delta with version 2, naming what changed', async () => {
    await publicar().expect(201);
    await query(`UPDATE despachos SET placas = 'XYZ9876'`);
    const v2 = await publicar({ motivo: 'cambio de unidad por falla mecánica' }).expect(201);

    expect(v2.body.version).toBe(2);
    expect(v2.body.diff.despachosModificados).toHaveLength(1);
    expect(v2.body.diff.despachosModificados[0].cambios.placas).toEqual({
      antes: 'ABC1234',
      despues: 'XYZ9876',
    });
    const { rows } = await query<{ diff: { despachosModificados: unknown[] } }>(
      'SELECT diff FROM plan_publicaciones WHERE version = 2',
    );
    expect(rows[0].diff.despachosModificados).toHaveLength(1);
  });

  it('reports a guía added to a load as its own change, not as a generic modification', async () => {
    await publicar().expect(201);
    const { rows } = await query<{ id: string }>('SELECT id FROM despachos LIMIT 1');
    await request(app)
      .post(`/api/despachos/${rows[0].id}/partidas`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ operacionId: opB, operacionGuiaId: guiaB1 })
      .expect(201);

    const v2 = await publicar({ motivo: 'se consolidó una guía más al mismo destino' }).expect(201);
    expect(v2.body.diff.despachosModificados[0].partidasAgregadas).toEqual(['BBB0001']);
  });

  it('tracks an exclusion appearing between versions', async () => {
    await publicar().expect(201);
    await query(`UPDATE operacion_guias SET estado='no_transmitida' WHERE id=$1`, [guiaB1]);
    const v2 = await publicar({ motivo: 'guía BBB0001 sin transmitir' }).expect(201);
    expect(v2.body.diff.exclusionesAgregadas).toHaveLength(1);
    expect(v2.body.diff.exclusionesAgregadas[0].causa).toBe('guia_no_transmitida');
  });

  it('writes PLAN_PUBLICADO on every caso on the plan, and one audit row per publication', async () => {
    await crearDespachoCon([{ operacionId: opB, operacionGuiaId: guiaB1 }]);
    const res = await publicar().expect(201);
    expect(res.body.eventosRegistrados).toBe(2);

    for (const op of [opA, opB]) {
      const { rows } = await query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM operacion_eventos WHERE operacion_id = $1 AND tipo = 'PLAN_PUBLICADO'`,
        [op],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].payload.version).toBe(1);
      expect(rows[0].payload.fechaOperacion).toBe(FECHA);
    }

    const audit = await query(`SELECT id FROM audit_log WHERE action='PLAN_PUBLICADO'`);
    expect(audit.rows).toHaveLength(1);
  });

  it('leaves a cancelled unit out of the published document', async () => {
    const { rows } = await query<{ id: string }>('SELECT id FROM despachos LIMIT 1');
    await request(app)
      .post(`/api/despachos/${rows[0].id}/estado`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ estado: 'cancelado', motivo: 'vuelo cancelado' })
      .expect(201);
    await publicar().expect(409); // nothing left to publish
  });

  /**
   * R19 / N5 — the fan-out reports what ACTUALLY happened, per recipient.
   *
   * This used to answer `'pendiente: … requiere el fan-out (#31)'`. Both channels exist now, so the
   * response carries real outcomes — and with neither SMTP nor evolution-api provisioned in a test
   * process, every one of them must come back `omitido` WITH ITS REASON. That is the assertion worth
   * having: `omitido` is not `enviado`, and a plan whose recipients were skipped for want of a mail
   * server must never read as a plan that was distributed.
   */
  it('reports real per-recipient outcomes, and never calls an unsent message sent', async () => {
    const res = await publicar({
      destinatarios: ['almacen@capitalc.com.mx', '+525512345678', 'bodega 3'],
    }).expect(201);

    expect(res.body.notificacion.intentados).toBe(3);
    expect(res.body.notificacion.enviados).toBe(0);
    expect(res.body.notificacion.omitidos).toBe(3);
    expect(res.body.notificacion.errores).toBe(0);

    const detalle = res.body.notificacion.detalle as Array<{
      destino: string; canal: string | null; estado: string; detalle: string;
    }>;
    // The channel is derived from the handle's shape: an address goes by mail, a number by WhatsApp,
    // and something that is neither is named rather than silently dropped.
    expect(detalle.find((d) => d.destino === 'almacen@capitalc.com.mx')).toMatchObject({
      canal: 'email', estado: 'omitido',
    });
    expect(detalle.find((d) => d.destino === '+525512345678')).toMatchObject({
      canal: 'whatsapp', estado: 'omitido',
    });
    expect(detalle.find((d) => d.destino === 'bodega 3')).toMatchObject({
      canal: null, estado: 'omitido',
    });
    expect(detalle.find((d) => d.destino === 'bodega 3')!.detalle).toMatch(/no reconocido/);

    const { rows } = await query<{ destinatarios: string[] }>('SELECT destinatarios FROM plan_publicaciones');
    expect(rows[0].destinatarios).toEqual(['almacen@capitalc.com.mx', '+525512345678', 'bodega 3']);
  });

  it('records the delivery outcomes on the audit row, not only in the response', async () => {
    await publicar({ destinatarios: ['almacen@capitalc.com.mx'] }).expect(201);
    const { rows } = await query<{ after: Record<string, any> }>(
      `SELECT after FROM audit_log WHERE action='PLAN_PUBLICADO' ORDER BY created_at DESC LIMIT 1`,
    );
    // "Was the warehouse told?" has to be answerable from the audit trail alone.
    expect(rows[0].after.notificacion).toMatchObject({ intentados: 1, enviados: 0, omitidos: 1 });
  });

  it('is closed to the field and authority roles for writing, open to both for reading', async () => {
    await publicar({}, tramitadorToken).expect(403);
    await publicar({}, autoridadToken).expect(403);
    await publicar({}, capturistaToken).expect(201);

    const hist = await request(app)
      .get(`/api/planeacion/publicaciones?fecha=${FECHA}`)
      .set('Authorization', `Bearer ${autoridadToken}`)
      .expect(200);
    expect(hist.body).toHaveLength(1);
    expect(hist.body[0].publicadoPor).toBe('p_cap');
    expect(hist.body[0].despachos).toBe(1);
  });

  it('404s for an unknown publication', async () => {
    await request(app)
      .get('/api/planeacion/publicaciones/11111111-1111-4111-8111-111111111111')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(404);
  });
});
