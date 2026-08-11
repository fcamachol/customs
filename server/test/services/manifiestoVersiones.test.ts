import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import * as XLSX from 'xlsx';
import { createApp } from '../../src/app';
import { hashPassword } from '../../src/auth/password';
import { signToken } from '../../src/auth/token';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';
import { ingestWorkbook } from '../../src/services/manifestIngest';
import { aplicarVersion, conjuntoLineasHash, stageVersion } from '../../src/services/manifiestoVersiones';

/**
 * El manifiesto corregido (diseño 2026-08-10, orden de trabajo 1).
 *
 * La razón de ser de esta suite es una capacidad que NO existía: sustituir el manifiesto de un MAWB
 * por una versión corregida. Por la vía UI era imposible (409 antes de persistir nada) y por la vía
 * prealerta era peor que imposible, porque parecía funcionar: el adjunto se archivaba, las filas
 * VIEJAS se volvían a promover y la respuesta decía `adjuntado` con los `counts` del archivo que
 * acababa de tirarse. Los tests de aquí abajo son, en ese orden, las cinco cosas que tenían que ser
 * verdad para poder decir que la corrección existe.
 */

const app = createApp();
let token: string;
let autoridadToken: string;
let userId: string;

function xlsxBuffer(aoa: unknown[][]): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Hoja1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

const HEADER = [
  'Número de guía de embarque', 'Descripción del Producto', 'Código HS', 'Número de productos',
  'Valor total declarado', 'Divisa', 'Código de país del remitente', 'ID',
];
/** La línea original. `Número de productos` = 1. */
const G1 = ['G1', 'Camisa', '6109100022', '1', '6.03', 'Dólar estadounidense', 'CN', 'AERA790828HBSRBR04'];
/** La MISMA línea corregida: 5 piezas. La clave de idempotencia (mawb|guía|secuencia|HS) no cambia,
 *  así que esto es una MODIFICACIÓN y no un alta+baja — que es justo lo que hay que probar. */
const G1_CORREGIDA = ['G1', 'Camisa', '6109100022', '5', '6.03', 'Dólar estadounidense', 'CN', 'AERA790828HBSRBR04'];
const G2 = ['G2', 'Pantalón', '6109100022', '2', '7.50', 'Dólar estadounidense', 'CN', 'AERA790828HBSRBR04'];
/** Valor ilegible → fila con error duro. Sirve para probar que el bronce conserva sus `errors`. */
const G3_MALA = ['G3', 'Camisa', '6109100022', '1', 'N/A', 'Dólar estadounidense', 'CN', 'AERA790828HBSRBR04'];

const MAWB = '369-VER';

function parse(filas: unknown[][], mawb = MAWB) {
  return ingestWorkbook(xlsxBuffer([HEADER, ...filas]), mawb);
}

