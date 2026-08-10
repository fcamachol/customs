import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { query } from '../../src/db/pool';
import { hashPassword } from '../../src/auth/password';
import { signToken } from '../../src/auth/token';
import { truncateAll } from '../helpers/db';
import { createApp } from '../../src/app';

/**
 * OPERATIONAL REPORTING — points 6 and 7 of the authorised requirement (Fase C).
 *
 * The two things worth pinning:
 *
 *  1. The combined export and the lead-time dashboard are two renderings of ONE row set, so they
 *     cannot drift the way the spreadsheet's "Reportes" and "Dashboard" tabs did.
 *  2. The dashboard's formulas run over timestamps this system already refuses to let anybody edit,
 *     and they answer `null` — never zero — for a shipment that has not got there yet. An average
 *     over invented zeros is how a KPI starts lying.
 */
const app = createApp();

let adminToken: string;
let autoridadToken: string;
let tramitadorToken: string;
let clientId: string;

beforeEach(async () => {
  await truncateAll();
  const hash = await hashPassword('p');
  const [adm, auto, tram] = await Promise.all([
    query<{ id: string }>(`INSERT INTO users (username,password_hash,role) VALUES ('r_adm',$1,'admin') RETURNING id`, [hash]),
    query<{ id: string }>(`INSERT INTO users (username,password_hash,role) VALUES ('r_auto',$1,'autoridad') RETURNING id`, [hash]),
    query<{ id: string }>(`INSERT INTO users (username,password_hash,role) VALUES ('r_tram',$1,'tramitador') RETURNING id`, [hash]),
  ]);
  adminToken = signToken({ userId: adm.rows[0].id, role: 'admin', tv: 0 });
  autoridadToken = signToken({ userId: auto.rows[0].id, role: 'autoridad', tv: 0 });
  tramitadorToken = signToken({ userId: tram.rows[0].id, role: 'tramitador', tv: 0 });

  const c = await query<{ id: string }>(`INSERT INTO clients (name) VALUES ('ACME') RETURNING id`);
  clientId = c.rows[0].id;
  const dir = await query<{ id: string }>(
    `INSERT INTO client_direcciones (client_id, alias) VALUES ($1,'IMILE Cuautitlán') RETURNING id`, [clientId]);
  const t = await query<{ id: string }>(
    `INSERT INTO transportistas (razon_social) VALUES ('Transportes del Bajío') RETURNING id`);

  // A shipment that walked the whole chain: landed 08:00, released 15:00, signed 22:10.
  const completa = await query<{ id: string }>(
    `INSERT INTO operaciones (mawb, mawb_raw, etapa, client_id, numero_vuelo, arribo_vuelo_at, disponible_at, semaforo, modulacion_at, salida_rojo_at)
     VALUES ('160-11111111','160-11111111','entregado',$1,'CX3186',
             '2026-08-14T08:00:00Z','2026-08-14T15:00:00Z','red','2026-08-14T18:20:00Z','2026-08-14T20:20:00Z')
     RETURNING id`,
    [clientId],
  );
  const guia = await query<{ id: string }>(
    `INSERT INTO operacion_guias (operacion_id, guia_norm, guia_raw, piezas, cartones, estado, client_id)
     VALUES ($1,'AAA0001','AAA-0001',2914,64,'liberada',$2) RETURNING id`,
    [completa.rows[0].id, clientId],
  );
  const d = await query<{ id: string }>(
    `INSERT INTO despachos (folio, fecha_operacion, tipo_unidad, transportista_id, direccion_entrega_id, estado,
                            cita_at, ingreso_patio_at, ingreso_aduana_at, inicio_carga_at, fin_carga_at,
                            salida_at, eta_calculado, arribo_real, tarifa_monto, moneda)
     VALUES ('D-20260814-001','2026-08-14','tracto',$1,$2,'entregado',
             '2026-08-14T16:00:00Z','2026-08-14T16:05:00Z','2026-08-14T16:35:00Z',
             '2026-08-14T17:00:00Z','2026-08-14T18:00:00Z','2026-08-14T20:30:00Z',
             '2026-08-14T21:30:00Z','2026-08-14T21:50:00Z', 8500, 'MXN')
     RETURNING id`,
    [t.rows[0].id, dir.rows[0].id],
  );
  await query(
    `INSERT INTO despacho_partidas (despacho_id, operacion_id, operacion_guia_id, cartones_cargados, piezas, orden_carga)
     VALUES ($1,$2,$3,64,2914,1)`,
    [d.rows[0].id, completa.rows[0].id, guia.rows[0].id],
  );
  await query(
    `INSERT INTO pods (despacho_id, folio, estado, firmado_por, firmado_at)
     VALUES ($1,'POD-D-20260814-001','firmado','Ing. Ramírez','2026-08-14T22:10:00Z')`,
    [d.rows[0].id],
  );

  // A shipment that landed and is still sitting in the warehouse: no truck, no POD.
  await query(
    `INSERT INTO operaciones (mawb, mawb_raw, etapa, client_id, arribo_vuelo_at)
     VALUES ('160-22222222','160-22222222','arribado',$1,'2026-08-15T09:00:00Z')`,
    [clientId],
  );
});

