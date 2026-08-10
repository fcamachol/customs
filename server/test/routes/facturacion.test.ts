import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { query } from '../../src/db/pool';
import { hashPassword } from '../../src/auth/password';
import { signToken } from '../../src/auth/token';
import { truncateAll } from '../helpers/db';
import { createApp } from '../../src/app';

/**
 * FINANCIAL TRACEABILITY — guía ↔ piezas ↔ factura (PRD-02 R43–R48, D17/D18).
 *
 * What each block pins, and why it is the thing that matters:
 *
 *  - ONLY A SIGNED POD BILLS (R39 → R43). A truck that left is not revenue. This is the single rule
 *    that keeps the invoice from ever running ahead of the operation, and it is why #30 preceded #32.
 *  - THE LINE, NOT THE TOTAL (R44). Every partida names its guía, its pieces and its price, so the
 *    authority's question is a join and not a PDF somebody reads out loud.
 *  - THE TARIFF COMPARISON SURVIVES (R45). The contracted price is snapshotted beside the charged
 *    one, so over- and under-charging are both visible afterwards.
 *  - NO DOUBLE BILLING. A guía already on a live invoice of the same type is reported, not priced
 *    again — and a cancelled invoice releases it.
 *  - FISCAL PII IS ENCRYPTED AND NEVER ENTERS THE HASH CHAIN, the same discipline #29 pinned for the
 *    carrier contacts.
 */
const app = createApp();

let adminToken: string;
let capturistaToken: string;
let autoridadToken: string;

let clientId: string;
let otroClientId: string;
let opA: string;
let opB: string;
let guiaA1: string;
let guiaB1: string;
let despachoId: string;
let tarifaId: string;

const PERIODO = '2026-08';
const FECHA = '2026-08-14';
const FIRMA = '2026-08-14T22:10:00Z';

/** The whole chain, seeded directly: catalogs → caso → guías → trip → load. */
async function seedCadena(): Promise<void> {
  const c = await query<{ id: string }>(`INSERT INTO clients (name) VALUES ('ACME') RETURNING id`);
  clientId = c.rows[0].id;
  const c2 = await query<{ id: string }>(`INSERT INTO clients (name) VALUES ('OTRO') RETURNING id`);
  otroClientId = c2.rows[0].id;

  const dir = await query<{ id: string }>(
    `INSERT INTO client_direcciones (client_id, alias) VALUES ($1,'IMILE Cuautitlán') RETURNING id`,
    [clientId],
  );
  const t = await query<{ id: string }>(
    `INSERT INTO transportistas (razon_social) VALUES ('Transportes del Bajío') RETURNING id`,
  );

  const ops = await query<{ id: string; mawb: string }>(
    `INSERT INTO operaciones (mawb, mawb_raw, etapa, client_id) VALUES
       ('160-11111111','160-11111111','entregado',$1),
       ('160-22222222','160-22222222','en_transito',$1)
     RETURNING id, mawb`,
    [clientId],
  );
  opA = ops.rows.find((r) => r.mawb === '160-11111111')!.id;
  opB = ops.rows.find((r) => r.mawb === '160-22222222')!.id;

  const guias = await query<{ id: string; guia_norm: string }>(
    `INSERT INTO operacion_guias (operacion_id, guia_norm, guia_raw, piezas, cartones, peso_kg, estado, client_id) VALUES
       ($1,'AAA0001','AAA-0001',2914,64,542.86,'liberada',$3),
       ($2,'BBB0001','BBB-0001',100,10,50,'liberada',$3)
     RETURNING id, guia_norm`,
    [opA, opB, clientId],
  );
  guiaA1 = guias.rows.find((r) => r.guia_norm === 'AAA0001')!.id;
  guiaB1 = guias.rows.find((r) => r.guia_norm === 'BBB0001')!.id;

  const d = await query<{ id: string }>(
    `INSERT INTO despachos (folio, fecha_operacion, tipo_unidad, transportista_id, direccion_entrega_id, estado)
     VALUES ('D-20260814-001',$1,'tracto',$2,$3,'entregado') RETURNING id`,
    [FECHA, t.rows[0].id, dir.rows[0].id],
  );
  despachoId = d.rows[0].id;
  await query(
    `INSERT INTO despacho_partidas (despacho_id, operacion_id, operacion_guia_id, cartones_cargados, piezas, orden_carga)
     VALUES ($1,$2,$3,64,2914,1), ($1,$4,$5,10,100,2)`,
    [despachoId, opA, guiaA1, opB, guiaB1],
  );
}

