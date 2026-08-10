import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { query } from '../../src/db/pool';
import { hashPassword } from '../../src/auth/password';
import { signToken } from '../../src/auth/token';
import { truncateAll } from '../helpers/db';
import { createApp } from '../../src/app';

/**
 * TRANSPORT CATALOGS — carriers, fleet, agreements, rates (PRD-02 R24, R25/D9).
 *
 * What these tests defend:
 *
 *  - the catalog is ADMIN-only to write. Every row here decides who the operation may spend money
 *    with and at what price; a capturista's job is cargo, not counterparties.
 *  - a convenio can only reach `firmado` through /firmar, WITH a provider and a reference (D9).
 *    Any other path would make "signed" a word somebody typed, and every rate inside the agreement
 *    would then rest on that word.
 *  - `vigente` and `unidadesActivas` are questions about TODAY, computed, never stored flags — an
 *    expired agreement must stop being an agreement without anyone editing a row.
 *  - contact details are ENCRYPTED at rest and never copied into the permanent audit chain.
 *  - the RFC and the plates are normalized, because two rows for one carrier split its trip history
 *    in half and that is what makes "who did we send that load with?" unanswerable.
 */
const app = createApp();

let adminToken: string;
let capturistaToken: string;
let autoridadToken: string;
let clientId: string;

beforeEach(async () => {
  await truncateAll();
  const hash = await hashPassword('p');
  const [adm, cap, auto] = await Promise.all([
    query<{ id: string }>(`INSERT INTO users (username,password_hash,role) VALUES ('t_adm',$1,'admin') RETURNING id`, [hash]),
    query<{ id: string }>(`INSERT INTO users (username,password_hash,role) VALUES ('t_cap',$1,'capturista') RETURNING id`, [hash]),
    query<{ id: string }>(`INSERT INTO users (username,password_hash,role) VALUES ('t_auto',$1,'autoridad') RETURNING id`, [hash]),
  ]);
  adminToken = signToken({ userId: adm.rows[0].id, role: 'admin', tv: 0 });
  capturistaToken = signToken({ userId: cap.rows[0].id, role: 'capturista', tv: 0 });
  autoridadToken = signToken({ userId: auto.rows[0].id, role: 'autoridad', tv: 0 });

  const c = await query<{ id: string }>(`INSERT INTO clients (name) VALUES ('ACME') RETURNING id`);
  clientId = c.rows[0].id;
});

function crearTransportista(body: Record<string, unknown>, token = adminToken) {
  return request(app).post('/api/transportistas').set('Authorization', `Bearer ${token}`).send(body);
}

describe('role gates', () => {
  it('only admin writes the carrier catalog', async () => {
    await crearTransportista({ razonSocial: 'X' }, capturistaToken).expect(403);
    await crearTransportista({ razonSocial: 'X' }, autoridadToken).expect(403);
    await crearTransportista({ razonSocial: 'Transportes del Bajío' }, adminToken).expect(201);
  });

  it('any authenticated role may read it — the board has to name the carrier a trip went out with', async () => {
    await crearTransportista({ razonSocial: 'Transportes del Bajío' }).expect(201);
    const res = await request(app)
      .get('/api/transportistas')
      .set('Authorization', `Bearer ${autoridadToken}`)
      .expect(200);
    expect(res.body).toHaveLength(1);
    await request(app).get('/api/transportistas').expect(401);
  });

  it('the unit-type glossary is served from the shared catalog, to any authenticated role', async () => {
    const res = await request(app)
      .get('/api/transportistas/tipos-unidad')
      .set('Authorization', `Bearer ${capturistaToken}`)
      .expect(200);
    expect(res.body.map((t: { id: string }) => t.id)).toEqual([
      'tracto', 'torton', 'rabon', 't3_5', 'silverado', 'cargo_van',
    ]);
  });

  it("the literal 'tipos-unidad' is never captured as a transportista id", async () => {
    // Registered before /:id, and /:id validates a uuid — belt and braces, same as the holds router.
    await request(app)
      .get('/api/transportistas/no-un-uuid')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
  });
});

