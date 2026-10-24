import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import * as XLSX from 'xlsx';
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

/**
 * ESTIMADO DE IMPUESTO EN EL EXPORT (junta del 15-sep).
 *
 * Las tres reglas que el cliente discutió a fondo, y que estas pruebas leen DEL XLSX REAL — no del
 * JSON — porque la columna del archivo es justamente lo que se le manda al cliente:
 *
 *  1. Sólo se estima lo que efectivamente va al pedimento: "no puedo calcular impuestos sobre algo
 *     que no puede pasar". Una guía sin pedimento no lleva número, lleva la razón.
 *  2. Se usa la tasa vigente EN LA FECHA DE LA OPERACIÓN, no la de hoy.
 *  3. Sin tasa configurada no se inventa un número.
 */
describe('Excel del reporte operativo — estimado de impuesto por guía', () => {
  const TASAS = [
    { startDate: '2026-01-01', originType: 'GENERAL', rate: 33.5 },
    { startDate: '2026-08-01', originType: 'GENERAL', rate: 50 },   // vigencia POSTERIOR al caso
    { startDate: '2026-01-01', originType: 'TMEC', rate: 0 },
  ];

  async function sembrar(opts: { conPedimento: boolean; pais?: string; vigencias?: unknown[] }) {
    const m = await query<{ id: string }>(
      `INSERT INTO manifests (mawb_reference) VALUES ('MAN-IMP-1') RETURNING id`);
    await query(
      `INSERT INTO shipments (id, manifest_id, data) VALUES (gen_random_uuid(), $1, $2::jsonb)`,
      [m.rows[0].id, JSON.stringify({
        guideId: 'AAA-0001',                       // se normaliza a AAA0001, la guía del caso completo
        customsValueUsd: 200,
        sender: { countryCode: opts.pais ?? 'CN' }, // CN ⇒ GENERAL
      })],
    );
    await query(`UPDATE operaciones SET manifest_id = $1 WHERE mawb = '160-11111111'`, [m.rows[0].id]);

    if (opts.conPedimento) {
      const ped = await query<{ id: string }>(
        `INSERT INTO pedimentos (manifest_id, numero_pedimento) VALUES ($1,'264351087104488') RETURNING id`,
        [m.rows[0].id]);
      await query(`UPDATE operacion_guias SET pedimento_id = $1 WHERE guia_norm = 'AAA0001'`, [ped.rows[0].id]);
    }
    if (opts.vigencias) {
      await query(
        `INSERT INTO config (key, value) VALUES ('tasa_vigencias', $1::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [JSON.stringify(opts.vigencias)]);
    }
  }

  /** Todas las filas del xlsx para una guía — el fan-out se prueba contando filas. */
  async function filasDelExcel(guia: string): Promise<Array<Record<string, unknown>>> {
    const res = await request(app)
      .get('/api/reportes/operativo.xlsx')
      .set('Authorization', `Bearer ${adminToken}`)
      .buffer(true)
      .parse((r, cb) => { const d: Buffer[] = []; r.on('data', (c) => d.push(c)); r.on('end', () => cb(null, Buffer.concat(d))); });
    expect(res.status).toBe(200);
    const wb = XLSX.read(res.body as Buffer, { type: 'buffer' });
    const filas = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[0]]);
    return filas.filter((f) => f['Guía'] === guia);
  }

  /** Descarga el xlsx y devuelve la fila de la guía AAA0001 como objeto. */
  async function filaDelExcel(): Promise<Record<string, unknown>> {
    const res = await request(app)
      .get('/api/reportes/operativo.xlsx')
      .set('Authorization', `Bearer ${adminToken}`)
      .buffer(true)
      .parse((r, cb) => { const d: Buffer[] = []; r.on('data', (c) => d.push(c)); r.on('end', () => cb(null, Buffer.concat(d))); });
    expect(res.status).toBe(200);
    const wb = XLSX.read(res.body as Buffer, { type: 'buffer' });
    const filas = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[0]]);
    return filas.find((f) => f['Guía'] === 'AAA0001') ?? {};
  }

  /**
   * DOBLE CONTEO POR FAN-OUT — el bug más caro de esta columna.
   *
   * Una fila del export es guía × partida de despacho × partida de factura. Cuando una guía tiene
   * dos conceptos facturados aparece dos veces, y el impuesto —que es propiedad de la guía— se
   * replicaría idéntico en ambas. Quien recibe el archivo selecciona la columna y suma: el total
   * saldría al doble, y parecería correcto.
   */
  it('escribe el impuesto UNA sola vez por guía, aunque la guía aparezca en varias filas', async () => {
    await sembrar({ conPedimento: true, vigencias: TASAS });

    // Segundo concepto facturado para la MISMA guía ⇒ una fila extra en el reporte.
    const g = await query<{ id: string; operacion_id: string }>(
      `SELECT id, operacion_id FROM operacion_guias WHERE guia_norm = 'AAA0001'`);
    const f = await query<{ id: string }>(
      `INSERT INTO facturas (folio, tipo, estado, periodo, moneda)
       VALUES ('F-1','cfdi','emitida','2026-08','MXN') RETURNING id`);
    await query(
      `INSERT INTO factura_partidas
         (factura_id, operacion_id, operacion_guia_id, concepto, unidad, cantidad, precio_unitario, importe)
       VALUES ($1,$2,$3,'Flete','guia',1,100,100),
              ($1,$2,$3,'Maniobras','guia',1,50,50)`,
      [f.rows[0].id, g.rows[0].operacion_id, g.rows[0].id]);

    const filas = await filasDelExcel('AAA0001');
    expect(filas.length).toBeGreaterThan(1);               // el fan-out existe de verdad

    const conImpuesto = filas.filter((x) => x['Impuesto estimado USD'] !== '');
    expect(conImpuesto).toHaveLength(1);                    // …y el número aparece una vez
    const repetidas = filas.filter((x) => x['Impuesto estimado USD'] === '');
    expect(repetidas.length).toBe(filas.length - 1);
    expect(repetidas[0]['Nota del estimado']).toMatch(/Ya contabilizado/i);

    // La suma de la columna —lo que hace quien abre el archivo— da el impuesto real, no un múltiplo.
    const suma = filas.reduce((acc, x) => acc + (Number(x['Impuesto estimado USD']) || 0), 0);
    expect(suma).toBe(100);
  });

  /**
   * EL ORIGEN NO SE AGREGA A LA BAJA.
   *
   * 'CA' precede alfabéticamente a casi todos los códigos ISO, así que agregar el país con MIN()
   * hacía que una guía con líneas de Canadá y de China se estimara ENTERA con la tasa TMEC. La regla
   * del módulo de tasas es la contraria: un dato dudoso nunca debe producir un estimado más barato,
   * porque subestimar le da al cliente una expectativa que la autoridad va a desmentir.
   */
  it('una guía con una sola línea fuera del T-MEC se estima como GENERAL', async () => {
    const m = await query<{ id: string }>(
      `INSERT INTO manifests (mawb_reference) VALUES ('MAN-MIX') RETURNING id`);
    // CA ordena antes que CN: con MIN() esto habría dado TMEC.
    for (const [pais, valor] of [['CA', 100], ['CN', 900]] as const) {
      await query(
        `INSERT INTO shipments (id, manifest_id, data) VALUES (gen_random_uuid(), $1, $2::jsonb)`,
        [m.rows[0].id, JSON.stringify({ guideId: 'AAA-0001', customsValueUsd: valor, sender: { countryCode: pais } })]);
    }
    const ped = await query<{ id: string }>(
      `INSERT INTO pedimentos (manifest_id, numero_pedimento) VALUES ($1,'264351087104500') RETURNING id`,
      [m.rows[0].id]);
    await query(`UPDATE operaciones SET manifest_id = $1 WHERE mawb = '160-11111111'`, [m.rows[0].id]);
    await query(`UPDATE operacion_guias SET pedimento_id = $1 WHERE guia_norm = 'AAA0001'`, [ped.rows[0].id]);
    await query(
      `INSERT INTO config (key, value) VALUES ('tasa_vigencias', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(TASAS)]);

    const fila = await filaDelExcel();
    expect(fila['Origen de la tasa']).toBe('GENERAL');
    expect(fila['Valor aduanal USD']).toBe(1000);           // suma las dos líneas
    expect(fila['Impuesto estimado USD']).toBe(500);        // 1000 × 50%, no la tasa TMEC
  });

  /**
   * UN PEDIMENTO SIN NÚMERO SIGUE SIENDO UN PEDIMENTO.
   *
   * `numero_pedimento` es nullable: un PDF escaneado ilegible produce un pedimento real, con guías
   * cubiertas, pero sin número capturado. Condicionar el estimado al número afirmaba "No va al
   * pedimento" sobre carga que sí se despacha — exactamente la mentira que la nota debe evitar.
   */
  it('estima la guía cuyo pedimento existe aunque su número aún no se haya capturado', async () => {
    const m = await query<{ id: string }>(
      `INSERT INTO manifests (mawb_reference) VALUES ('MAN-SINNUM') RETURNING id`);
    await query(
      `INSERT INTO shipments (id, manifest_id, data) VALUES (gen_random_uuid(), $1, $2::jsonb)`,
      [m.rows[0].id, JSON.stringify({ guideId: 'AAA-0001', customsValueUsd: 200, sender: { countryCode: 'CN' } })]);
    const ped = await query<{ id: string }>(
      `INSERT INTO pedimentos (manifest_id) VALUES ($1) RETURNING id`, [m.rows[0].id]);
    await query(`UPDATE operaciones SET manifest_id = $1 WHERE mawb = '160-11111111'`, [m.rows[0].id]);
    await query(`UPDATE operacion_guias SET pedimento_id = $1 WHERE guia_norm = 'AAA0001'`, [ped.rows[0].id]);
    await query(
      `INSERT INTO config (key, value) VALUES ('tasa_vigencias', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(TASAS)]);

    const fila = await filaDelExcel();
    expect(fila['Nota del estimado']).not.toMatch(/No va al pedimento/i);
    expect(fila['Impuesto estimado USD']).toBe(100);
  });

  /**
   * UN VALOR ADUANAL BASURA NO DEBE TUMBAR EL REPORTE.
   *
   * `shipments.data` es jsonb libre sin CHECK. Un `::numeric` desnudo sobre un string no numérico
   * aborta la consulta con 22P02 y el reporte COMPLETO responde 500 — una sola fila mala dejaría sin
   * archivo a todo el mundo. La guarda de tipo lo degrada a "sin valor aduanal", que es lo que el
   * resto del módulo ya hace ante un dato ausente.
   */
  it('degrada la celda en vez de tumbar el reporte cuando el valor aduanal no es numérico', async () => {
    const m = await query<{ id: string }>(
      `INSERT INTO manifests (mawb_reference) VALUES ('MAN-BASURA') RETURNING id`);
    await query(
      `INSERT INTO shipments (id, manifest_id, data) VALUES (gen_random_uuid(), $1, $2::jsonb)`,
      [m.rows[0].id, JSON.stringify({ guideId: 'AAA-0001', customsValueUsd: 'no-es-un-numero', sender: { countryCode: 'CN' } })]);
    const ped = await query<{ id: string }>(
      `INSERT INTO pedimentos (manifest_id, numero_pedimento) VALUES ($1,'264351087104511') RETURNING id`,
      [m.rows[0].id]);
    await query(`UPDATE operaciones SET manifest_id = $1 WHERE mawb = '160-11111111'`, [m.rows[0].id]);
    await query(`UPDATE operacion_guias SET pedimento_id = $1 WHERE guia_norm = 'AAA0001'`, [ped.rows[0].id]);

    const res = await request(app)
      .get('/api/reportes/operativo.xlsx')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);                            // no 500
    const fila = await filaDelExcel();
    expect(fila['Nota del estimado']).toBe('Sin valor aduanal en el manifiesto');
  });

  it('estima con la tasa vigente A LA FECHA DE LA OPERACIÓN, no con la más reciente', async () => {
    await sembrar({ conPedimento: true, vigencias: TASAS });
    const fila = await filaDelExcel();
    // El caso arribó el 2026-08-14, pero su manifiesto/operación se fecha por arribo_vuelo_at.
    // La vigencia aplicable es la de mayor startDate <= la fecha: 2026-08-01 ⇒ 50%.
    expect(fila['Valor aduanal USD']).toBe(200);
    expect(fila['Origen de la tasa']).toBe('GENERAL');
    expect(fila['Tasa aplicada %']).toBe(50);
    expect(fila['Impuesto estimado USD']).toBe(100);
    expect(fila['Nota del estimado']).toBe('');
  });

  it('clasifica el origen TMEC y aplica su tasa propia', async () => {
    await sembrar({ conPedimento: true, pais: 'US', vigencias: TASAS });
    const fila = await filaDelExcel();
    expect(fila['Origen de la tasa']).toBe('TMEC');
    expect(fila['Impuesto estimado USD']).toBe(0);
  });

  it('NO estima la guía que no va al pedimento, y dice por qué', async () => {
    await sembrar({ conPedimento: false, vigencias: TASAS });
    const fila = await filaDelExcel();
    expect(fila['Impuesto estimado USD']).toBe('');
    expect(fila['Nota del estimado']).toBe('No va al pedimento');
  });

  it('sin tabla de tasas no inventa un número: deja la nota en su lugar', async () => {
    await sembrar({ conPedimento: true });
    await query(`DELETE FROM config WHERE key = 'tasa_vigencias'`);
    const fila = await filaDelExcel();
    expect(fila['Valor aduanal USD']).toBe(200);     // el valor sí es un hecho del manifiesto
    expect(fila['Impuesto estimado USD']).toBe('');
    expect(fila['Nota del estimado']).toBe('Sin tabla de tasas configurada');
  });

  it('sin valor aduanal en el manifiesto lo dice, en vez de estimar cero', async () => {
    const m = await query<{ id: string }>(
      `INSERT INTO manifests (mawb_reference) VALUES ('MAN-IMP-2') RETURNING id`);
    const ped = await query<{ id: string }>(
      `INSERT INTO pedimentos (manifest_id, numero_pedimento) VALUES ($1,'264351087104499') RETURNING id`,
      [m.rows[0].id]);
    await query(`UPDATE operaciones SET manifest_id = $1 WHERE mawb = '160-11111111'`, [m.rows[0].id]);
    await query(`UPDATE operacion_guias SET pedimento_id = $1 WHERE guia_norm = 'AAA0001'`, [ped.rows[0].id]);
    await query(
      `INSERT INTO config (key, value) VALUES ('tasa_vigencias', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(TASAS)]);
    const fila = await filaDelExcel();
    expect(fila['Nota del estimado']).toBe('Sin valor aduanal en el manifiesto');
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
