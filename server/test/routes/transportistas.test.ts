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