describe('transportistas', () => {
  it('normalizes the RFC and refuses a duplicate with a 409, not a 500', async () => {
    await crearTransportista({ razonSocial: 'Uno', rfc: 'abc010101aaa' }).expect(201);
    const dup = await crearTransportista({ razonSocial: 'Otro nombre', rfc: 'ABC010101AAA' }).expect(409);
    expect(dup.body.error).toContain('RFC');

    const { rows } = await query<{ rfc: string }>('SELECT rfc FROM transportistas');
    expect(rows).toHaveLength(1);
    expect(rows[0].rfc).toBe('ABC010101AAA');
  });

  it('encrypts contact details at rest and returns them decrypted', async () => {
    const creado = await crearTransportista({
      razonSocial: 'Transportes del Bajío',
      contactoNombre: 'Luis Ramírez',
      contactoTelefono: '5512345678',
      contactoEmail: 'trafico@bajio.mx',
    }).expect(201);
    expect(creado.body.contactoTelefono).toBe('5512345678');
    expect(creado.body.contactoEmail).toBe('trafico@bajio.mx');

    const { rows } = await query<{ contacto_telefono: string; contacto_email: string }>(
      'SELECT contacto_telefono, contacto_email FROM transportistas',
    );
    expect(rows[0].contacto_telefono.startsWith('v1:')).toBe(true);
    expect(rows[0].contacto_telefono).not.toContain('5512345678');
    expect(rows[0].contacto_email.startsWith('v1:')).toBe(true);
  });

  it('keeps the personal data out of the permanent audit chain', async () => {
    await crearTransportista({
      razonSocial: 'Transportes del Bajío',
      contactoTelefono: '5512345678',
    }).expect(201);
    const { rows } = await query<{ after: Record<string, unknown> }>(
      `SELECT after FROM audit_log WHERE action = 'TRANSPORTISTA_CREADO'`,
    );
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0].after)).not.toContain('5512345678');
    expect(rows[0].after.razonSocial).toBe('Transportes del Bajío');
  });

  it('reports readiness as questions about today, not as stored flags', async () => {
    const t = await crearTransportista({ razonSocial: 'Transportes del Bajío' }).expect(201);
    const id = t.body.id as string;

    let lista = await request(app).get('/api/transportistas').set('Authorization', `Bearer ${adminToken}`).expect(200);
    expect(lista.body[0].unidadesActivas).toBe(0);
    expect(lista.body[0].convenioVigente).toBe(false);

    await request(app)
      .post(`/api/transportistas/${id}/unidades`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ placas: 'abc-12-34', tipoUnidad: 'tracto' })
      .expect(201);

    // An expired signed agreement is NOT an agreement.
    await query(
      `INSERT INTO transportista_convenios (transportista_id, estado_firma, firmado_at, vigencia_hasta)
       VALUES ($1,'firmado', now(), current_date - 1)`,
      [id],
    );
    lista = await request(app).get('/api/transportistas').set('Authorization', `Bearer ${adminToken}`).expect(200);
    expect(lista.body[0].unidadesActivas).toBe(1);
    expect(lista.body[0].convenioVigente).toBe(false);

    await query(
      `INSERT INTO transportista_convenios (transportista_id, estado_firma, firmado_at, vigencia_hasta)
       VALUES ($1,'firmado', now(), current_date + 30)`,
      [id],
    );
    lista = await request(app).get('/api/transportistas').set('Authorization', `Bearer ${adminToken}`).expect(200);
    expect(lista.body[0].convenioVigente).toBe(true);
  });
});

