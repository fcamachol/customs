import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { hashPassword } from '../../src/auth/password';
import { signToken } from '../../src/auth/token';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';
import type { ReasonCode, SignalId } from '../../../shared/risk/signals';

/**
 * LA API DE DISPOSICIONES (diseño 2026-08-10, orden de trabajo 3).
 *
 * Lo que estas pruebas defienden, en orden de lo caro que sería equivocarse:
 *
 *   - **El motor no se toca nunca.** Tras cualquier disposición, `risk_score`, `risk_color`,
 *     `risk_incidences`, `risk_reasons` y `ruleset_hash` quedan byte a byte idénticas. Es el criterio
 *     de salida de la fase y la razón de ser del diseño entero: si el color de la fila cambiara,
 *     nadie podría probar después que el sistema había marcado algo.
 *   - **La huella la calcula el servidor.** El cuerpo no la trae; sale de la razón almacenada. Un
 *     cliente que la eligiera podría disponer un hallazgo que el motor nunca produjo.
 *   - **Nadie dispone sobre datos rancios ni sobre hallazgos que no existen** (los dos 409).
 *   - **El escalón de rol es el peso de lo que se tapa**, y `denied_party` sólo lo tapa quien puede
 *     editar la lista de sancionados.
 *   - **Retractarse es insertar.** La tabla es append-only: el trigger revienta ante un UPDATE de
 *     contenido y ante un DELETE directo, y la retractación devuelve el color del motor.
 */

const app = createApp();

const MAWB = '160-99990001';
const RFC = 'PERJ800101AA8';

let adminToken: string;
let capturistaToken: string;
let superAdminToken: string;
let tramitadorToken: string;
let autoridadToken: string;
let adminId: string;
let manifestId: string;
let operacionId: string;

interface Semilla {
  guia: string;
  nombre: string;
  rfc?: string;
  descripcion: string;
  cantidad: number;
  valor: number | null;
  direccion: string;
}

/**
 * Cinco líneas elegidas para cubrir cada peldaño de la matriz de roles con la config por defecto:
 * verde (nada que disponer), amarilla (señales graduadas: `cantidad` + `monto`), roja NO forzada
 * (`monto` muy alto por encima del umbral, sin `forcesBand`), roja FORZADA por `prohibidos`, y roja
 * forzada por `denied_party` — el único peldaño que exige super_admin.
 */
const SEMILLAS: Semilla[] = [
  { guia: 'D-VERDE', nombre: 'Ana Verde', rfc: RFC, descripcion: 'camisa', cantidad: 1, valor: 100, direccion: 'Calle 1' },
  { guia: 'D-AMARILLO', nombre: 'Beto Amarillo', rfc: RFC, descripcion: 'camisa', cantidad: 30, valor: 0.5, direccion: 'Calle 2' },
  { guia: 'D-ROJO', nombre: 'Carla Roja', rfc: RFC, descripcion: 'pistola de juguete', cantidad: 1, valor: 50, direccion: 'Calle 3' },
  { guia: 'D-SANCION', nombre: 'Fausto Sancionado', rfc: RFC, descripcion: 'camisa', cantidad: 1, valor: 100, direccion: 'Calle 4' },
];

async function insertarLinea(s: Semilla): Promise<void> {
  await query(
    'INSERT INTO shipments (id, manifest_id, idempotency_key, data) VALUES (gen_random_uuid(),$1,$2,$3)',
    [
      manifestId,
      `${MAWB}|${s.guia}`,
      JSON.stringify({
        id: crypto.randomUUID(),
        mawbReference: MAWB,
        description: s.descripcion,
        hsCode: '6109100022',
        quantity: s.cantidad,
        unit: 'PCE',
        customsValueUsd: s.valor,
        currency: 'USD',
        originCountry: 'CN',
        guideId: s.guia,
        consignee: { name: s.nombre, rfc: s.rfc, address: s.direccion },
        sender: { name: 'Remitente', address: 'Shenzhen' },
        platform: { commercialName: 'Plataforma', countryOfOrigin: 'CN' },
      }),
    ],
  );
}

/** Corre el motor por su ruta real: el mismo camino que usa un humano al pulsar "Analizar". */
async function correrRiesgo(): Promise<void> {
  const res = await request(app)
    .post(`/api/manifests/${manifestId}/risk`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ period: '2026-03' });
  expect(res.status).toBe(200);
}

