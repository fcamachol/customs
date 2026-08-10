import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { query } from '../../src/db/pool';
import { hashPassword } from '../../src/auth/password';
import { signToken } from '../../src/auth/token';
import { truncateAll } from '../helpers/db';
import { createApp } from '../../src/app';

/**
 * POD — the signature that closes the physical chain (PRD-02 R28/R39).
 *
 * Each block below is a way the process this replaces actually fails:
 *
 *  - a truck that ARRIVED being counted as a delivery. `POST /arribo` deliberately stops short of
 *    `entregado` (#29); these tests pin that only a signed POD completes it, and that the completion
 *    reaches both the trip and every caso riding on it.
 *  - evidence being quietly reprinted. Regeneration is allowed while the document is a rendering of
 *    a plan and refused the moment it becomes a record of what somebody signed.
 *  - a refusal at the door disappearing into "not yet signed". `rechazado` is a real outcome with a
 *    mandatory reason, and it does NOT deliver.
 *  - a signature nobody archived. The signed sheet is hashed by `saveFile` before the state moves.
 */
const app = createApp();

let adminToken: string;
let capturistaToken: string;
let tramitadorToken: string;
let autoridadToken: string;

let clientId: string;
let direccionId: string;
let transportistaId: string;
let opA: string;
let opB: string;
let guiaA1: string;
let guiaB1: string;
let despachoId: string;

const FECHA = '2026-08-14';

const pdf = (): Buffer => Buffer.from('%PDF-1.4 firmado');

async function seed(): Promise<void> {
  const c = await query<{ id: string }>(`INSERT INTO clients (name) VALUES ('ACME') RETURNING id`);
  clientId = c.rows[0].id;
  const d = await query<{ id: string }>(
    `INSERT INTO client_direcciones (client_id, alias, direccion, ciudad, lat, lng)
     VALUES ($1,'IMILE Cuautitlán','Parque Logístico 12','Cuautitlán', 19.6697, -99.1817) RETURNING id`,
    [clientId],
  );
  direccionId = d.rows[0].id;
  const t = await query<{ id: string }>(
    `INSERT INTO transportistas (razon_social, estado) VALUES ('Transportes del Bajío','activo') RETURNING id`,
  );
  transportistaId = t.rows[0].id;

  const ops = await query<{ id: string; mawb: string }>(
    `INSERT INTO operaciones (mawb, mawb_raw, etapa, client_id, destino_iata) VALUES
       ('160-11111111','160-11111111','en_transito',$1,'NLU'),
       ('160-22222222','160-22222222','en_transito',$1,'NLU')
     RETURNING id, mawb`,
    [clientId],
  );
  opA = ops.rows.find((r) => r.mawb === '160-11111111')!.id;
  opB = ops.rows.find((r) => r.mawb === '160-22222222')!.id;

  const guias = await query<{ id: string; guia_norm: string }>(
    `INSERT INTO operacion_guias (operacion_id, guia_norm, guia_raw, piezas, cartones, estado, client_id) VALUES
       ($1,'AAA0001','AAA-0001',100,10,'declarada',$3),
       ($2,'BBB0001','BBB-0001',20,2,'declarada',$3)
     RETURNING id, guia_norm`,
    [opA, opB, clientId],
  );
  guiaA1 = guias.rows.find((r) => r.guia_norm === 'AAA0001')!.id;
  guiaB1 = guias.rows.find((r) => r.guia_norm === 'BBB0001')!.id;

  const desp = await query<{ id: string }>(
    `INSERT INTO despachos (folio, fecha_operacion, tipo_unidad, transportista_id, placas,
                            operador_nombre, direccion_entrega_id, estado, salida_at, arribo_real)
     VALUES ('D-20260814-001',$1,'tracto',$2,'ABC1234','Juan Pérez',$3,'en_transito',
             '2026-08-14T18:00:00Z','2026-08-14T20:35:00Z')
     RETURNING id`,
    [FECHA, transportistaId, direccionId],
  );
  despachoId = desp.rows[0].id;

  await query(
    `INSERT INTO despacho_partidas (despacho_id, operacion_id, operacion_guia_id, cartones_planeados, cartones_cargados, piezas, orden_carga)
     VALUES ($1,$2,$3,10,9,100,1), ($1,$4,$5,2,2,20,2)`,
    [despachoId, opA, guiaA1, opB, guiaB1],
  );
}