/** The delivery signature. Direct insert: the HTTP path for it is pinned in pods.test.ts. */
async function firmarPod(firmadoAt = FIRMA): Promise<void> {
  await query(
    `INSERT INTO pods (despacho_id, folio, estado, firmado_por, firmado_at)
     VALUES ($1,'POD-D-20260814-001','firmado','Ing. Ramírez',$2)`,
    [despachoId, firmadoAt],
  );
}

async function crearTarifa(precio = 0.05, unidad = 'pieza'): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO client_tarifas (client_id, concepto, unidad, precio, moneda)
     VALUES ($1,'Despacho aduanal T1 por pieza',$2,$3,'MXN') RETURNING id`,
    [clientId, unidad, precio],
  );
  return rows[0].id;
}

beforeEach(async () => {
  await truncateAll();
  const hash = await hashPassword('p');
  const [adm, cap, auto] = await Promise.all([
    query<{ id: string }>(`INSERT INTO users (username,password_hash,role) VALUES ('f_adm',$1,'admin') RETURNING id`, [hash]),
    query<{ id: string }>(`INSERT INTO users (username,password_hash,role) VALUES ('f_cap',$1,'capturista') RETURNING id`, [hash]),
    query<{ id: string }>(`INSERT INTO users (username,password_hash,role) VALUES ('f_auto',$1,'autoridad') RETURNING id`, [hash]),
  ]);
  adminToken = signToken({ userId: adm.rows[0].id, role: 'admin', tv: 0 });
  capturistaToken = signToken({ userId: cap.rows[0].id, role: 'capturista', tv: 0 });
  autoridadToken = signToken({ userId: auto.rows[0].id, role: 'autoridad', tv: 0 });
  await seedCadena();
  tarifaId = await crearTarifa();
});

// =================================================================================================
// Catálogo de tarifas — R46
// =================================================================================================

describe('tarifas del cliente (R46)', () => {
  it('las administra el admin y NADIE más: un precio no es dato operativo', async () => {
    const alta = await request(app)
      .post(`/api/catalogs/clients/${clientId}/tarifas`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ concepto: 'Maniobras', unidad: 'despacho', precio: 1200 });
    expect(alta.status).toBe(201);
    expect(alta.body.moneda).toBe('MXN');

    const cap = await request(app)
      .get(`/api/catalogs/clients/${clientId}/tarifas`)
      .set('Authorization', `Bearer ${capturistaToken}`);
    expect(cap.status).toBe(403);
  });

  it('rechaza un precio negativo', async () => {
    const r = await request(app)
      .post(`/api/catalogs/clients/${clientId}/tarifas`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ concepto: 'X', unidad: 'pieza', precio: -1 });
    expect(r.status).toBe(400);
  });

  it('DELETE desactiva, nunca borra: una partida histórica debe seguir diciendo bajo qué tarifa se cobró', async () => {
    const r = await request(app)
      .delete(`/api/catalogs/clients/${clientId}/tarifas/${tarifaId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(r.status).toBe(200);
    const fila = await query<{ activo: boolean }>('SELECT activo FROM client_tarifas WHERE id = $1', [tarifaId]);
    expect(fila.rows[0].activo).toBe(false);
  });
});

// =================================================================================================
// Preliquidación — R43 / R44 / R46
// =================================================================================================