async function sembrar(): Promise<void> {
  for (const s of SEMILLAS) await insertarLinea(s);
  await correrRiesgo();
}

interface FilaOro {
  id: string;
  risk_color: string | null;
  risk_score: number | null;
  risk_incidences: string[] | null;
  risk_reasons: ReasonCode[] | null;
  ruleset_hash: string | null;
  risk_color_efectivo: string | null;
  risk_score_efectivo: number | null;
  risk_disposiciones: Record<string, unknown> | null;
}

async function fila(guia: string): Promise<FilaOro> {
  const { rows } = await query<FilaOro>(
    `SELECT id, risk_color, risk_score, risk_incidences, risk_reasons, ruleset_hash,
            risk_color_efectivo, risk_score_efectivo, risk_disposiciones
       FROM shipments WHERE manifest_id=$1 AND data->>'guideId'=$2`,
    [manifestId, guia],
  );
  expect(rows, `la línea ${guia} debe existir`).toHaveLength(1);
  return rows[0];
}

/** Las cinco columnas del motor, tal cual, para compararlas byte a byte antes y después. */
function columnasDelMotor(f: FilaOro) {
  return {
    risk_score: f.risk_score,
    risk_color: f.risk_color,
    risk_incidences: f.risk_incidences,
    risk_reasons: f.risk_reasons,
    ruleset_hash: f.ruleset_hash,
  };
}

async function disponer(
  guia: string,
  body: Record<string, unknown>,
  token = adminToken,
): Promise<request.Response> {
  const f = await fila(guia);
  return request(app)
    .post(`/api/manifests/${manifestId}/riesgo/disposiciones`)
    .set('Authorization', `Bearer ${token}`)
    .send({ shipmentId: f.id, motivo: 'revisado con el cliente', ...body });
}

function historial(token = adminToken): request.Test {
  return request(app)
    .get(`/api/manifests/${manifestId}/riesgo/disposiciones`)
    .set('Authorization', `Bearer ${token}`);
}

async function eventos(tipo: string) {
  const { rows } = await query<{ tipo: string; origen: string; payload: Record<string, unknown> }>(
    'SELECT tipo, origen, payload FROM operacion_eventos WHERE tipo = $1 ORDER BY id ASC',
    [tipo],
  );
  return rows;
}

async function auditorias(action: string) {
  const { rows } = await query<{
    entity: string;
    entity_id: string;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
  }>('SELECT entity, entity_id, before, after FROM audit_log WHERE action = $1 ORDER BY id ASC', [
    action,
  ]);
  return rows;
}

beforeEach(async () => {
  await truncateAll();
  const hash = await hashPassword('p');
  const [adm, cap, sup, tra, aut] = await Promise.all([
    query<{ id: string }>(`INSERT INTO users (username,password_hash,role) VALUES ('dz_adm',$1,'admin') RETURNING id`, [hash]),
    query<{ id: string }>(`INSERT INTO users (username,password_hash,role) VALUES ('dz_cap',$1,'capturista') RETURNING id`, [hash]),
    query<{ id: string }>(`INSERT INTO users (username,password_hash,role) VALUES ('dz_sup',$1,'super_admin') RETURNING id`, [hash]),
    query<{ id: string }>(`INSERT INTO users (username,password_hash,role) VALUES ('dz_tra',$1,'tramitador') RETURNING id`, [hash]),
    query<{ id: string }>(`INSERT INTO users (username,password_hash,role) VALUES ('dz_aut',$1,'autoridad') RETURNING id`, [hash]),
  ]);
  adminId = adm.rows[0].id;
  adminToken = signToken({ userId: adminId, role: 'admin', tv: 0 });
  capturistaToken = signToken({ userId: cap.rows[0].id, role: 'capturista', tv: 0 });
  superAdminToken = signToken({ userId: sup.rows[0].id, role: 'super_admin', tv: 0 });
  tramitadorToken = signToken({ userId: tra.rows[0].id, role: 'tramitador', tv: 0 });
  autoridadToken = signToken({ userId: aut.rows[0].id, role: 'autoridad', tv: 0 });

  // La lista de sancionados es config, igual que en producción: sin ella `denied_party` no dispara y
  // el peldaño de super_admin no se podría probar por su camino real.
  await query(`INSERT INTO config (key,value) VALUES ('denied_parties',$1)`, [
    JSON.stringify([{ name: 'Fausto Sancionado', source: 'OFAC', program: 'SDGT' }]),
  ]);

  const m = await query<{ id: string }>(
    `INSERT INTO manifests (mawb_reference, client_name, created_by, created_at, ingestion_status)
     VALUES ($1,'Cliente D',$2,'2026-03-15T12:00:00Z','promoted') RETURNING id`,
    [MAWB, adminId],
  );
  manifestId = m.rows[0].id;

  // Con caso asociado: el evento del ledger sólo se escribe cuando lo hay.
  const op = await query<{ id: string }>(
    `INSERT INTO operaciones (mawb, mawb_raw, etapa, estado_documental, manifest_id)
     VALUES ($1,$1,'en_vuelo','riesgo_con_hallazgos',$2) RETURNING id`,
    [MAWB, manifestId],
  );
  operacionId = op.rows[0].id;
});