describe('GET /api/reportes/operativo — el export combinado (punto 6)', () => {
  it('trae una fila por guía, con la cadena completa hasta el POD', async () => {
    const r = await request(app)
      .get('/api/reportes/operativo')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(r.status).toBe(200);
    expect(r.body.total).toBe(2);
    const fila = r.body.filas.find((f: { mawb: string }) => f.mawb === '160-11111111');
    expect(fila).toMatchObject({
      guia: 'AAA0001',
      cliente: 'ACME',
      numeroVuelo: 'CX3186',
      despachoFolio: 'D-20260814-001',
      podEstado: 'firmado',
      // Never translated: the client reads it (D16).
      semaforo: 'red',
    });
  });

  it('NO esconde el caso que nunca tuvo camión — es justamente el que se busca', async () => {
    const r = await request(app)
      .get('/api/reportes/operativo')
      .set('Authorization', `Bearer ${adminToken}`);
    const parada = r.body.filas.find((f: { mawb: string }) => f.mawb === '160-22222222');
    expect(parada).toBeTruthy();
    expect(parada.despachoFolio).toBeNull();
    expect(parada.leadTimes.leadTimeMin).toBeNull();
  });

  it('filtra por fecha del arribo del vuelo y por cliente', async () => {
    const soloDia14 = await request(app)
      .get('/api/reportes/operativo?desde=2026-08-14&hasta=2026-08-14')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(soloDia14.body.total).toBe(1);

    const otro = await request(app)
      .get(`/api/reportes/operativo?clientId=${'00000000-0000-0000-0000-000000000000'}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(otro.body.total).toBe(0);
  });

  it('descarga el xlsx y audita el acceso ANTES de mandarlo', async () => {
    const r = await request(app)
      .get('/api/reportes/operativo.xlsx')
      .set('Authorization', `Bearer ${autoridadToken}`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/spreadsheetml/);

    const audit = await query<{ after: { filas: number; role: string } }>(
      `SELECT after FROM audit_log WHERE action = 'EXPORT_REPORTE_OPERATIVO'`);
    expect(audit.rows[0].after).toMatchObject({ filas: 2, role: 'autoridad' });
  });

  it('el tramitador no lee reportes: el rol con más exposición física carga la menor información', async () => {
    const r = await request(app)
      .get('/api/reportes/operativo')
      .set('Authorization', `Bearer ${tramitadorToken}`);
    expect(r.status).toBe(403);
  });
});

describe('GET /api/reportes/lead-times — el dashboard (punto 7)', () => {
  it('calcula almacén, despacho, tránsito, última milla y LT sobre timestamps inmutables', async () => {
    const r = await request(app)
      .get('/api/reportes/lead-times')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(r.status).toBe(200);
    const fila = r.body.filas.find((f: { mawb: string }) => f.mawb === '160-11111111');
    expect(fila).toMatchObject({
      almacenMin: 420,      // aterrizó 08:00 → almacén liberó 15:00 (las ~7 h de la reunión)
      despachoMin: 330,     // disponible → salió de la aduana
      transitoMin: 80,
      entregaMin: 20,
      ultimaMillaMin: 100,
      leadTimeMin: 850,
      demoraCitaMin: 5,     // R30 — cité 16:00, entró 16:05
      cargaMin: 60,
      tiempoEnRojoMin: 120, // R35
      desviacionArriboMin: 20, // D14 — llegó 20 min tarde contra el estimado
    });
  });

  it('el resumen dice el tamaño de la muestra junto al promedio', async () => {
    const r = await request(app)
      .get('/api/reportes/lead-times')
      .set('Authorization', `Bearer ${adminToken}`);

    // Only one of the two shipments has a lead time at all; the other is still in the warehouse.
    expect(r.body.resumen.leadTimeMin).toMatchObject({ muestras: 1, promedioMin: 850 });
    expect(r.body.resumen.transitoMin.muestras).toBe(1);
    // The one that has not started answers null and is excluded from the denominator, never zeroed.
    expect(r.body.resumen.almacenMin.muestras).toBe(1);
    expect(r.body.rulesetVersion).toBeTruthy();
  });

  it('descarga el xlsx de lead times', async () => {
    const r = await request(app)
      .get('/api/reportes/lead-times.xlsx')
      .set('Authorization', `Bearer ${autoridadToken}`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/spreadsheetml/);
    const audit = await query(`SELECT id FROM audit_log WHERE action = 'EXPORT_LEAD_TIMES'`);
    expect(audit.rows).toHaveLength(1);
  });

  it('las dos vistas leen exactamente el mismo conjunto de filas', async () => {
    const [operativo, leadTimes] = await Promise.all([
      request(app).get('/api/reportes/operativo').set('Authorization', `Bearer ${adminToken}`),
      request(app).get('/api/reportes/lead-times').set('Authorization', `Bearer ${adminToken}`),
    ]);
    expect(leadTimes.body.total).toBe(operativo.body.total);
    expect(leadTimes.body.filas.map((f: { mawb: string }) => f.mawb))
      .toEqual(operativo.body.filas.map((f: { mawb: string }) => f.mawb));
  });
});