describe('unidades — the fleet', () => {
  let transportistaId: string;
  beforeEach(async () => {
    const t = await crearTransportista({ razonSocial: 'Transportes del Bajío' }).expect(201);
    transportistaId = t.body.id;
  });

  function crearUnidad(body: Record<string, unknown>) {
    return request(app)
      .post(`/api/transportistas/${transportistaId}/unidades`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send(body);
  }

  it('normalizes plates so one vehicle cannot register twice', async () => {
    const u = await crearUnidad({ placas: 'abc-12-34', tipoUnidad: 'tracto' }).expect(201);
    expect(u.body.placas).toBe('ABC1234');
    await crearUnidad({ placas: 'ABC 1234', tipoUnidad: 'torton' }).expect(409);
  });

  it('rejects a unit type outside the glossary', async () => {
    await crearUnidad({ placas: 'AAA1111', tipoUnidad: 'trailer' }).expect(400);
  });

  it('deactivates rather than deletes, so old trips keep pointing at a real vehicle', async () => {
    const u = await crearUnidad({ placas: 'AAA1111', tipoUnidad: 'tracto' }).expect(201);
    await request(app)
      .delete(`/api/transportistas/${transportistaId}/unidades/${u.body.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const { rows } = await query<{ activo: boolean }>('SELECT activo FROM transportista_unidades WHERE id = $1', [u.body.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].activo).toBe(false);
  });

  it('reports expiry as a computed fact about today', async () => {
    await crearUnidad({
      placas: 'AAA1111',
      tipoUnidad: 'tracto',
      vigenciaSeguro: '2020-01-01',
      vigenciaVerificacion: '2099-01-01',
    }).expect(201);
    const res = await request(app)
      .get(`/api/transportistas/${transportistaId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(res.body.unidades[0].seguroVencido).toBe(true);
    expect(res.body.unidades[0].verificacionVencida).toBe(false);
  });
});

describe('convenios y tarifas — R25 / D9', () => {
  let transportistaId: string;
  let convenioId: string;

  beforeEach(async () => {
    const t = await crearTransportista({ razonSocial: 'Transportes del Bajío' }).expect(201);
    transportistaId = t.body.id;
    const c = await request(app)
      .post(`/api/transportistas/${transportistaId}/convenios`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ vigenciaDesde: '2026-01-01', vigenciaHasta: '2026-12-31' })
      .expect(201);
    convenioId = c.body.id;
  });

  it('starts as a draft and cannot declare itself signed on creation', async () => {
    expect((await query<{ estado_firma: string }>('SELECT estado_firma FROM transportista_convenios')).rows[0].estado_firma)
      .toBe('borrador');
    await request(app)
      .post(`/api/transportistas/${transportistaId}/convenios`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ estadoFirma: 'firmado' })
      .expect(400);
  });

  it('only reaches firmado through /firmar, and only with a provider and a reference', async () => {
    await request(app)
      .post(`/api/transportistas/${transportistaId}/convenios/${convenioId}/firmar`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ firmaProveedor: 'Cincel' })
      .expect(400);

    const firmado = await request(app)
      .post(`/api/transportistas/${transportistaId}/convenios/${convenioId}/firmar`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ firmaProveedor: 'Cincel', firmaReferencia: 'NOM151-2026-0001' })
      .expect(200);
    expect(firmado.body.estadoFirma).toBe('firmado');
    expect(firmado.body.firmadoAt).toBeTruthy();
    expect(firmado.body.firmaReferencia).toBe('NOM151-2026-0001');
  });

  it('refuses to re-sign, which would move the date the agreement took effect', async () => {
    await request(app)
      .post(`/api/transportistas/${transportistaId}/convenios/${convenioId}/firmar`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ firmaProveedor: 'Cincel', firmaReferencia: 'REF-1' })
      .expect(200);
    const dup = await request(app)
      .post(`/api/transportistas/${transportistaId}/convenios/${convenioId}/firmar`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ firmaProveedor: 'Cincel', firmaReferencia: 'REF-2' })
      .expect(409);
    expect(dup.body.estadoFirma).toBe('firmado');
  });

  it('stores rates inside the agreement, typed by unit — D7 made structural', async () => {
    const tarifa = await request(app)
      .post(`/api/transportistas/${transportistaId}/convenios/${convenioId}/tarifas`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ tipoUnidad: 'tracto', tarifa: 8500 })
      .expect(201);
    expect(tarifa.body.tipoUnidad).toBe('tracto');
    expect(tarifa.body.moneda).toBe('MXN');

    // A rate with no unit type could never be found by the D7 options query.
    await request(app)
      .post(`/api/transportistas/${transportistaId}/convenios/${convenioId}/tarifas`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ tarifa: 8500 })
      .expect(400);
  });

  it('rejects a negative rate and a destination that does not exist', async () => {
    await request(app)
      .post(`/api/transportistas/${transportistaId}/convenios/${convenioId}/tarifas`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ tipoUnidad: 'tracto', tarifa: -1 })
      .expect(400);
    const res = await request(app)
      .post(`/api/transportistas/${transportistaId}/convenios/${convenioId}/tarifas`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ tipoUnidad: 'tracto', tarifa: 100, direccionEntregaId: '11111111-1111-4111-8111-111111111111' })
      .expect(400);
    expect(res.body.error).toContain('direccionEntregaId');
  });

  it('surfaces the agreement with its rates and a computed `vigente`', async () => {
    await request(app)
      .post(`/api/transportistas/${transportistaId}/convenios/${convenioId}/tarifas`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ tipoUnidad: 'tracto', tarifa: 8500 })
      .expect(201);
    await request(app)
      .post(`/api/transportistas/${transportistaId}/convenios/${convenioId}/firmar`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ firmaProveedor: 'Cincel', firmaReferencia: 'REF-1' })
      .expect(200);

    const res = await request(app)
      .get(`/api/transportistas/${transportistaId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(res.body.convenios).toHaveLength(1);
    expect(res.body.convenios[0].vigente).toBe(true);
    expect(res.body.convenios[0].tarifas).toHaveLength(1);
    expect(Number(res.body.convenios[0].tarifas[0].tarifa)).toBe(8500);
  });

  it('404s for a convenio that belongs to another carrier', async () => {
    const otro = await crearTransportista({ razonSocial: 'Fletes del Norte' }).expect(201);
    await request(app)
      .post(`/api/transportistas/${otro.body.id}/convenios/${convenioId}/tarifas`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ tipoUnidad: 'tracto', tarifa: 100 })
      .expect(404);
  });
});

describe('direcciones de entrega — R38 / D15', () => {
  it('are unique per client by alias, because the plan names the destination by that string', async () => {
    await request(app)
      .post(`/api/catalogs/clients/${clientId}/direcciones`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ alias: 'IMILE Cuautitlán', ciudad: 'Cuautitlán', lat: 19.6697, lng: -99.1817 })
      .expect(201);
    await request(app)
      .post(`/api/catalogs/clients/${clientId}/direcciones`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ alias: 'IMILE Cuautitlán' })
      .expect(409);
  });

  it('encrypt their contact fields at rest', async () => {
    const d = await request(app)
      .post(`/api/catalogs/clients/${clientId}/direcciones`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ alias: 'Bodega 3', contactoNombre: 'Ana Torres', contactoTelefono: '5599887766' })
      .expect(201);
    expect(d.body.contactoNombre).toBe('Ana Torres');
    const { rows } = await query<{ contacto_nombre: string }>('SELECT contacto_nombre FROM client_direcciones');
    expect(rows[0].contacto_nombre.startsWith('v1:')).toBe(true);
  });

  it('reject an out-of-range coordinate here rather than inside the estimator', async () => {
    await request(app)
      .post(`/api/catalogs/clients/${clientId}/direcciones`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ alias: 'Mala', lat: 120, lng: -99 })
      .expect(400);
  });

  it('are deactivated, never deleted — despachos and published plans name them', async () => {
    const d = await request(app)
      .post(`/api/catalogs/clients/${clientId}/direcciones`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ alias: 'Bodega 3' })
      .expect(201);
    await request(app)
      .delete(`/api/catalogs/clients/${clientId}/direcciones/${d.body.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const { rows } = await query<{ activo: boolean }>('SELECT activo FROM client_direcciones WHERE id = $1', [d.body.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].activo).toBe(false);
  });
});