// -------------------------------------------------------------------------------------------------
describe('la invariante: el motor no se toca nunca', () => {
  it('tras disponer, las CINCO columnas del motor quedan byte a byte idénticas', async () => {
    await sembrar();
    const antes = await Promise.all(SEMILLAS.map((s) => fila(s.guia)));

    const res = await disponer('D-ROJO', { signalId: 'prohibidos', estado: 'falso_positivo' });
    expect(res.status).toBe(201);

    const despues = await Promise.all(SEMILLAS.map((s) => fila(s.guia)));
    for (const [i, f] of despues.entries()) {
      expect(columnasDelMotor(f), `línea ${SEMILLAS[i].guia}`).toEqual(columnasDelMotor(antes[i]));
    }
    // Y sin embargo el efectivo sí cambió: la capa está al lado, no encima.
    const rojo = despues[2];
    expect(rojo.risk_color).toBe('rojo');
    expect(rojo.risk_color_efectivo).toBe('verde');
    expect(res.body).toMatchObject({
      resultadoMotor: 'rojo',
      resultado: 'verde',
      suprimidas: ['prohibidos'],
    });
  });

  it('la huella la calcula el SERVIDOR desde la razón almacenada, y el cuerpo no puede elegirla', async () => {
    await sembrar();
    const f = await fila('D-ROJO');
    const razon = (f.risk_reasons ?? []).find((r) => r.signalId === 'prohibidos')!;

    // Un cliente que intenta imponer su propia huella: el campo no existe en el esquema, así que se
    // ignora, y la fila guarda la huella de la razón real junto al ReasonCode verbatim.
    const res = await disponer('D-ROJO', {
      signalId: 'prohibidos',
      estado: 'falso_positivo',
      hallazgoHash: 'huella-inventada-por-el-cliente',
    });
    expect(res.status).toBe(201);

    const { rows } = await query<{ hallazgo_hash: string; hallazgo: ReasonCode; ruleset_hash: string }>(
      'SELECT hallazgo_hash, hallazgo, ruleset_hash FROM riesgo_disposiciones WHERE id=$1',
      [res.body.disposicionId],
    );
    expect(rows[0].hallazgo_hash).not.toBe('huella-inventada-por-el-cliente');
    expect(rows[0].hallazgo).toEqual(razon);
    expect(rows[0].ruleset_hash).toBe(f.ruleset_hash);
  });

  it('denormaliza la identidad durable de la línea y la versión del manifiesto', async () => {
    await sembrar();
    const res = await disponer('D-ROJO', { signalId: 'prohibidos', estado: 'falso_positivo' });
    const { rows } = await query<{ idempotency_key: string; manifiesto_version: number; created_by: string }>(
      'SELECT idempotency_key, manifiesto_version, created_by FROM riesgo_disposiciones WHERE id=$1',
      [res.body.disposicionId],
    );
    expect(rows[0]).toMatchObject({
      idempotency_key: `${MAWB}|D-ROJO`,
      manifiesto_version: 1,
      created_by: adminId,
    });
  });
});