async function nuevoManifiesto(mawb = MAWB): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO manifests (mawb_reference, created_by, ingestion_status)
     VALUES ($1,$2,'staged') RETURNING id`,
    [mawb, userId],
  );
  return rows[0].id;
}

/** Sube una versión y la aplica, que es lo que hace la vía desatendida en una sola llamada. */
async function versionar(
  manifestId: string,
  filas: unknown[][],
  motivo: string | null,
  mawb = MAWB,
) {
  const staged = await stageVersion({
    manifestId,
    parsed: parse(filas, mawb),
    origen: 'carga_manual',
    motivo,
    sourceFileId: null,
    fileContentHash: null,
    userId,
  });
  if (staged.status !== 'staged') return { staged, aplicada: null };
  const aplicada = await aplicarVersion({
    manifestId,
    version: staged.version,
    userId,
    correrRiesgo: false,
  });
  return { staged, aplicada };
}

async function lineasDelOro(manifestId: string) {
  const { rows } = await query<{ guia: string; cantidad: string }>(
    `SELECT data->>'guideId' AS guia, data->>'quantity' AS cantidad
       FROM shipments WHERE manifest_id = $1 ORDER BY 1`,
    [manifestId],
  );
  return rows.map((r) => `${r.guia}:${r.cantidad}`);
}

beforeEach(async () => {
  await truncateAll();
  const hash = await hashPassword('p');
  const u = await query<{ id: string }>(
    `INSERT INTO users (username,password_hash,role) VALUES ('cap',$1,'capturista') RETURNING id`,
    [hash],
  );
  userId = u.rows[0].id;
  token = signToken({ userId, role: 'capturista', tv: 0 });
  const a = await query<{ id: string }>(
    `INSERT INTO users (username,password_hash,role) VALUES ('aut',$1,'autoridad') RETURNING id`,
    [hash],
  );
  autoridadToken = signToken({ userId: a.rows[0].id, role: 'autoridad', tv: 0 });
});

describe('aplicarVersion — la corrección llega de verdad al oro', () => {
  it('cambia las líneas corregidas y borra las que la versión nueva retira', async () => {
    // ÉSTE es el test que justifica toda la fase. Antes, un reenvío corregido dejaba el oro intacto.
    const id = await nuevoManifiesto();
    const v1 = await versionar(id, [G1, G2], null);
    expect(v1.aplicada?.status).toBe('aplicada');
    expect(await lineasDelOro(id)).toEqual(['G1:1', 'G2:2']);

    const v2 = await versionar(id, [G1_CORREGIDA], 'El cliente corrigió las piezas de G1 y retiró G2');
    expect(v2.staged.status).toBe('staged');
    if (v2.staged.status !== 'staged') return;
    expect(v2.staged.version).toBe(2);
    expect(v2.staged.diff).toMatchObject({ altas: [], modificadas: [expect.stringContaining('G1')], sinCambio: 0 });
    expect(v2.staged.diff.bajas).toHaveLength(1);

    // El oro es el documento nuevo: G1 con su valor corregido, G2 ya no está.
    expect(await lineasDelOro(id)).toEqual(['G1:5']);
    expect(v2.aplicada?.status).toBe('aplicada');
    if (v2.aplicada?.status !== 'aplicada') return;
    expect(v2.aplicada.bajas).toHaveLength(1);
    // La guía retirada se REPORTA; su `operacion_guias` no se toca (puede estar retenida o cubierta).
    expect(v2.aplicada.guiasRetiradas).toEqual(['G2']);

    const man = await query<{ version_vigente: number; ingestion_status: string }>(
      'SELECT version_vigente, ingestion_status FROM manifests WHERE id=$1', [id]);
    expect(man.rows[0].version_vigente).toBe(2);
    expect(man.rows[0].ingestion_status).toBe('promoted');
  });

  it('deja el evento y la auditoría del versionado, con el before de la versión anterior', async () => {
    // El evento exige caso; la auditoría se escribe siempre. Aquí hay caso, así que van los dos.
    const id = await nuevoManifiesto();
    await query(
      `INSERT INTO operaciones (mawb, mawb_raw, manifest_id) VALUES ($1,$1,$2)`,
      ['369VER', id],
    );
    await versionar(id, [G1], null);
    await versionar(id, [G1_CORREGIDA], 'corrección del cliente');

    const ev = await query<{ tipo: string; payload: Record<string, unknown> }>(
      `SELECT tipo, payload FROM operacion_eventos WHERE tipo='MANIFIESTO_VERSIONADO' ORDER BY id`);
    expect(ev.rows).toHaveLength(2);
    expect(ev.rows[1].payload.version).toBe(2);
    expect(ev.rows[1].payload.motivo).toBe('corrección del cliente');

    const aud = await query<{ before: Record<string, unknown> | null; after: Record<string, unknown> }>(
      `SELECT before, after FROM audit_log WHERE action='MANIFIESTO_VERSIONADO' ORDER BY id`);
    expect(aud.rows).toHaveLength(2);
    // "El before se audita, no sólo el after": la v2 dice contra qué versión se comparó.
    expect(aud.rows[0].before?.version).toBeNull();
    expect(aud.rows[1].before?.version).toBe(1);
    expect(aud.rows[1].before?.lineSetHash).toEqual(expect.any(String));
    // Claves e huellas, nunca valores: ninguna PII del manifiesto viaja al expediente.
    expect(JSON.stringify(aud.rows[1])).not.toContain('AERA790828HBSRBR04');
  });

  it('escribe sólo auditoría cuando el manifiesto no tiene caso (carga manual)', async () => {
    const id = await nuevoManifiesto();
    await versionar(id, [G1], null);
    expect((await query(`SELECT 1 FROM operacion_eventos`)).rows).toHaveLength(0);
    expect((await query(`SELECT 1 FROM audit_log WHERE action='MANIFIESTO_VERSIONADO'`)).rows)
      .toHaveLength(1);
  });
});

describe('compuerta de no-op — idempotencia de webhook', () => {
  it('un reenvío byte-idéntico no crea versión nueva', async () => {
    const id = await nuevoManifiesto();
    await versionar(id, [G1, G2], null);

    const otraVez = await stageVersion({
      manifestId: id,
      parsed: parse([G1, G2]),
      origen: 'prealerta',
      motivo: 'Reenvío de prealerta v2 (<msg-2@cliente>)',
      sourceFileId: null,
      fileContentHash: null,
      userId: null,
    });
    expect(otraVez.status).toBe('sin_cambios');
    if (otraVez.status !== 'sin_cambios') return;
    expect(otraVez.version).toBe(1);

    const versiones = await query<{ n: number }>(
      'SELECT count(*)::int AS n FROM manifiesto_versiones WHERE manifest_id=$1', [id]);
    expect(versiones.rows[0].n).toBe(1);
    const bronce = await query<{ n: number }>(
      'SELECT count(*)::int AS n FROM manifest_staging_rows WHERE manifest_id=$1', [id]);
    expect(bronce.rows[0].n).toBe(2);
  });

  it('la huella del conjunto no depende del orden de las filas', async () => {
    // Reordenar un Excel no cambia el embarque. Si la huella dependiera del orden, un cliente que
    // ordena por peso antes de reenviar produciría una versión "nueva" idéntica en contenido.
    const a = conjuntoLineasHash([
      { idempotencyKey: 'k1', rowHash: 'h1' },
      { idempotencyKey: 'k2', rowHash: 'h2' },
    ]);
    const b = conjuntoLineasHash([
      { idempotencyKey: 'k2', rowHash: 'h2' },
      { idempotencyKey: 'k1', rowHash: 'h1' },
    ]);
    expect(a).toBe(b);
    expect(a).not.toBe(conjuntoLineasHash([{ idempotencyKey: 'k1', rowHash: 'h9' }]));
  });
});

describe('compuerta de bloqueo — pedimento cargado', () => {
  it('registra la versión como rechazada y ENTONCES responde 409', async () => {
    // El documento del cliente no se descarta en la puerta: queda archivado y el rechazo, en el
    // expediente. Espejo exacto de `prealertas.estado='rechazada'` + `motivo_rechazo`.
    const up = await request(app).post('/api/manifests').set('Authorization', `Bearer ${token}`)
      .field('mawbReference', '369-LOCK').attach('file', xlsxBuffer([HEADER, G1]), 'm.xlsx');
    expect(up.status).toBe(201);
    const id = up.body.manifestId;
    await request(app).post(`/api/manifests/${id}/promote`).set('Authorization', `Bearer ${token}`);
    await query(
      `INSERT INTO pedimentos (manifest_id, sub_status, created_by) VALUES ($1,'cargado',$2)`,
      [id, userId],
    );

    const res = await request(app).post(`/api/manifests/${id}/versiones`)
      .set('Authorization', `Bearer ${token}`)
      .field('motivo', 'El cliente corrigió las piezas')
      .attach('file', xlsxBuffer([HEADER, G1_CORREGIDA]), 'm2.xlsx');

    expect(res.status).toBe(409);
    expect(res.body.estadoVersion).toBe('rechazada');
    expect(res.body.motivoRechazo).toBe('pedimento_cargado');

    // La fila está, con su motivo, su archivo y su hash — no fue un early-return.
    const v = await query<{ estado: string; motivo_rechazo: string; source_file_id: string | null; motivo: string }>(
      `SELECT estado, motivo_rechazo, source_file_id, motivo FROM manifiesto_versiones
        WHERE manifest_id=$1 AND version=2`, [id]);
    expect(v.rows).toHaveLength(1);
    expect(v.rows[0].estado).toBe('rechazada');
    expect(v.rows[0].motivo_rechazo).toBe('pedimento_cargado');
    expect(v.rows[0].source_file_id).toBeTruthy();
    expect(v.rows[0].motivo).toBe('El cliente corrigió las piezas');

    // Y el oro no se movió.
    expect(await lineasDelOro(id)).toEqual(['G1:1']);
    expect((await query(`SELECT 1 FROM audit_log WHERE action='MANIFIESTO_VERSION_RECHAZADA'`)).rows)
      .toHaveLength(1);
  });
});

describe('historia línea a línea — el bronce de las versiones viejas', () => {
  it('conserva las filas de la v1 intactas, con sus errors y warnings, tras aplicar la v2', async () => {
    const id = await nuevoManifiesto();
    const v1 = await versionar(id, [G1, G3_MALA], null);
    expect(v1.aplicada?.status).toBe('aplicada');
    // Sólo la buena se promueve; la mala se queda en bronce con su error.
    if (v1.aplicada?.status === 'aplicada') expect(v1.aplicada.promovidas).toBe(1);

    const antes = await query<{ row_index: number; status: string; errors: unknown[]; warnings: unknown[] }>(
      `SELECT row_index, status, errors, warnings FROM manifest_staging_rows
        WHERE manifest_id=$1 AND version=1 ORDER BY row_index`, [id]);
    expect(antes.rows).toHaveLength(2);

    await versionar(id, [G1_CORREGIDA], 'corrección');

    const despues = await query<{ row_index: number; status: string; errors: unknown[]; warnings: unknown[] }>(
      `SELECT row_index, status, errors, warnings FROM manifest_staging_rows
        WHERE manifest_id=$1 AND version=1 ORDER BY row_index`, [id]);
    expect(despues.rows).toEqual(antes.rows);
    // La fila con error sigue explicando por qué lo era — es el dato que un auditor viene a leer.
    const mala = despues.rows.find((r) => r.status === 'error')!;
    expect(mala.errors.length).toBeGreaterThan(0);

    // Y la v2 vive al lado, sin haber tocado nada de la v1.
    const v2 = await query<{ n: number }>(
      'SELECT count(*)::int AS n FROM manifest_staging_rows WHERE manifest_id=$1 AND version=2', [id]);
    expect(v2.rows[0].n).toBe(1);
  });
});

describe('acarreo del color anterior y anulación del motor', () => {
  it('guarda risk_color_anterior en la línea que cambió y anula LAS CINCO columnas del motor', async () => {
    const id = await nuevoManifiesto();
    await versionar(id, [G1], null);

    // Simula la corrida de riesgo que la UI dispara después de promover.
    await query(
      `UPDATE shipments SET risk_score=80, risk_color='rojo', risk_incidences=$1::jsonb,
                            risk_reasons=$2::jsonb, ruleset_hash='abc123'
        WHERE manifest_id=$3`,
      [JSON.stringify(['motivo']), JSON.stringify([{ signalId: 'monto', points: 3 }]), id],
    );

    await versionar(id, [G1_CORREGIDA], 'corrección del valor');

    const s = await query<Record<string, unknown>>(
      `SELECT risk_score, risk_color, risk_incidences, risk_reasons, ruleset_hash,
              risk_color_anterior, risk_score_anterior, risk_version_anterior
         FROM shipments WHERE manifest_id=$1`, [id]);
    expect(s.rows).toHaveLength(1);
    const row = s.rows[0];

    // El "antes" que el bronce no guarda: el bronce retiene el DATO, no su calificación.
    expect(row.risk_color_anterior).toBe('rojo');
    expect(row.risk_score_anterior).toBe(80);
    expect(row.risk_version_anterior).toBe(1);

    // Las CINCO. El upsert anterior olvidaba `risk_reasons` y `ruleset_hash`, y dejaba razones
    // describiendo datos que ya no existen — dato viejo con aspecto de fresco.
    expect(row.risk_score).toBeNull();
    expect(row.risk_color).toBeNull();
    expect(row.risk_incidences).toBeNull();
    expect(row.risk_reasons).toBeNull();
    expect(row.ruleset_hash).toBeNull();
    // Y el manifiesto queda marcado como rancio, que es lo que enciende el banner ámbar.
    const man = await query<{ risk_stale: boolean }>('SELECT risk_stale FROM manifests WHERE id=$1', [id]);
    expect(man.rows[0].risk_stale).toBe(true);
  });
});

describe('las rutas de versiones', () => {
  it('sustituye por HTTP: 201 con el diff, promote con motivo, y el oro cambia', async () => {
    const up = await request(app).post('/api/manifests').set('Authorization', `Bearer ${token}`)
      .field('mawbReference', '369-HTTP').attach('file', xlsxBuffer([HEADER, G1, G2]), 'm.xlsx');
    const id = up.body.manifestId;
    await request(app).post(`/api/manifests/${id}/promote`).set('Authorization', `Bearer ${token}`);
    expect(await lineasDelOro(id)).toEqual(['G1:1', 'G2:2']);

    const sub = await request(app).post(`/api/manifests/${id}/versiones`)
      .set('Authorization', `Bearer ${token}`)
      .field('motivo', 'El cliente corrigió G1')
      .attach('file', xlsxBuffer([HEADER, G1_CORREGIDA, G2]), 'm2.xlsx');
    expect(sub.status).toBe(201);
    expect(sub.body).toMatchObject({ version: 2, estado: 'staged' });
    expect(sub.body.diff.modificadas).toHaveLength(1);
    expect(sub.body.diff.sinCambio).toBe(1);
    // Todavía NO se aplicó: dos pasos, porque un humano quiere ver el diff antes.
    expect(await lineasDelOro(id)).toEqual(['G1:1', 'G2:2']);

    const prom = await request(app).post(`/api/manifests/${id}/promote`)
      .set('Authorization', `Bearer ${token}`).send({ motivo: 'El cliente corrigió G1' });
    expect(prom.status).toBe(200);
    expect(prom.body.version).toBe(2);
    expect(await lineasDelOro(id)).toEqual(['G1:5', 'G2:2']);
  });

  it('exige motivo desde la v2 y lo rechaza en blanco', async () => {
    const up = await request(app).post('/api/manifests').set('Authorization', `Bearer ${token}`)
      .field('mawbReference', '369-MOT').attach('file', xlsxBuffer([HEADER, G1]), 'm.xlsx');
    const id = up.body.manifestId;
    await request(app).post(`/api/manifests/${id}/promote`).set('Authorization', `Bearer ${token}`);

    const sinMotivo = await request(app).post(`/api/manifests/${id}/versiones`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', xlsxBuffer([HEADER, G1_CORREGIDA]), 'm2.xlsx');
    expect(sinMotivo.status).toBe(400);

    // " " satisface un min(1) y no le dice nada a nadie.
    const enBlanco = await request(app).post(`/api/manifests/${id}/versiones`)
      .set('Authorization', `Bearer ${token}`).field('motivo', '   ')
      .attach('file', xlsxBuffer([HEADER, G1_CORREGIDA]), 'm2.xlsx');
    expect(enBlanco.status).toBe(400);
  });

  it('devuelve sin_cambios cuando el archivo describe el mismo conjunto de líneas', async () => {
    const up = await request(app).post('/api/manifests').set('Authorization', `Bearer ${token}`)
      .field('mawbReference', '369-NOOP').attach('file', xlsxBuffer([HEADER, G1]), 'm.xlsx');
    const id = up.body.manifestId;
    await request(app).post(`/api/manifests/${id}/promote`).set('Authorization', `Bearer ${token}`);

    const res = await request(app).post(`/api/manifests/${id}/versiones`)
      .set('Authorization', `Bearer ${token}`).field('motivo', 'reenvío')
      .attach('file', xlsxBuffer([HEADER, G1]), 'm-otra-vez.xlsx');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'sin_cambios', version: 1 });
    const n = await query<{ n: number }>(
      'SELECT count(*)::int AS n FROM manifiesto_versiones WHERE manifest_id=$1', [id]);
    expect(n.rows[0].n).toBe(1);
  });

  it('POST /api/manifests marca puedeSustituir en el 409 por MAWB duplicado', async () => {
    await request(app).post('/api/manifests').set('Authorization', `Bearer ${token}`)
      .field('mawbReference', '369-DUP').attach('file', xlsxBuffer([HEADER, G1]), 'm.xlsx');
    const otra = await request(app).post('/api/manifests').set('Authorization', `Bearer ${token}`)
      .field('mawbReference', '369-DUP').attach('file', xlsxBuffer([HEADER, G2]), 'm2.xlsx');
    expect(otra.status).toBe(409);
    expect(otra.body.puedeSustituir).toBe(true);
    expect(otra.body.manifestId).toBeTruthy();
  });

  it('GET /:id/versiones es legible por autoridad; el staging por versión no', async () => {
    const up = await request(app).post('/api/manifests').set('Authorization', `Bearer ${token}`)
      .field('mawbReference', '369-AUT').attach('file', xlsxBuffer([HEADER, G1]), 'm.xlsx');
    const id = up.body.manifestId;

    const vis = await request(app).get(`/api/manifests/${id}/versiones`)
      .set('Authorization', `Bearer ${autoridadToken}`);
    expect(vis.status).toBe(200);
    expect(vis.body.vigente).toBe(1);
    expect(vis.body.versiones).toHaveLength(1);
    expect(vis.body.versiones[0]).toMatchObject({ version: 1, estado: 'staged', origen: 'carga_manual' });

    // La autoridad es testigo, no actor: no sube ni promueve.
    const intento = await request(app).post(`/api/manifests/${id}/versiones`)
      .set('Authorization', `Bearer ${autoridadToken}`).field('motivo', 'x')
      .attach('file', xlsxBuffer([HEADER, G1_CORREGIDA]), 'm2.xlsx');
    expect(intento.status).toBe(403);
  });

  it('GET /:id/staging?version= devuelve la versión pedida y por defecto la vigente', async () => {
    const up = await request(app).post('/api/manifests').set('Authorization', `Bearer ${token}`)
      .field('mawbReference', '369-STG').attach('file', xlsxBuffer([HEADER, G1, G2]), 'm.xlsx');
    const id = up.body.manifestId;
    await request(app).post(`/api/manifests/${id}/promote`).set('Authorization', `Bearer ${token}`);
    await request(app).post(`/api/manifests/${id}/versiones`).set('Authorization', `Bearer ${token}`)
      .field('motivo', 'corrección').attach('file', xlsxBuffer([HEADER, G1_CORREGIDA]), 'm2.xlsx');

    // Por defecto, la VIGENTE: lo que la pantalla describe es lo que hay en el oro.
    const porDefecto = await request(app).get(`/api/manifests/${id}/staging`)
      .set('Authorization', `Bearer ${token}`);
    expect(porDefecto.body.version).toBe(1);
    expect(porDefecto.body.rows).toHaveLength(2);

    const v2 = await request(app).get(`/api/manifests/${id}/staging?version=2`)
      .set('Authorization', `Bearer ${token}`);
    expect(v2.body.version).toBe(2);
    expect(v2.body.rows).toHaveLength(1);
  });
});