/**
 * THE THREE GAPS the Transportistas screen surfaced, and what each fix has to keep true.
 *
 *  1. A rate's destination arrives NAMED. It used to come back as a bare uuid, so a screen had to ask
 *     every client for its address list and search the union to print one label.
 *  2. A rate can be CORRECTED and RETIRED. Superseding was the only remedy, and since the resolver
 *     breaks ties by the lowest price, a correction upwards could never take effect. A retired rate
 *     must never resolve again — and must still be there, because past despachos point at it.
 *  3. A convenio can be edited BEFORE signature and never after. A signed convenio is a document;
 *     extending it is a successor, not an edit.
 */
describe('gap 1 — el catálogo de destinos y la etiqueta de la tarifa', () => {
  let transportistaId: string;
  let convenioId: string;
  let direccionId: string;

  beforeEach(async () => {
    const t = await crearTransportista({ razonSocial: 'Transportes del Bajío' }).expect(201);
    transportistaId = t.body.id;
    const c = await request(app)
      .post(`/api/transportistas/${transportistaId}/convenios`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ vigenciaDesde: '2026-01-01', vigenciaHasta: '2026-12-31' })
      .expect(201);
    convenioId = c.body.id;
    const d = await request(app)
      .post(`/api/catalogs/clients/${clientId}/direcciones`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ alias: 'IMILE Cuautitlán', ciudad: 'Cuautitlán', contactoNombre: 'Ana Torres', contactoTelefono: '5599887766' })
      .expect(201);
    direccionId = d.body.id;
  });

  it('names the destination on the rate, so nobody has to fan out over every client to read it', async () => {
    await request(app)
      .post(`/api/transportistas/${transportistaId}/convenios/${convenioId}/tarifas`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ tipoUnidad: 'tracto', tarifa: 9200, direccionEntregaId: direccionId })
      .expect(201);
    await request(app)
      .post(`/api/transportistas/${transportistaId}/convenios/${convenioId}/tarifas`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ tipoUnidad: 'torton', tarifa: 6100 })
      .expect(201);

    const res = await request(app)
      .get(`/api/transportistas/${transportistaId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const tarifas = res.body.convenios[0].tarifas as Array<Record<string, unknown>>;
    const especifica = tarifas.find((t) => t.direccionEntregaId === direccionId)!;
    expect(especifica.destinoAlias).toBe('IMILE Cuautitlán');
    expect(especifica.clienteNombre).toBe('ACME');
    // A general rate has no destination at all, and must not invent one.
    const general = tarifas.find((t) => t.direccionEntregaId === null)!;
    expect(general.destinoAlias).toBeNull();
    expect(general.clienteNombre).toBeNull();
  });

  it('serves the flat destination catalog to any authenticated role, without the personal data', async () => {
    const res = await request(app)
      .get('/api/catalogs/direcciones')
      .set('Authorization', `Bearer ${autoridadToken}`)
      .expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ alias: 'IMILE Cuautitlán', cliente: 'ACME', clientId, activo: true });
    // A picker needs an id and a label; the warehouse contact is personal data and never leaves.
    expect(JSON.stringify(res.body)).not.toContain('Ana Torres');
    expect(JSON.stringify(res.body)).not.toContain('5599887766');
    await request(app).get('/api/catalogs/direcciones').expect(401);
  });

  it('keeps listing a deactivated destination, flagged — a rate already points at it', async () => {
    await request(app)
      .delete(`/api/catalogs/clients/${clientId}/direcciones/${direccionId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const res = await request(app)
      .get('/api/catalogs/direcciones')
      .set('Authorization', `Bearer ${capturistaToken}`)
      .expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].activo).toBe(false);
  });
});