// -------------------------------------------------------------------------------------------------
describe('las dos compuertas de 409', () => {
  it('sin_hallazgo_vigente: esa señal no dispara hoy en esa línea', async () => {
    await sembrar();
    const res = await disponer('D-VERDE', { signalId: 'prohibidos', estado: 'falso_positivo' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('sin_hallazgo_vigente');
    const { rows } = await query('SELECT id FROM riesgo_disposiciones');
    expect(rows).toHaveLength(0);
  });

  it('sin_hallazgo_vigente también cuando la línea nunca se calificó', async () => {
    await insertarLinea(SEMILLAS[0]);
    const res = await disponer('D-VERDE', { signalId: 'id', estado: 'falso_positivo' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('sin_hallazgo_vigente');
  });

  it('analisis_rancio: un humano no dispone sobre datos rancios', async () => {
    await sembrar();
    await query('UPDATE manifests SET risk_stale = true WHERE id=$1', [manifestId]);
    const res = await disponer('D-ROJO', { signalId: 'prohibidos', estado: 'falso_positivo' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('analisis_rancio');
  });

  it('404 cuando la línea es de otro manifiesto', async () => {
    await sembrar();
    const otro = await query<{ id: string }>(
      `INSERT INTO manifests (mawb_reference, client_name, created_by, ingestion_status)
       VALUES ('160-99990002','Otro',$1,'promoted') RETURNING id`,
      [adminId],
    );
    const ajena = await query<{ id: string }>(
      `INSERT INTO shipments (id, manifest_id, idempotency_key, data)
       VALUES (gen_random_uuid(),$1,'x','{}'::jsonb) RETURNING id`,
      [otro.rows[0].id],
    );
    const res = await request(app)
      .post(`/api/manifests/${manifestId}/riesgo/disposiciones`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ shipmentId: ajena.rows[0].id, signalId: 'prohibidos', estado: 'falso_positivo', motivo: 'x' });
    expect(res.status).toBe(404);
  });
});

// -------------------------------------------------------------------------------------------------
describe('la matriz de roles (§9)', () => {
  it('capturista SÍ suprime en una línea que el motor pintó amarilla', async () => {
    await sembrar();
    expect((await fila('D-AMARILLO')).risk_color).toBe('amarillo');
    const res = await disponer('D-AMARILLO', { signalId: 'cantidad', estado: 'falso_positivo' }, capturistaToken);
    expect(res.status).toBe(201);
  });

  it('capturista NO suprime en una línea roja, y el 403 dice qué rol hace falta', async () => {
    await sembrar();
    const res = await disponer('D-ROJO', { signalId: 'prohibidos', estado: 'falso_positivo' }, capturistaToken);
    expect(res.status).toBe(403);
    expect(res.body.rolRequerido).toBe('admin');
    expect(res.body.error).toContain('admin');
  });

  it('capturista SÍ puede `confirmado` sobre una roja: confirmar no suprime nada', async () => {
    await sembrar();
    const res = await disponer('D-ROJO', { signalId: 'prohibidos', estado: 'confirmado' }, capturistaToken);
    expect(res.status).toBe(201);
    expect(res.body.resultado).toBe('rojo');
  });

  it('admin SÍ suprime un forzado-rojo de `prohibidos`', async () => {
    await sembrar();
    const res = await disponer('D-ROJO', { signalId: 'prohibidos', estado: 'falso_positivo' }, adminToken);
    expect(res.status).toBe(201);
  });

  it('`denied_party` se le NIEGA a admin y se le concede a super_admin', async () => {
    await sembrar();
    expect((await fila('D-SANCION')).risk_color).toBe('rojo');

    const negado = await disponer('D-SANCION', { signalId: 'denied_party', estado: 'falso_positivo' }, adminToken);
    expect(negado.status).toBe(403);
    expect(negado.body.rolRequerido).toBe('super_admin');

    const concedido = await disponer(
      'D-SANCION',
      { signalId: 'denied_party', estado: 'falso_positivo' },
      superAdminToken,
    );
    expect(concedido.status).toBe(201);
    expect(concedido.body).toMatchObject({ resultadoMotor: 'rojo', resultado: 'verde' });
  });

  it('tramitador no dispone nada, y autoridad tampoco: sólo lee', async () => {
    await sembrar();
    for (const token of [tramitadorToken, autoridadToken]) {
      const res = await disponer('D-ROJO', { signalId: 'prohibidos', estado: 'confirmado' }, token);
      expect(res.status).toBe(403);
    }
    // …pero autoridad SÍ lee el expediente, y tramitador no.
    expect((await historial(autoridadToken)).status).toBe(200);
    expect((await historial(tramitadorToken)).status).toBe(403);
  });
});

// -------------------------------------------------------------------------------------------------
describe('`mitigado` exige respaldo', () => {
  it('sin evidencia ni requerimiento responde 400 ANTES de tocar el CHECK', async () => {
    await sembrar();
    const res = await disponer('D-ROJO', { signalId: 'prohibidos', estado: 'mitigado' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('evidenciaFileId');
    const { rows } = await query('SELECT id FROM riesgo_disposiciones');
    expect(rows).toHaveLength(0);
  });

  it('con un `evidenciaFileId` real entra', async () => {
    await sembrar();
    const f = await query<{ id: string }>(
      `INSERT INTO files (kind, original_name, storage_path, content_hash, size_bytes, uploaded_by)
       VALUES ('manifest','carta.pdf','/tmp/carta.pdf','abc',10,$1) RETURNING id`,
      [adminId],
    );
    const res = await disponer('D-ROJO', {
      signalId: 'prohibidos',
      estado: 'mitigado',
      evidenciaFileId: f.rows[0].id,
    });
    expect(res.status).toBe(201);
  });

  it('un `evidenciaFileId` inexistente contesta 400 con una frase, no 500 con una constraint', async () => {
    await sembrar();
    const res = await disponer('D-ROJO', {
      signalId: 'prohibidos',
      estado: 'mitigado',
      evidenciaFileId: crypto.randomUUID(),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('evidenciaFileId');
  });

  it('un requerimiento de OTRO caso no sirve de respaldo', async () => {
    await sembrar();
    const otraOp = await query<{ id: string }>(
      `INSERT INTO operaciones (mawb, mawb_raw, etapa) VALUES ('160-99990003','160-99990003','prealerta') RETURNING id`,
    );
    const req0 = await query<{ id: string }>(
      `INSERT INTO riesgo_requerimientos (operacion_id, reason_codes, vence_at, created_by)
       VALUES ($1,'[]'::jsonb, now() + interval '3 hours', $2) RETURNING id`,
      [otraOp.rows[0].id, adminId],
    );
    const ajeno = await disponer('D-ROJO', {
      signalId: 'prohibidos',
      estado: 'mitigado',
      requerimientoId: req0.rows[0].id,
    });
    expect(ajeno.status).toBe(400);

    // …y el del caso de ESTE manifiesto sí.
    const propio = await query<{ id: string }>(
      `INSERT INTO riesgo_requerimientos (operacion_id, reason_codes, vence_at, created_by)
       VALUES ($1,'[]'::jsonb, now() + interval '3 hours', $2) RETURNING id`,
      [operacionId, adminId],
    );
    const ok = await disponer('D-ROJO', {
      signalId: 'prohibidos',
      estado: 'mitigado',
      requerimientoId: propio.rows[0].id,
    });
    expect(ok.status).toBe(201);
  });
});

// -------------------------------------------------------------------------------------------------
describe('retractarse es insertar', () => {
  it('`confirmado` + `supersedeA` devuelve el color del motor sin borrar nada', async () => {
    await sembrar();
    const primera = await disponer('D-ROJO', { signalId: 'prohibidos', estado: 'falso_positivo' });
    expect(primera.status).toBe(201);
    expect((await fila('D-ROJO')).risk_color_efectivo).toBe('verde');

    const retractacion = await disponer('D-ROJO', {
      signalId: 'prohibidos',
      estado: 'confirmado',
      motivo: 'me equivoqué: el hallazgo es real',
      supersedeA: primera.body.disposicionId,
    });
    expect(retractacion.status).toBe(201);
    expect(retractacion.body.resultado).toBe('rojo');

    const f = await fila('D-ROJO');
    // Sin disposición SUPRESORA vigente vuelve a mandar el motor; el `confirmado` sigue aplicando.
    expect(f.risk_color).toBe('rojo');
    expect(f.risk_color_efectivo).toBe('rojo');
    // Las dos filas siguen ahí: la tabla es el expediente, no el estado.
    const { rows } = await query<{ n: string }>('SELECT count(*)::int AS n FROM riesgo_disposiciones');
    expect(Number(rows[0].n)).toBe(2);
  });

  it('`supersedeA` que apunta a otro hallazgo se rechaza con 400', async () => {
    await sembrar();
    const otra = await disponer('D-AMARILLO', { signalId: 'cantidad', estado: 'falso_positivo' });
    expect(otra.status).toBe(201);
    const res = await disponer('D-ROJO', {
      signalId: 'prohibidos',
      estado: 'confirmado',
      supersedeA: otra.body.disposicionId,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('supersedeA');
  });
});

// -------------------------------------------------------------------------------------------------
describe('la tabla es append-only por trigger', () => {
  it('rechaza un UPDATE de contenido y un DELETE directo', async () => {
    await sembrar();
    const res = await disponer('D-ROJO', { signalId: 'prohibidos', estado: 'falso_positivo' });
    const id = res.body.disposicionId as string;

    await expect(
      query(`UPDATE riesgo_disposiciones SET motivo = 'otra cosa' WHERE id=$1`, [id]),
    ).rejects.toThrow(/append-only/);
    await expect(
      query(`UPDATE riesgo_disposiciones SET estado = 'confirmado' WHERE id=$1`, [id]),
    ).rejects.toThrow(/append-only/);
    await expect(query('DELETE FROM riesgo_disposiciones WHERE id=$1', [id])).rejects.toThrow(
      /append-only/,
    );

    const { rows } = await query<{ n: string }>('SELECT count(*)::int AS n FROM riesgo_disposiciones');
    expect(Number(rows[0].n)).toBe(1);
  });
});

// -------------------------------------------------------------------------------------------------
describe('evento y auditoría (§8)', () => {
  it('escribe un evento en el ledger y una fila de auditoría con before y after', async () => {
    await sembrar();
    const res = await disponer('D-ROJO', { signalId: 'prohibidos', estado: 'falso_positivo' });
    expect(res.body.eventoRegistrado).toBe(true);

    const ev = await eventos('RIESGO_HALLAZGO_DISPUESTO');
    expect(ev).toHaveLength(1);
    expect(ev[0].payload).toMatchObject({
      guia: 'D-ROJO',
      signalId: 'prohibidos',
      estado: 'falso_positivo',
      colorCrudo: 'rojo',
      colorEfectivo: 'verde',
      disposicionId: res.body.disposicionId,
      supersedeA: null,
    });
    // Claves y hashes, nunca valores de PII: el nombre que coincidió no viaja al ledger.
    expect(JSON.stringify(ev[0].payload)).not.toContain('pistola');

    const aud = await auditorias('RIESGO_DISPOSICION');
    expect(aud).toHaveLength(1);
    expect(aud[0].entity).toBe('shipment');
    expect(aud[0].before).toMatchObject({ riskColorEfectivo: null, suprimidas: [] });
    expect(aud[0].after).toMatchObject({
      disposicionId: res.body.disposicionId,
      signalId: 'prohibidos',
      colorCrudo: 'rojo',
      riskColorEfectivo: 'verde',
    });
  });

  it('un manifiesto SIN caso audita igual y no ensucia el ledger con filas huérfanas', async () => {
    await query('DELETE FROM operaciones WHERE id=$1', [operacionId]);
    await sembrar();
    const res = await disponer('D-ROJO', { signalId: 'prohibidos', estado: 'falso_positivo' });
    expect(res.status).toBe(201);
    expect(res.body.eventoRegistrado).toBe(false);
    expect(await eventos('RIESGO_HALLAZGO_DISPUESTO')).toHaveLength(0);
    expect(await auditorias('RIESGO_DISPOSICION')).toHaveLength(1);
  });
});

// -------------------------------------------------------------------------------------------------
describe('GET — el expediente completo, anotado', () => {
  it('la vigente aplica y la reemplazada no, y ninguna desaparece', async () => {
    await sembrar();
    const primera = await disponer('D-ROJO', { signalId: 'prohibidos', estado: 'falso_positivo' });
    const segunda = await disponer('D-ROJO', {
      signalId: 'prohibidos',
      estado: 'confirmado',
      supersedeA: primera.body.disposicionId,
    });

    const res = await historial();
    expect(res.status).toBe(200);
    const porId = Object.fromEntries(
      (res.body.disposiciones as Array<Record<string, unknown>>).map((d) => [d.id, d]),
    );
    expect(Object.keys(porId)).toHaveLength(2);
    expect(porId[segunda.body.disposicionId]).toMatchObject({
      aplicable: true,
      supersedida: false,
      caducada: false,
      revalidacionPendiente: false,
      estado: 'confirmado',
      signalId: 'prohibidos',
      guia: 'D-ROJO',
    });
    expect(porId[primera.body.disposicionId]).toMatchObject({
      aplicable: false,
      supersedida: true,
      caducada: false,
    });
  });

  it('`caducada` cuando el hallazgo desaparece — sin una sola escritura sobre la fila', async () => {
    await sembrar();
    const res = await disponer('D-ROJO', { signalId: 'prohibidos', estado: 'falso_positivo' });

    // La línea se corrige: ya no declara un artículo prohibido. Se vuelve a correr el motor.
    await query(
      `UPDATE shipments SET data = jsonb_set(data,'{description}','"camisa"')
        WHERE manifest_id=$1 AND data->>'guideId'='D-ROJO'`,
      [manifestId],
    );
    await correrRiesgo();

    const cuerpo = (await historial()).body.disposiciones as Array<Record<string, unknown>>;
    expect(cuerpo).toHaveLength(1);
    expect(cuerpo[0]).toMatchObject({ id: res.body.disposicionId, aplicable: false, caducada: true });
    // Y el color vuelve a mandarlo el motor: NULL significa "sin disposición".
    expect((await fila('D-ROJO')).risk_color_efectivo).toBeNull();
  });

  it('`revalidacionPendiente` en una señal graduada cuyo ruleset cambió, y caducidad en una forzada', async () => {
    await sembrar();
    const graduada = await disponer('D-AMARILLO', { signalId: 'cantidad', estado: 'falso_positivo' });
    const forzada = await disponer('D-ROJO', { signalId: 'prohibidos', estado: 'falso_positivo' });

    /**
     * La config se mueve DESPUÉS de las dos afirmaciones y el motor se vuelve a correr. Una marca de
     * piratería que no coincide con nada cambia `ruleset_hash` sin cambiar qué señales disparan, que
     * es exactamente el escenario a probar. No se puede falsear con un UPDATE sobre las
     * disposiciones: la tabla es append-only y el trigger lo rechaza.
     */
    const rulesetPrevio = (await fila('D-ROJO')).ruleset_hash;
    await query(`INSERT INTO config (key,value) VALUES ('piracy_brands',$1)`, [
      JSON.stringify(['UnaMarcaQueNoAparece']),
    ]);
    await correrRiesgo();
    expect((await fila('D-ROJO')).ruleset_hash).not.toBe(rulesetPrevio);

    const porId = Object.fromEntries(
      ((await historial()).body.disposiciones as Array<Record<string, unknown>>).map((d) => [d.id, d]),
    );
    // Graduada: sigue aplicando, marcada en ámbar. Invalidar cientos de afirmaciones cada vez que un
    // admin mueve un umbral sería castigo sin delito.
    expect(porId[graduada.body.disposicionId]).toMatchObject({
      aplicable: true,
      caducada: false,
      revalidacionPendiente: true,
    });
    // Forzada: caduca. Una afirmación contra la lista ANTERIOR no puede tapar un golpe contra la nueva.
    expect(porId[forzada.body.disposicionId]).toMatchObject({ aplicable: false, caducada: true });
  });

  it('cita el `hallazgo` verbatim y a su autor: es la pantalla del auditor', async () => {
    await sembrar();
    const f = await fila('D-ROJO');
    const razon = (f.risk_reasons ?? []).find((r) => r.signalId === 'prohibidos')!;
    await disponer('D-ROJO', { signalId: 'prohibidos', estado: 'falso_positivo' });

    const d = (await historial()).body.disposiciones[0] as Record<string, unknown>;
    expect(d.hallazgo).toEqual(razon);
    expect(d.createdByUsuario).toBe('dz_adm');
    expect(d.motivo).toBe('revisado con el cliente');
    expect(d.manifiestoVersion).toBe(1);
  });

  it('404 para un manifiesto que no existe', async () => {
    const res = await request(app)
      .get(`/api/manifests/${crypto.randomUUID()}/riesgo/disposiciones`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });
});

// -------------------------------------------------------------------------------------------------
describe('validación del cuerpo', () => {
  it('rechaza un `motivo` en blanco: un espacio satisface el notNull y no le dice nada a nadie', async () => {
    await sembrar();
    const res = await disponer('D-ROJO', { signalId: 'prohibidos', estado: 'falso_positivo', motivo: '   ' });
    expect(res.status).toBe(400);
  });

  it('rechaza una señal que no existe en el motor', async () => {
    await sembrar();
    const res = await disponer('D-ROJO', { signalId: 'inventada' as SignalId, estado: 'falso_positivo' });
    expect(res.status).toBe(400);
  });

  it('rechaza un `:id` de manifiesto que no es UUID', async () => {
    const res = await request(app)
      .get('/api/manifests/no-es-uuid/riesgo/disposiciones')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });
});