describe('GET /api/facturacion/preliquidacion', () => {
  it('no cobra nada mientras el cliente no haya firmado el POD (R39 → R43)', async () => {
    const r = await request(app)
      .get(`/api/facturacion/preliquidacion?clientId=${clientId}&periodo=${PERIODO}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(r.status).toBe(200);
    expect(r.body.lineas).toHaveLength(0);
    expect(r.body.totales.subtotal).toBe(0);
    expect(r.body.criterioPeriodo).toMatch(/FIRMADO/);
  });

  it('cobra guía por guía, piezas × precio, en cuanto la entrega está firmada', async () => {
    await firmarPod();
    const r = await request(app)
      .get(`/api/facturacion/preliquidacion?clientId=${clientId}&periodo=${PERIODO}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(r.status).toBe(200);
    expect(r.body.lineas).toHaveLength(2);
    const a = r.body.lineas.find((l: { guiaNorm: string }) => l.guiaNorm === 'AAA0001');
    expect(a).toMatchObject({ cantidad: 2914, precioUnitario: 0.05, importe: 145.7, facturable: true });
    expect(a.podFolio).toBe('POD-D-20260814-001');
    // 2914 * 0.05 + 100 * 0.05
    expect(r.body.totales.subtotal).toBe(150.7);
    expect(r.body.totales.piezas).toBe(3014);
  });

  it('reporta la guía sin tarifa en vez de omitirla — una entrega que nadie factura es el error', async () => {
    await firmarPod();
    await query(`UPDATE client_tarifas SET activo = false WHERE id = $1`, [tarifaId]);
    const r = await request(app)
      .get(`/api/facturacion/preliquidacion?clientId=${clientId}&periodo=${PERIODO}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(r.body.lineas).toHaveLength(2);
    expect(r.body.totales.sinTarifa).toBe(2);
    expect(r.body.lineas[0].advertencia).toMatch(/no tiene tarifa vigente/);
  });

  it('deja fuera al cliente que no es', async () => {
    await firmarPod();
    const r = await request(app)
      .get(`/api/facturacion/preliquidacion?clientId=${otroClientId}&periodo=${PERIODO}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(r.body.lineas).toHaveLength(0);
  });

  it('el periodo es el mes de la ENTREGA, no el del vuelo', async () => {
    await firmarPod('2026-09-02T10:00:00Z');
    const agosto = await request(app)
      .get(`/api/facturacion/preliquidacion?clientId=${clientId}&periodo=2026-08`)
      .set('Authorization', `Bearer ${adminToken}`);
    const septiembre = await request(app)
      .get(`/api/facturacion/preliquidacion?clientId=${clientId}&periodo=2026-09`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(agosto.body.lineas).toHaveLength(0);
    expect(septiembre.body.lineas).toHaveLength(2);
  });
});

// =================================================================================================
// Facturas — R43 / R44 / R45 / R48
// =================================================================================================

describe('POST /api/facturacion/facturas', () => {
  it('arma la proforma desde la preliquidación, con una partida por guía', async () => {
    await firmarPod();
    const r = await request(app)
      .post('/api/facturacion/facturas')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId, tipo: 'proforma', periodo: PERIODO, folio: 'PF-001' });

    expect(r.status).toBe(201);
    expect(r.body.partidas).toBe(2);
    expect(Number(r.body.subtotal)).toBe(150.7);
    // Taxes belong to the CFDI, never to a number invented here (D18).
    expect(Number(r.body.total)).toBe(150.7);

    const detalle = await request(app)
      .get(`/api/facturacion/facturas/${r.body.id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    const linea = detalle.body.partidas.find((p: { guiaNorm: string }) => p.guiaNorm === 'AAA0001');
    expect(linea).toMatchObject({ mawb: '160-11111111', unidad: 'pieza' });
    expect(Number(linea.cantidad)).toBe(2914);
    expect(Number(linea.importe)).toBe(145.7);
    // R45: the contracted price travels beside the charged one, so the deviation is computable.
    expect(Number(linea.precioContratado)).toBe(0.05);
    expect(linea.desviacionTarifa).toBe(0);
    expect(linea.podFolio).toBe('POD-D-20260814-001');
  });

  it('escribe FACTURA_CREADA en la bitácora de cada caso cobrado', async () => {
    await firmarPod();
    await request(app)
      .post('/api/facturacion/facturas')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId, tipo: 'proforma', periodo: PERIODO });

    const ev = await query<{ operacion_id: string }>(
      `SELECT operacion_id FROM operacion_eventos WHERE tipo = 'FACTURA_CREADA'`);
    expect(new Set(ev.rows.map((r) => r.operacion_id))).toEqual(new Set([opA, opB]));
  });

  it('se niega a crear una factura vacía: un total sin nada detrás', async () => {
    const r = await request(app)
      .post('/api/facturacion/facturas')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId, tipo: 'proforma', periodo: PERIODO });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/sin partidas es un total sin nada detrás/);
  });

  it('no vuelve a cobrar lo ya facturado en el mismo tipo de documento', async () => {
    await firmarPod();
    await request(app)
      .post('/api/facturacion/facturas')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId, tipo: 'proforma', periodo: PERIODO });

    const pre = await request(app)
      .get(`/api/facturacion/preliquidacion?clientId=${clientId}&periodo=${PERIODO}&tipo=proforma`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(pre.body.totales.yaFacturadas).toBe(2);
    expect(pre.body.lineas.every((l: { facturable: boolean }) => !l.facturable)).toBe(true);

    const segunda = await request(app)
      .post('/api/facturacion/facturas')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId, tipo: 'proforma', periodo: PERIODO });
    expect(segunda.status).toBe(409);
  });

  it('la proforma no bloquea al CFDI que la sigue: son documentos distintos', async () => {
    await firmarPod();
    await request(app)
      .post('/api/facturacion/facturas')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId, tipo: 'proforma', periodo: PERIODO });

    const cfdi = await request(app)
      .post('/api/facturacion/facturas')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId, tipo: 'cfdi', periodo: PERIODO });
    expect(cfdi.status).toBe(201);
    expect(cfdi.body.partidas).toBe(2);
  });

  it('cifra el RFC del receptor en reposo y NUNCA lo mete en la cadena de auditoría', async () => {
    await firmarPod();
    const r = await request(app)
      .post('/api/facturacion/facturas')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId, tipo: 'cfdi', periodo: PERIODO, receptorRfc: 'ACM010101AAA', receptorCorreo: 'pagos@acme.mx' });
    expect(r.status).toBe(201);

    const fila = await query<{ receptor_rfc: string; receptor_correo: string; receptor_razon_social: string }>(
      'SELECT receptor_rfc, receptor_correo, receptor_razon_social FROM facturas WHERE id = $1', [r.body.id]);
    expect(fila.rows[0].receptor_rfc.startsWith('v1:')).toBe(true);
    expect(fila.rows[0].receptor_correo.startsWith('v1:')).toBe(true);
    // The razón social is NOT encrypted: it is already plaintext in `clients.name`, and encrypting
    // one copy of a value that is public in three others is theatre.
    expect(fila.rows[0].receptor_razon_social).toBe('ACME');

    const leida = await request(app)
      .get(`/api/facturacion/facturas/${r.body.id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(leida.body.receptorRfc).toBe('ACM010101AAA');

    const audit = await query<{ after: unknown }>(
      `SELECT after FROM audit_log WHERE action = 'FACTURA_CREADA'`);
    expect(JSON.stringify(audit.rows)).not.toContain('ACM010101AAA');
    expect(JSON.stringify(audit.rows)).not.toContain('pagos@acme.mx');
  });
});

describe('timbrado y cancelación (R48, D17)', () => {
  async function crearCfdi(): Promise<string> {
    await firmarPod();
    const r = await request(app)
      .post('/api/facturacion/facturas')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId, tipo: 'cfdi', periodo: PERIODO });
    return r.body.id as string;
  }

  it('liga el CFDI a las partidas y marca el timbrado como de PRUEBA por omisión', async () => {
    const id = await crearCfdi();
    const r = await request(app)
      .post(`/api/facturacion/facturas/${id}/timbrado`)
      .set('Authorization', `Bearer ${adminToken}`)
      .field('uuidCfdi', 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE')
      .attach('file', Buffer.from('<cfdi/>'), { filename: 'cfdi.xml', contentType: 'application/xml' });

    expect(r.status).toBe(201);
    expect(r.body.estado).toBe('timbrada');
    expect(r.body.timbradoPrueba).toBe(true);
    expect(r.body.advertencia).toMatch(/PRUEBA/);

    const ev = await query(`SELECT operacion_id FROM operacion_eventos WHERE tipo = 'FACTURA_LIGADA'`);
    expect(ev.rows).toHaveLength(2);
  });

  /**
   * THE ENDPOINT IS MULTIPART, SO EVERY FIELD ARRIVES AS A STRING.
   *
   * `timbradoPrueba` was a bare `z.boolean()`, which rejects the string `'false'` outright. The only
   * way to record a REAL fiscal stamp was therefore to send JSON with no file — i.e. the honest,
   * consequential claim was the one the form could not make, while the default (`prueba: true`)
   * sailed through. Same explicit string mapping as `campoEventoBody.override`, and for the same
   * reason: `z.coerce.boolean()` reads 'false' as true, which HERE would silently upgrade a test
   * stamp to a fiscal one on a form-encoded retry.
   */
  it("acepta timbradoPrueba='false' en multipart y registra un timbrado REAL", async () => {
    const id = await crearCfdi();
    const r = await request(app)
      .post(`/api/facturacion/facturas/${id}/timbrado`)
      .set('Authorization', `Bearer ${adminToken}`)
      .field('uuidCfdi', 'REAL-0001-0002-0003-000000000004')
      .field('timbradoPrueba', 'false')
      .attach('file', Buffer.from('<cfdi/>'), { filename: 'cfdi.xml', contentType: 'application/xml' });

    expect(r.status).toBe(201);
    expect(r.body.timbradoPrueba).toBe(false);
    // No "this was only a test" warning on a stamp that claims to be fiscal.
    expect(r.body.advertencia).toBeNull();

    const fila = await query<{ timbrado_prueba: boolean }>(
      'SELECT timbrado_prueba FROM facturas WHERE id = $1', [id]);
    expect(fila.rows[0].timbrado_prueba).toBe(false);
  });

  it("acepta timbradoPrueba='true' en multipart sin convertirlo en otra cosa", async () => {
    const id = await crearCfdi();
    const r = await request(app)
      .post(`/api/facturacion/facturas/${id}/timbrado`)
      .set('Authorization', `Bearer ${adminToken}`)
      .field('uuidCfdi', 'PRUEBA-0001')
      .field('timbradoPrueba', 'true')
      .attach('file', Buffer.from('<cfdi/>'), { filename: 'cfdi.xml', contentType: 'application/xml' });
    expect(r.status).toBe(201);
    expect(r.body.timbradoPrueba).toBe(true);
    expect(r.body.advertencia).toMatch(/PRUEBA/);
  });

  it('rechaza un timbradoPrueba que no es booleano en lugar de adivinar', async () => {
    const id = await crearCfdi();
    const r = await request(app)
      .post(`/api/facturacion/facturas/${id}/timbrado`)
      .set('Authorization', `Bearer ${adminToken}`)
      .field('uuidCfdi', 'AMBIGUO-0001')
      .field('timbradoPrueba', 'quizá');
    expect(r.status).toBe(400);
    const fila = await query<{ estado: string }>('SELECT estado FROM facturas WHERE id = $1', [id]);
    expect(fila.rows[0].estado).not.toBe('timbrada');
  });

  it('no admite un segundo UUID sobre el mismo documento', async () => {
    const id = await crearCfdi();
    await request(app)
      .post(`/api/facturacion/facturas/${id}/timbrado`)
      .set('Authorization', `Bearer ${adminToken}`)
      .field('uuidCfdi', 'UUID-1');
    const r = await request(app)
      .post(`/api/facturacion/facturas/${id}/timbrado`)
      .set('Authorization', `Bearer ${adminToken}`)
      .field('uuidCfdi', 'UUID-2');
    expect(r.status).toBe(409);
  });

  it('cancela con motivo y devuelve las guías a la preliquidación', async () => {
    const id = await crearCfdi();
    const r = await request(app)
      .post(`/api/facturacion/facturas/${id}/cancelar`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ motivo: 'Error en el folio fiscal' });
    expect(r.status).toBe(200);

    const pre = await request(app)
      .get(`/api/facturacion/preliquidacion?clientId=${clientId}&periodo=${PERIODO}&tipo=cfdi`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(pre.body.totales.facturables).toBe(2);
  });

  it('una factura TIMBRADA se puede cancelar y conserva su UUID: el CFDI existió', async () => {
    const id = await crearCfdi();
    await request(app)
      .post(`/api/facturacion/facturas/${id}/timbrado`)
      .set('Authorization', `Bearer ${adminToken}`)
      .field('uuidCfdi', 'UUID-CANCELABLE');

    const r = await request(app)
      .post(`/api/facturacion/facturas/${id}/cancelar`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ motivo: 'Solicitud del cliente' });
    expect(r.status).toBe(200);

    const fila = await query<{ estado: string; uuid_cfdi: string }>(
      'SELECT estado, uuid_cfdi FROM facturas WHERE id = $1', [id]);
    expect(fila.rows[0].estado).toBe('cancelada');
    // Forcing the uuid to null would erase the identifier the SAT and the client both still hold.
    expect(fila.rows[0].uuid_cfdi).toBe('UUID-CANCELABLE');
  });

  it('exige motivo para cancelar', async () => {
    const id = await crearCfdi();
    const r = await request(app)
      .post(`/api/facturacion/facturas/${id}/cancelar`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(r.status).toBe(400);
  });

  it('sólo deja declarar los estados que no requieren prueba', async () => {
    const id = await crearCfdi();
    const ok = await request(app)
      .post(`/api/facturacion/facturas/${id}/estado`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ estado: 'emitida' });
    expect(ok.status).toBe(200);

    const no = await request(app)
      .post(`/api/facturacion/facturas/${id}/estado`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ estado: 'timbrada' });
    expect(no.status).toBe(400);
  });
});