describe('gap 2 — corregir y retirar una tarifa (R25 / D9)', () => {
  let transportistaId: string;
  let convenioId: string;
  let tarifaId: string;

  const FECHA = '2026-06-15';

  async function firmar(cid = convenioId) {
    await request(app)
      .post(`/api/transportistas/${transportistaId}/convenios/${cid}/firmar`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ firmaProveedor: 'Cincel', firmaReferencia: 'NOM151-1' })
      .expect(200);
  }

  /** The D7 options endpoint IS the resolver's shape: same convenio/vigencia/activo filter. */
  function opciones() {
    return request(app)
      .get(`/api/despachos/opciones?tipoUnidad=tracto&fecha=${FECHA}`)
      .set('Authorization', `Bearer ${adminToken}`);
  }

  beforeEach(async () => {
    const t = await crearTransportista({ razonSocial: 'Transportes del Bajío' }).expect(201);
    transportistaId = t.body.id;
    await request(app)
      .post(`/api/transportistas/${transportistaId}/unidades`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ placas: 'ABC1234', tipoUnidad: 'tracto' })
      .expect(201);
    const c = await request(app)
      .post(`/api/transportistas/${transportistaId}/convenios`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ vigenciaDesde: '2026-01-01', vigenciaHasta: '2026-12-31' })
      .expect(201);
    convenioId = c.body.id;
    const tf = await request(app)
      .post(`/api/transportistas/${transportistaId}/convenios/${convenioId}/tarifas`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ tipoUnidad: 'tracto', tarifa: 8500 })
      .expect(201);
    tarifaId = tf.body.id;
  });

  it('is admin territory to correct or retire, like every other write in this catalog', async () => {
    for (const token of [capturistaToken, autoridadToken]) {
      await request(app)
        .put(`/api/transportistas/${transportistaId}/convenios/${convenioId}/tarifas/${tarifaId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ tarifa: 1 })
        .expect(403);
      await request(app)
        .delete(`/api/transportistas/${transportistaId}/convenios/${convenioId}/tarifas/${tarifaId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    }
  });

  it('corrects the rate UPWARDS — the case superseding could never fix', async () => {
    await firmar();
    let res = await opciones().expect(200);
    expect(Number(res.body.opciones[0].tarifa)).toBe(8500);

    const upd = await request(app)
      .put(`/api/transportistas/${transportistaId}/convenios/${convenioId}/tarifas/${tarifaId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ tarifa: 9800 })
      .expect(200);
    expect(Number(upd.body.tarifa)).toBe(9800);

    // A second, cheaper row would have kept winning the tiebreak; correcting the row reaches the resolver.
    res = await opciones().expect(200);
    expect(Number(res.body.opciones[0].tarifa)).toBe(9800);
    expect(res.body.opciones[0].tarifaId).toBe(tarifaId);
  });

  it('audits the correction with BEFORE and AFTER, because this is money', async () => {
    await request(app)
      .put(`/api/transportistas/${transportistaId}/convenios/${convenioId}/tarifas/${tarifaId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ tarifa: 9800 })
      .expect(200);
    const { rows } = await query<{ before: Record<string, unknown>; after: Record<string, unknown> }>(
      `SELECT before, after FROM audit_log WHERE action = 'TARIFA_ACTUALIZADA'`,
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].before.tarifa)).toBe(8500);
    expect(Number(rows[0].after.tarifa)).toBe(9800);
  });

  it('DEACTIVATES rather than deletes, and a deactivated rate never resolves again', async () => {
    await firmar();
    expect((await opciones().expect(200)).body.opciones[0].tarifaId).toBe(tarifaId);

    await request(app)
      .delete(`/api/transportistas/${transportistaId}/convenios/${convenioId}/tarifas/${tarifaId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    // The row survives — despachos point at it — but it is no longer a price anybody can be quoted.
    const { rows } = await query<{ activo: boolean }>('SELECT activo FROM transportista_tarifas WHERE id = $1', [tarifaId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].activo).toBe(false);

    const res = await opciones().expect(200);
    expect(res.body.opciones[0].tarifaId).toBeNull();
    expect(res.body.opciones[0].advertencia).toContain('Sin tarifa vigente');
  });

  it('a deactivated rate is not resolved onto a new despacho either', async () => {
    await firmar();
    const op = await query<{ id: string }>(
      `INSERT INTO operaciones (mawb, mawb_raw, etapa, client_id, destino_iata)
       VALUES ('160-33333333','160-33333333','disponible',$1,'NLU') RETURNING id`,
      [clientId],
    );
    await request(app)
      .delete(`/api/transportistas/${transportistaId}/convenios/${convenioId}/tarifas/${tarifaId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const d = await request(app)
      .post('/api/despachos')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        fechaOperacion: FECHA,
        tipoUnidad: 'tracto',
        transportistaId,
        partidas: [{ operacionId: op.rows[0].id }],
      })
      .expect(201);
    expect(d.body.tarifaId).toBeNull();
    expect(d.body.tarifaMonto).toBeNull();
    expect(d.body.advertencia).toContain('sin tarifa');
  });

  it('reactivates through PUT { activo: true }, and the price is a price again', async () => {
    await firmar();
    await request(app)
      .delete(`/api/transportistas/${transportistaId}/convenios/${convenioId}/tarifas/${tarifaId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    await request(app)
      .put(`/api/transportistas/${transportistaId}/convenios/${convenioId}/tarifas/${tarifaId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ activo: true })
      .expect(200);
    expect((await opciones().expect(200)).body.opciones[0].tarifaId).toBe(tarifaId);
  });

  it('lets a correction drop the destination and the expiry, which omission could not say', async () => {
    const d = await request(app)
      .post(`/api/catalogs/clients/${clientId}/direcciones`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ alias: 'Bodega 3' })
      .expect(201);
    const tf = await request(app)
      .post(`/api/transportistas/${transportistaId}/convenios/${convenioId}/tarifas`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ tipoUnidad: 'torton', tarifa: 6100, direccionEntregaId: d.body.id, vigenciaHasta: '2026-06-30' })
      .expect(201);

    const upd = await request(app)
      .put(`/api/transportistas/${transportistaId}/convenios/${convenioId}/tarifas/${tf.body.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ direccionEntregaId: null, vigenciaHasta: null })
      .expect(200);
    expect(upd.body.direccionEntregaId).toBeNull();
    expect(upd.body.vigenciaHasta).toBeNull();
  });

  it('404s for a rate that belongs to another carrier, and rejects an unknown destination', async () => {
    const otro = await crearTransportista({ razonSocial: 'Fletes del Norte' }).expect(201);
    await request(app)
      .put(`/api/transportistas/${otro.body.id}/convenios/${convenioId}/tarifas/${tarifaId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ tarifa: 1 })
      .expect(404);
    await request(app)
      .delete(`/api/transportistas/${otro.body.id}/convenios/${convenioId}/tarifas/${tarifaId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(404);
    const mala = await request(app)
      .put(`/api/transportistas/${transportistaId}/convenios/${convenioId}/tarifas/${tarifaId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ direccionEntregaId: '11111111-1111-4111-8111-111111111111' })
      .expect(400);
    expect(mala.body.error).toContain('direccionEntregaId');
  });

  it('refuses an empty correction rather than writing nothing and reporting success', async () => {
    const res = await request(app)
      .put(`/api/transportistas/${transportistaId}/convenios/${convenioId}/tarifas/${tarifaId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
      .expect(400);
    expect(res.body.error).toContain('actualizar');
  });
});

describe('gap 3 — editar antes de la firma, renovar después', () => {
  let transportistaId: string;
  let convenioId: string;

  beforeEach(async () => {
    const t = await crearTransportista({ razonSocial: 'Transportes del Bajío' }).expect(201);
    transportistaId = t.body.id;
    const c = await request(app)
      .post(`/api/transportistas/${transportistaId}/convenios`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ vigenciaDesde: '2026-01-01', vigenciaHasta: '2026-12-31', notas: 'Negociado con tráfico' })
      .expect(201);
    convenioId = c.body.id;
  });

  function firmar() {
    return request(app)
      .post(`/api/transportistas/${transportistaId}/convenios/${convenioId}/firmar`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ firmaProveedor: 'Cincel', firmaReferencia: 'NOM151-2026-0001' })
      .expect(200);
  }

  it('edits vigencia and notes freely while the convenio is a draft', async () => {
    const res = await request(app)
      .put(`/api/transportistas/${transportistaId}/convenios/${convenioId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ vigenciaHasta: '2027-06-30', notas: 'Renegociado el 3 de junio', estadoFirma: 'enviado' })
      .expect(200);
    expect(res.body.estadoFirma).toBe('enviado');
    expect(res.body.notas).toBe('Renegociado el 3 de junio');
    expect(String(res.body.vigenciaHasta)).toContain('2027-06-30');

    // 'enviado' is still pre-signature, so it stays editable.
    await request(app)
      .put(`/api/transportistas/${transportistaId}/convenios/${convenioId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ notas: '' })
      .expect(200);
    const { rows } = await query<{ notas: string | null }>('SELECT notas FROM transportista_convenios WHERE id = $1', [convenioId]);
    expect(rows[0].notas).toBeNull();
  });

  it('an edit is never a path to firmado', async () => {
    await request(app)
      .put(`/api/transportistas/${transportistaId}/convenios/${convenioId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ estadoFirma: 'firmado' })
      .expect(400);
  });

  it('REFUSES to edit a signed convenio, with a 409 that explains the alternative', async () => {
    await firmar();
    const res = await request(app)
      .put(`/api/transportistas/${transportistaId}/convenios/${convenioId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ vigenciaHasta: '2027-12-31' })
      .expect(409);
    expect(res.body.estadoFirma).toBe('firmado');
    expect(res.body.error).toMatch(/renov/i);
    expect(res.body.error).toMatch(/firm/i);

    // And nothing moved: the signed document still says what it said.
    const { rows } = await query<{ vigencia_hasta: Date }>(
      'SELECT vigencia_hasta FROM transportista_convenios WHERE id = $1',
      [convenioId],
    );
    expect(String(rows[0].vigencia_hasta.getFullYear())).toBe('2026');
  });

  it('is admin territory to edit and to renew', async () => {
    await request(app)
      .put(`/api/transportistas/${transportistaId}/convenios/${convenioId}`)
      .set('Authorization', `Bearer ${capturistaToken}`)
      .send({ notas: 'x' })
      .expect(403);
    await request(app)
      .post(`/api/transportistas/${transportistaId}/convenios/${convenioId}/renovar`)
      .set('Authorization', `Bearer ${capturistaToken}`)
      .send({ vigenciaDesde: '2027-01-01' })
      .expect(403);
  });

  it('renovar creates a linked successor that carries the ACTIVE rates and leaves the original intact', async () => {
    const viva = await request(app)
      .post(`/api/transportistas/${transportistaId}/convenios/${convenioId}/tarifas`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ tipoUnidad: 'tracto', tarifa: 8500, vigenciaHasta: '2026-12-31' })
      .expect(201);
    const retirada = await request(app)
      .post(`/api/transportistas/${transportistaId}/convenios/${convenioId}/tarifas`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ tipoUnidad: 'torton', tarifa: 6100 })
      .expect(201);
    await request(app)
      .delete(`/api/transportistas/${transportistaId}/convenios/${convenioId}/tarifas/${retirada.body.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    await firmar();

    const nuevo = await request(app)
      .post(`/api/transportistas/${transportistaId}/convenios/${convenioId}/renovar`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ vigenciaDesde: '2027-01-01', vigenciaHasta: '2027-12-31' })
      .expect(201);

    expect(nuevo.body.id).not.toBe(convenioId);
    expect(nuevo.body.renovadoDeConvenioId).toBe(convenioId);
    // The successor starts UNSIGNED: renewal creates an agreement, it does not sign one.
    expect(nuevo.body.estadoFirma).toBe('borrador');
    expect(nuevo.body.firmadoAt).toBeNull();
    // The notes travel with the terms; the retired rate does not.
    expect(nuevo.body.notas).toBe('Negociado con tráfico');
    expect(nuevo.body.tarifasCopiadas).toBe(1);

    const detalle = await request(app)
      .get(`/api/transportistas/${transportistaId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const sucesor = detalle.body.convenios.find((c: { id: string }) => c.id === nuevo.body.id);
    const original = detalle.body.convenios.find((c: { id: string }) => c.id === convenioId);

    expect(sucesor.tarifas).toHaveLength(1);
    expect(Number(sucesor.tarifas[0].tarifa)).toBe(8500);
    // The copied rate inherits the SUCCESSOR's window: carrying 2026 dates into a 2027 agreement
    // would produce a price that can never resolve.
    expect(sucesor.tarifas[0].vigenciaHasta).toBeNull();
    expect(sucesor.renovadoDeConvenioId).toBe(convenioId);

    // The signed one is untouched, and now knows it has a successor.
    expect(original.estadoFirma).toBe('firmado');
    expect(original.tarifas).toHaveLength(2);
    expect(original.renovadoPorConvenioId).toBe(nuevo.body.id);
    expect(String(original.vigenciaHasta)).toContain('2026-12-31');

    expect(Number(viva.body.tarifa)).toBe(8500);
  });

  it('can skip the rates when the renewal is a renegotiation from zero', async () => {
    await request(app)
      .post(`/api/transportistas/${transportistaId}/convenios/${convenioId}/tarifas`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ tipoUnidad: 'tracto', tarifa: 8500 })
      .expect(201);
    await firmar();
    const nuevo = await request(app)
      .post(`/api/transportistas/${transportistaId}/convenios/${convenioId}/renovar`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ vigenciaDesde: '2027-01-01', copiarTarifas: false, notas: 'Renegociación completa' })
      .expect(201);
    expect(nuevo.body.tarifasCopiadas).toBe(0);
    expect(nuevo.body.notas).toBe('Renegociación completa');
  });

  it('refuses to renew what was never signed — a draft is simply edited', async () => {
    const res = await request(app)
      .post(`/api/transportistas/${transportistaId}/convenios/${convenioId}/renovar`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ vigenciaDesde: '2027-01-01' })
      .expect(409);
    expect(res.body.estadoFirma).toBe('borrador');
    expect(res.body.error).toMatch(/edita/i);
    expect((await query('SELECT id FROM transportista_convenios')).rows).toHaveLength(1);
  });

  it('requires the successor to say from when it runs', async () => {
    await firmar();
    await request(app)
      .post(`/api/transportistas/${transportistaId}/convenios/${convenioId}/renovar`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
      .expect(400);
  });

  it('records the renewal as its own act, naming both ends of the chain', async () => {
    await firmar();
    const nuevo = await request(app)
      .post(`/api/transportistas/${transportistaId}/convenios/${convenioId}/renovar`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ vigenciaDesde: '2027-01-01' })
      .expect(201);
    const { rows } = await query<{ entity_id: string; before: Record<string, unknown>; after: Record<string, unknown> }>(
      `SELECT entity_id, before, after FROM audit_log WHERE action = 'CONVENIO_RENOVADO'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].entity_id).toBe(nuevo.body.id);
    expect(rows[0].before.convenioOrigenId).toBe(convenioId);
    expect(rows[0].after.renovadoDeConvenioId).toBe(convenioId);
  });

  it('404s across carriers, for both the edit and the renewal', async () => {
    const otro = await crearTransportista({ razonSocial: 'Fletes del Norte' }).expect(201);
    await request(app)
      .put(`/api/transportistas/${otro.body.id}/convenios/${convenioId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ notas: 'x' })
      .expect(404);
    await request(app)
      .post(`/api/transportistas/${otro.body.id}/convenios/${convenioId}/renovar`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ vigenciaDesde: '2027-01-01' })
      .expect(404);
  });
});