beforeEach(async () => {
  await truncateAll();
  const hash = await hashPassword('p');
  const [adm, cap, tram, auto] = await Promise.all([
    query<{ id: string }>(`INSERT INTO users (username,password_hash,role) VALUES ('p_adm',$1,'admin') RETURNING id`, [hash]),
    query<{ id: string }>(`INSERT INTO users (username,password_hash,role) VALUES ('p_cap',$1,'capturista') RETURNING id`, [hash]),
    query<{ id: string }>(`INSERT INTO users (username,password_hash,role) VALUES ('p_tram',$1,'tramitador') RETURNING id`, [hash]),
    query<{ id: string }>(`INSERT INTO users (username,password_hash,role) VALUES ('p_auto',$1,'autoridad') RETURNING id`, [hash]),
  ]);
  adminToken = signToken({ userId: adm.rows[0].id, role: 'admin', tv: 0 });
  capturistaToken = signToken({ userId: cap.rows[0].id, role: 'capturista', tv: 0 });
  tramitadorToken = signToken({ userId: tram.rows[0].id, role: 'tramitador', tv: 0 });
  autoridadToken = signToken({ userId: auto.rows[0].id, role: 'autoridad', tv: 0 });
  await seed();
});

async function generar(): Promise<string> {
  const r = await request(app)
    .post(`/api/despachos/${despachoId}/pod`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({});
  expect(r.status).toBe(201);
  return r.body.id as string;
}

describe('POST /api/despachos/:id/pod — generación (R28/R39)', () => {
  it('genera el POD desde la asignación de despacho, con hash y snapshot', async () => {
    const r = await request(app)
      .post(`/api/despachos/${despachoId}/pod`)
      .set('Authorization', `Bearer ${capturistaToken}`)
      .send({});

    expect(r.status).toBe(201);
    expect(r.body.folio).toBe('POD-D-20260814-001');
    expect(r.body.version).toBe(1);
    expect(r.body.estado).toBe('generado');
    expect(r.body.contentHash).toMatch(/^[0-9a-f]{64}$/);
    // The snapshot carries the whole load, so the document can be re-rendered later without
    // becoming a different document (Q6: the template is still pending).
    expect(r.body.snapshot.partidas).toHaveLength(2);
    expect(r.body.snapshot.totales).toMatchObject({ guias: 2, cartonesCargados: 11, piezas: 120 });
    expect(r.body.advertencia).toMatch(/Plantilla de POD pendiente/);

    const f = await query<{ kind: string; content_hash: string }>(
      'SELECT kind, content_hash FROM files WHERE id = $1', [r.body.fileId]);
    expect(f.rows[0].kind).toBe('pod');
    expect(f.rows[0].content_hash).toBe(r.body.contentHash);
  });

  it('escribe POD_GENERADO en la bitácora de CADA caso que va en la unidad', async () => {
    await generar();
    const ev = await query<{ operacion_id: string; despacho_id: string }>(
      `SELECT operacion_id, despacho_id FROM operacion_eventos WHERE tipo = 'POD_GENERADO'`);
    expect(ev.rows).toHaveLength(2);
    expect(new Set(ev.rows.map((r) => r.operacion_id))).toEqual(new Set([opA, opB]));
    expect(ev.rows.every((r) => r.despacho_id === despachoId)).toBe(true);
  });

  it('se niega a generar un POD de un despacho sin carga', async () => {
    const vacio = await query<{ id: string }>(
      `INSERT INTO despachos (folio, fecha_operacion, tipo_unidad) VALUES ('D-20260814-009',$1,'tracto') RETURNING id`,
      [FECHA],
    );
    const r = await request(app)
      .post(`/api/despachos/${vacio.rows[0].id}/pod`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/entrega de nada/);
  });

  it('regenera mientras el documento sigue siendo un plan, subiendo la versión', async () => {
    const podId = await generar();
    const r = await request(app)
      .post(`/api/despachos/${despachoId}/pod`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ observaciones: 'Se cambió una guía' });
    expect(r.status).toBe(201);
    expect(r.body.id).toBe(podId);
    expect(r.body.version).toBe(2);

    const filas = await query('SELECT id FROM pods');
    expect(filas.rows).toHaveLength(1);
  });

  it('el tramitador no genera documentos: es un acto de oficina', async () => {
    const r = await request(app)
      .post(`/api/despachos/${despachoId}/pod`)
      .set('Authorization', `Bearer ${tramitadorToken}`)
      .send({});
    expect(r.status).toBe(403);
  });
});