// =================================================================================================
// Trazabilidad y reporte mensual — R43 / R44
// =================================================================================================

describe('trazabilidad y reporte mensual', () => {
  async function facturar(): Promise<void> {
    await firmarPod();
    await request(app)
      .post('/api/facturacion/facturas')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId, tipo: 'proforma', periodo: PERIODO, folio: 'PF-001' });
  }

  it('responde la cadena completa preguntando por el número escrito en el papel', async () => {
    await facturar();
    const r = await request(app)
      .get('/api/facturacion/trazabilidad?guia=AAA0001')
      .set('Authorization', `Bearer ${autoridadToken}`);

    expect(r.status).toBe(200);
    expect(r.body.encontrado).toBe(true);
    const fila = r.body.filas[0];
    expect(fila).toMatchObject({
      mawb: '160-11111111',
      guia: 'AAA0001',
      despachoFolio: 'D-20260814-001',
      podEstado: 'firmado',
      facturaFolio: 'PF-001',
    });
    expect(Number(fila.importe)).toBe(145.7);
  });

  it('dice que no encontró, en vez de devolver una lista vacía sin explicación', async () => {
    const r = await request(app)
      .get('/api/facturacion/trazabilidad?guia=NOEXISTE')
      .set('Authorization', `Bearer ${autoridadToken}`);
    expect(r.body.encontrado).toBe(false);
  });

  it('exige un criterio de búsqueda', async () => {
    const r = await request(app)
      .get('/api/facturacion/trazabilidad')
      .set('Authorization', `Bearer ${autoridadToken}`);
    expect(r.status).toBe(400);
  });

  it('entrega el reporte mensual como xlsx y lo audita antes de mandarlo', async () => {
    await facturar();
    const r = await request(app)
      .get(`/api/facturacion/reporte-mensual.xlsx?clientId=${clientId}&periodo=${PERIODO}`)
      .set('Authorization', `Bearer ${autoridadToken}`);

    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/spreadsheetml/);

    const audit = await query<{ after: { partidas: number } }>(
      `SELECT after FROM audit_log WHERE action = 'EXPORT_REPORTE_MENSUAL'`);
    expect(audit.rows[0].after.partidas).toBe(2);
  });

  it('un mes sin facturación es una respuesta, no un 404', async () => {
    const r = await request(app)
      .get(`/api/facturacion/reporte-mensual.xlsx?periodo=2026-01`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(r.status).toBe(200);
  });

  it('el capturista no entra a facturación: su trabajo es la carga, no la contraparte', async () => {
    const r = await request(app)
      .get(`/api/facturacion/preliquidacion?clientId=${clientId}&periodo=${PERIODO}`)
      .set('Authorization', `Bearer ${capturistaToken}`);
    expect(r.status).toBe(403);
  });
});