describe('POST /api/pods/:id/firmado — la firma completa la entrega (R39)', () => {
  it('avanza el despacho a entregado y CADA caso a etapa entregado', async () => {
    const podId = await generar();

    const r = await request(app)
      .post(`/api/pods/${podId}/firmado`)
      .set('Authorization', `Bearer ${tramitadorToken}`)
      .field('firmadoPor', 'Ing. Ramírez — almacén IMILE')
      .field('firmadoAt', '2026-08-14T22:10:00Z')
      .attach('file', pdf(), { filename: 'pod-firmado.pdf', contentType: 'application/pdf' });

    expect(r.status).toBe(201);
    expect(r.body.estado).toBe('firmado');
    expect(r.body.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.body.operacionesEntregadas).toHaveLength(2);

    const d = await query<{ estado: string }>('SELECT estado FROM despachos WHERE id = $1', [despachoId]);
    expect(d.rows[0].estado).toBe('entregado');

    const ops = await query<{ etapa: string }>('SELECT etapa FROM operaciones ORDER BY mawb');
    expect(ops.rows.map((o) => o.etapa)).toEqual(['entregado', 'entregado']);

    const ev = await query(`SELECT operacion_id FROM operacion_eventos WHERE tipo = 'POD_FIRMADO'`);
    expect(ev.rows).toHaveLength(2);
  });

  it('un arribo registrado NO entrega por sí solo — sólo la firma lo hace', async () => {
    // The despacho was seeded with `arribo_real` already set and estado 'en_transito' (#29's rule).
    const antes = await query<{ estado: string; arribo_real: Date }>(
      'SELECT estado, arribo_real FROM despachos WHERE id = $1', [despachoId]);
    expect(antes.rows[0].arribo_real).not.toBeNull();
    expect(antes.rows[0].estado).toBe('en_transito');

    const ops = await query<{ etapa: string }>('SELECT etapa FROM operaciones');
    expect(ops.rows.every((o) => o.etapa === 'en_transito')).toBe(true);
  });

  it('exige el documento: una firma sin archivo archivado es un dicho, no un registro', async () => {
    const podId = await generar();
    const r = await request(app)
      .post(`/api/pods/${podId}/firmado`)
      .set('Authorization', `Bearer ${adminToken}`)
      .field('firmadoPor', 'Ing. Ramírez');
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Falta el archivo/);
  });

  it('exige quién firmó', async () => {
    const podId = await generar();
    const r = await request(app)
      .post(`/api/pods/${podId}/firmado`)
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('file', pdf(), { filename: 'pod.pdf', contentType: 'application/pdf' });
    expect(r.status).toBe(400);
  });

  it('rechaza un tipo de archivo que no es foto ni PDF', async () => {
    const podId = await generar();
    const r = await request(app)
      .post(`/api/pods/${podId}/firmado`)
      .set('Authorization', `Bearer ${adminToken}`)
      .field('firmadoPor', 'X')
      .attach('file', Buffer.from('MZ'), { filename: 'pod.exe', contentType: 'application/x-msdownload' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/no permitido/);
  });

  it('no se firma dos veces: sobrescribir borraría la firma original', async () => {
    const podId = await generar();
    await request(app)
      .post(`/api/pods/${podId}/firmado`)
      .set('Authorization', `Bearer ${adminToken}`)
      .field('firmadoPor', 'Primero')
      .attach('file', pdf(), { filename: 'a.pdf', contentType: 'application/pdf' });

    const r = await request(app)
      .post(`/api/pods/${podId}/firmado`)
      .set('Authorization', `Bearer ${adminToken}`)
      .field('firmadoPor', 'Segundo')
      .attach('file', pdf(), { filename: 'b.pdf', contentType: 'application/pdf' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/ya está firmado/);
  });

  it('un POD firmado ya no se regenera: es evidencia, no un borrador', async () => {
    const podId = await generar();
    await request(app)
      .post(`/api/pods/${podId}/firmado`)
      .set('Authorization', `Bearer ${adminToken}`)
      .field('firmadoPor', 'Ing. Ramírez')
      .attach('file', pdf(), { filename: 'a.pdf', contentType: 'application/pdf' });

    const r = await request(app)
      .post(`/api/despachos/${despachoId}/pod`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/evidencia/);
  });

  it('no fuerza una etapa que ya no puede avanzar: la reporta', async () => {
    await query(`UPDATE operaciones SET etapa = 'cancelada' WHERE id = $1`, [opB]);
    const podId = await generar();
    const r = await request(app)
      .post(`/api/pods/${podId}/firmado`)
      .set('Authorization', `Bearer ${adminToken}`)
      .field('firmadoPor', 'Ing. Ramírez')
      .attach('file', pdf(), { filename: 'a.pdf', contentType: 'application/pdf' });

    expect(r.status).toBe(201);
    expect(r.body.operacionesEntregadas).toEqual(['160-11111111']);
    expect(r.body.operacionesSinAvanzar).toEqual([{ mawb: '160-22222222', etapa: 'cancelada' }]);
  });
});

describe('POST /api/pods/:id/rechazado — el cliente no recibió (R40)', () => {
  it('registra el rechazo con motivo y NO entrega', async () => {
    const podId = await generar();
    const r = await request(app)
      .post(`/api/pods/${podId}/rechazado`)
      .set('Authorization', `Bearer ${capturistaToken}`)
      .send({ motivo: 'El almacén cerró; no hubo quien recibiera.' });

    expect(r.status).toBe(201);
    expect(r.body.estado).toBe('rechazado');

    const d = await query<{ estado: string }>('SELECT estado FROM despachos WHERE id = $1', [despachoId]);
    expect(d.rows[0].estado).toBe('en_transito');
    const ops = await query<{ etapa: string }>('SELECT etapa FROM operaciones');
    expect(ops.rows.every((o) => o.etapa === 'en_transito')).toBe(true);
  });

  it('tras el rechazo se puede regenerar y volver a entregar', async () => {
    const podId = await generar();
    await request(app)
      .post(`/api/pods/${podId}/rechazado`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ motivo: 'El almacén cerró.' });

    const regenerado = await request(app)
      .post(`/api/despachos/${despachoId}/pod`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(regenerado.status).toBe(201);
    expect(regenerado.body.estado).toBe('generado');
    expect(regenerado.body.version).toBe(2);

    // The client's stated reason is not lost: it lives in the append-only ledger event.
    const ev = await query<{ payload: { motivo: string } }>(
      `SELECT payload FROM operacion_eventos WHERE tipo = 'POD_RECHAZADO' LIMIT 1`);
    expect(ev.rows[0].payload.motivo).toBe('El almacén cerró.');

    const firma = await request(app)
      .post(`/api/pods/${podId}/firmado`)
      .set('Authorization', `Bearer ${adminToken}`)
      .field('firmadoPor', 'Ing. Ramírez')
      .attach('file', pdf(), { filename: 'a.pdf', contentType: 'application/pdf' });
    expect(firma.status).toBe(201);
  });

  it('exige el motivo: un rechazo sin causa no es un registro', async () => {
    const podId = await generar();
    const r = await request(app)
      .post(`/api/pods/${podId}/rechazado`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(r.status).toBe(400);
  });

  it('no se rechaza una entrega que el cliente ya aceptó', async () => {
    const podId = await generar();
    await request(app)
      .post(`/api/pods/${podId}/firmado`)
      .set('Authorization', `Bearer ${adminToken}`)
      .field('firmadoPor', 'Ing. Ramírez')
      .attach('file', pdf(), { filename: 'a.pdf', contentType: 'application/pdf' });

    const r = await request(app)
      .post(`/api/pods/${podId}/rechazado`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ motivo: 'tardío' });
    expect(r.status).toBe(409);
  });
});

describe('ciclo enviado y lectura', () => {
  it('marca enviado una sola vez y es idempotente en el reintento', async () => {
    const podId = await generar();
    const a = await request(app)
      .post(`/api/pods/${podId}/enviado`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ destinatario: 'coordinador@imile.mx' });
    expect(a.status).toBe(201);

    const b = await request(app)
      .post(`/api/pods/${podId}/enviado`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(b.status).toBe(200);
    expect(b.body.noop).toBe(true);
  });

  it('lista y detalla el POD con su bitácora, legible para la autoridad', async () => {
    const podId = await generar();
    const lista = await request(app).get('/api/pods').set('Authorization', `Bearer ${autoridadToken}`);
    expect(lista.status).toBe(200);
    expect(lista.body).toHaveLength(1);
    expect(lista.body[0].despachoFolio).toBe('D-20260814-001');

    const detalle = await request(app).get(`/api/pods/${podId}`).set('Authorization', `Bearer ${autoridadToken}`);
    expect(detalle.status).toBe(200);
    expect(detalle.body.eventos.length).toBeGreaterThan(0);
    expect(detalle.body.eventos.every((e: { tipo: string }) => e.tipo.startsWith('POD_'))).toBe(true);
  });

  it('GET /api/despachos/:id/pod dice honestamente que no hay POD todavía', async () => {
    const r = await request(app)
      .get(`/api/despachos/${despachoId}/pod`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(r.status).toBe(404);
    expect(r.body.error).toMatch(/todavía no tiene POD/);
  });
});
