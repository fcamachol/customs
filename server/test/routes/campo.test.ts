import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query } from '../../src/db/pool';
import { hashPassword } from '../../src/auth/password';
import { signToken } from '../../src/auth/token';
import { truncateAll } from '../helpers/db';

/**
 * Field-capture route tests (PRD-02 R11, R30–R35, §13).
 *
 * These assert the properties that make the tramitador's report usable as evidence rather than as a
 * status update, because each one corresponds to something the paper/Excel process got wrong:
 *
 *   - the recorded event time is the time the tramitador reports, NOT the time we received it
 *     (modulación is captured ~5 min late by design — phones are banned at the semáforo, R33)
 *   - facts that arrive out of order still land; facts that would rewind the operation do not
 *   - a retry from the offline queue is a no-op, never a duplicate row in the timeline
 *   - the two deltas anyone actually argues about — cita vs. real entry (R30) and time held in red
 *     (R35) — are computed on write, when the inputs are known
 *   - the photo lands hashed, in the ledger, and does NOT advance the operation on its own
 *
 * `FILE_STORAGE_DIR` is set before `storage/files.ts` is loaded (it resolves the directory once at
 * module scope), hence the dynamic import of the app below.
 */
const scratch = mkdtempSync(join(tmpdir(), 'campo-'));
process.env.FILE_STORAGE_DIR = scratch;

const { createApp } = await import('../../src/app');
const app = createApp();

/** A real 1×1 PNG. Real bytes on purpose: saveFile hashes them and the test asserts that hash. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DAAAAEAAF/9y0AAAAASUVORK5CYII=',
  'base64',
);

const MIN = 60 * 1000;
const iso = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString();

let tramitadorToken: string;
let autoridadToken: string;
let adminToken: string;
let opId: string;
let entregadaId: string;

/** Not `async`: returns the supertest Test so callers can chain `.expect(201)` or just await it. */
function evento(body: Record<string, unknown>, token = tramitadorToken) {
  return request(app)
    .post(`/api/campo/operaciones/${opId}/evento`)
    .set('Authorization', `Bearer ${token}`)
    .send(body);
}

async function etapaDe(id = opId) {
  const { rows } = await query<{
    etapa: string;
    semaforo: string | null;
    disponible_at: Date | null;
    modulacion_at: Date | null;
    salida_rojo_at: Date | null;
  }>(
    'SELECT etapa, semaforo, disponible_at, modulacion_at, salida_rojo_at FROM operaciones WHERE id=$1',
    [id],
  );
  return rows[0];
}

async function eventos(tipo?: string) {
  const { rows } = await query<{
    id: string;
    tipo: string;
    origen: string;
    ocurrido_at: Date;
    registrado_at: Date;
    payload: Record<string, unknown>;
    created_by: string | null;
    override: boolean;
  }>(
    `SELECT id, tipo, origen, ocurrido_at, registrado_at, payload, created_by, override
       FROM operacion_eventos
      WHERE operacion_id=$1 AND ($2::text IS NULL OR tipo=$2)
      ORDER BY id ASC`,
    [opId, tipo ?? null],
  );
  return rows;
}

beforeEach(async () => {
  await truncateAll();
  const hash = await hashPassword('p');
  const [tram, auto, adm] = await Promise.all([
    query<{ id: string }>(
      `INSERT INTO users (username,password_hash,role) VALUES ('tram1',$1,'tramitador') RETURNING id`,
      [hash],
    ),
    query<{ id: string }>(
      `INSERT INTO users (username,password_hash,role) VALUES ('auto1',$1,'autoridad') RETURNING id`,
      [hash],
    ),
    query<{ id: string }>(
      `INSERT INTO users (username,password_hash,role) VALUES ('adm1',$1,'admin') RETURNING id`,
      [hash],
    ),
  ]);
  tramitadorToken = signToken({ userId: tram.rows[0].id, role: 'tramitador', tv: 0 });
  autoridadToken = signToken({ userId: auto.rows[0].id, role: 'autoridad', tv: 0 });
  adminToken = signToken({ userId: adm.rows[0].id, role: 'admin', tv: 0 });

  const op = await query<{ id: string }>(
    `INSERT INTO operaciones (mawb, mawb_raw, numero_vuelo, etapa, arribo_vuelo_at)
     VALUES ('160-94705516','160-94705516','CI5215','arribado', now() - interval '2 hours')
     RETURNING id`,
  );
  opId = op.rows[0].id;

  const done = await query<{ id: string }>(
    `INSERT INTO operaciones (mawb, numero_vuelo, etapa) VALUES ('160-00000001','CI9999','entregado') RETURNING id`,
  );
  entregadaId = done.rows[0].id;
});

describe('campo — role gates (PRD-02 §13: least privilege for the most exposed role)', () => {
  it('lets the tramitador read his queue', async () => {
    await request(app)
      .get('/api/campo/tareas')
      .set('Authorization', `Bearer ${tramitadorToken}`)
      .expect(200);
  });

  it('refuses autoridad, which is read-only and must not write field facts', async () => {
    await request(app)
      .get('/api/campo/tareas')
      .set('Authorization', `Bearer ${autoridadToken}`)
      .expect(403);
    const res = await evento({ tipo: 'CARGA_DISPONIBLE' }, autoridadToken);
    expect(res.status).toBe(403);
  });

  it('refuses an unauthenticated request', async () => {
    await request(app).get('/api/campo/tareas').expect(401);
    await request(app).post(`/api/campo/operaciones/${opId}/evento`).send({ tipo: 'FIN_CARGA' }).expect(401);
  });

  it('lets an admin capture on the tramitador’s behalf (a missed capture fixed from the office)', async () => {
    const res = await evento({ tipo: 'CARGA_DISPONIBLE' }, adminToken);
    expect(res.status).toBe(201);
  });

  it('404s on an unknown operación and 400s on a malformed id', async () => {
    await request(app)
      .post('/api/campo/operaciones/00000000-0000-0000-0000-000000000000/evento')
      .set('Authorization', `Bearer ${tramitadorToken}`)
      .send({ tipo: 'FIN_CARGA' })
      .expect(404);
    await request(app)
      .post('/api/campo/operaciones/no-es-uuid/evento')
      .set('Authorization', `Bearer ${tramitadorToken}`)
      .send({ tipo: 'FIN_CARGA' })
      .expect(400);
  });
});

describe('CARGA_DISPONIBLE — the fact the warehouse never phones in (R11)', () => {
  it('advances the etapa, stamps disponible_at, and leaves a ledger + audit trail', async () => {
    const ocurridoAt = iso(20 * MIN);
    const res = await evento({ tipo: 'CARGA_DISPONIBLE', ocurridoAt, lat: 19.4361, lng: -99.0719 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ ok: true, etapaAnterior: 'arribado', etapa: 'disponible' });

    const op = await etapaDe();
    expect(op.etapa).toBe('disponible');
    expect(new Date(op.disponible_at!).toISOString()).toBe(ocurridoAt);

    const ev = await eventos('CARGA_DISPONIBLE');
    expect(ev).toHaveLength(1);
    expect(ev[0].origen).toBe('tramitador');
    expect(ev[0].created_by).toBeTruthy();
    expect(new Date(ev[0].ocurrido_at).toISOString()).toBe(ocurridoAt);
    expect(ev[0].payload).toMatchObject({ etapaAnterior: 'arribado', etapaNueva: 'disponible' });

    // The ledger row is mirrored into the audit hash chain, so one GET /api/audit/verify covers
    // logistics history as well as documentary history.
    const audit = await query<{ action: string; entity_id: string }>(
      `SELECT action, entity_id FROM audit_log WHERE action='CARGA_DISPONIBLE'`,
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].entity_id).toBe(opId);
  });

  it('records lat/lng where they were captured', async () => {
    await evento({ tipo: 'CARGA_DISPONIBLE', lat: 19.4361, lng: -99.0719 }).expect(201);
    const { rows } = await query<{ lat: string; lng: string }>(
      `SELECT lat, lng FROM operacion_eventos WHERE operacion_id=$1 AND tipo='CARGA_DISPONIBLE'`,
      [opId],
    );
    expect(Number(rows[0].lat)).toBeCloseTo(19.4361, 4);
    expect(Number(rows[0].lng)).toBeCloseTo(-99.0719, 4);
  });
});

describe('INGRESO_PATIO / INGRESO_ADUANA — ledger-only facts whose value is the delta (R30)', () => {
  it('computes demoraMin from citaAt for the entry into the aduana without touching the etapa', async () => {
    await evento({ tipo: 'CARGA_DISPONIBLE' }).expect(201);

    // Cited at 10:00, entered at 10:05 — the five minutes ARE the requirement.
    const res = await evento({
      tipo: 'INGRESO_ADUANA',
      citaAt: iso(35 * MIN),
      ocurridoAt: iso(30 * MIN),
    });
    expect(res.status).toBe(201);
    expect(res.body.payload).toMatchObject({ demoraMin: 5 });
    // The gate between disponible and en_carga is INICIO_CARGA, not the entry itself: a unit can sit
    // inside the aduana long before anyone starts loading it.
    expect(res.body.etapa).toBe('disponible');
    expect((await etapaDe()).etapa).toBe('disponible');

    const ev = await eventos('INGRESO_ADUANA');
    expect(ev).toHaveLength(1);
    expect(ev[0].payload).toMatchObject({ demoraMin: 5 });
    expect(ev[0].payload.citaAt).toBeTruthy();
  });

  it('reports a negative demoraMin when the unit arrives early', async () => {
    const res = await evento({ tipo: 'INGRESO_PATIO', citaAt: iso(10 * MIN), ocurridoAt: iso(25 * MIN) });
    expect(res.status).toBe(201);
    expect(res.body.payload.demoraMin).toBe(-15);
    expect(res.body.etapa).toBe('arribado');
  });

  it('records the patio entry with no citaAt and no demora', async () => {
    const res = await evento({ tipo: 'INGRESO_PATIO' });
    expect(res.status).toBe(201);
    expect(res.body.payload.demoraMin).toBeUndefined();
  });
});

describe('INICIO_CARGA / FIN_CARGA (R31)', () => {
  it('INICIO_CARGA is what asserts en_carga; FIN_CARGA leaves the etapa alone until modulación', async () => {
    await evento({ tipo: 'CARGA_DISPONIBLE' }).expect(201);
    await evento({ tipo: 'INICIO_CARGA' }).expect(201);
    expect((await etapaDe()).etapa).toBe('en_carga');

    await evento({ tipo: 'FIN_CARGA' }).expect(201);
    expect((await etapaDe()).etapa).toBe('en_carga');
    expect(await eventos('FIN_CARGA')).toHaveLength(1);
  });

  it('accepts a forward jump: a tramitador who never pressed disponible can still report the load', async () => {
    const res = await evento({ tipo: 'INICIO_CARGA' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ etapaAnterior: 'arribado', etapa: 'en_carga' });
  });
});

describe('MODULACION — the semáforo (R33/R34)', () => {
  it('green sends the operation to en_transito and persists the semáforo in English', async () => {
    const ocurridoAt = iso(5 * MIN);
    const res = await evento({ tipo: 'MODULACION', semaforo: 'green', ocurridoAt });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ etapa: 'en_transito', semaforo: 'green' });

    const op = await etapaDe();
    expect(op.etapa).toBe('en_transito');
    expect(op.semaforo).toBe('green');
    expect(new Date(op.modulacion_at!).toISOString()).toBe(ocurridoAt);
  });

  it('red sends it to reconocimiento', async () => {
    const res = await evento({ tipo: 'MODULACION', semaforo: 'red', ocurridoAt: iso(5 * MIN) });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ etapa: 'reconocimiento', semaforo: 'red' });
    const op = await etapaDe();
    expect(op.etapa).toBe('reconocimiento');
    expect(op.semaforo).toBe('red');
  });

  it('refuses a crossing with no result: MODULACION without semaforo → 400', async () => {
    const res = await evento({ tipo: 'MODULACION' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/semaforo/);
    expect((await etapaDe()).etapa).toBe('arribado');
    expect(await eventos()).toHaveLength(0);
  });

  it('refuses a localized semáforo — the value is client-facing and stays in English (D16)', async () => {
    const res = await evento({ tipo: 'MODULACION', semaforo: 'verde' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/green/);
  });

  it('honours a deferred capture: ocurrido_at is the reported time, registrado_at is ours', async () => {
    const ocurridoAt = iso(7 * MIN);
    await evento({ tipo: 'MODULACION', semaforo: 'green', ocurridoAt }).expect(201);

    const ev = (await eventos('MODULACION'))[0];
    expect(new Date(ev.ocurrido_at).toISOString()).toBe(ocurridoAt);
    // Not merely different: the reported time must be EARLIER, which is the whole deferred-capture
    // design (no phones at the semáforo, so the fact is always older than its registration).
    expect(new Date(ev.ocurrido_at).getTime()).toBeLessThan(new Date(ev.registrado_at).getTime());
  });
});

describe('SALIDA_ROJO — the time-in-red KPI (R35)', () => {
  it('computes tiempoEnRojoMin from modulacion_at and releases the operation to en_transito', async () => {
    await evento({ tipo: 'MODULACION', semaforo: 'red', ocurridoAt: iso(125 * MIN) }).expect(201);

    const res = await evento({ tipo: 'SALIDA_ROJO', ocurridoAt: iso(5 * MIN) });
    expect(res.status).toBe(201);
    expect(res.body.etapa).toBe('en_transito');
    expect(res.body.payload.tiempoEnRojoMin).toBe(120);

    const op = await etapaDe();
    expect(op.etapa).toBe('en_transito');
    expect(op.salida_rojo_at).toBeTruthy();
    expect((await eventos('SALIDA_ROJO'))[0].payload).toMatchObject({ tiempoEnRojoMin: 120 });
  });

  it('refuses a salida de rojo from any other etapa → 409 with the current etapa', async () => {
    const res = await evento({ tipo: 'SALIDA_ROJO' });
    expect(res.status).toBe(409);
    expect(res.body.etapaActual).toBe('arribado');
    expect(res.body.error).toMatch(/reconocimiento/);
    expect(await eventos()).toHaveLength(0);
  });

  it('refuses it after a green modulación too — there was never a red to exit', async () => {
    await evento({ tipo: 'MODULACION', semaforo: 'green' }).expect(201);
    const res = await evento({ tipo: 'SALIDA_ROJO' });
    expect(res.status).toBe(409);
    expect(res.body.etapaActual).toBe('en_transito');
  });
});

describe('monotonicity and idempotency (the two rules that keep the timeline honest)', () => {
  it('refuses a regression: INICIO_CARGA after en_transito → 409 with etapaActual', async () => {
    await evento({ tipo: 'MODULACION', semaforo: 'green' }).expect(201);
    const res = await evento({ tipo: 'INICIO_CARGA' });
    expect(res.status).toBe(409);
    expect(res.body.etapaActual).toBe('en_transito');
    expect(res.body.error).toMatch(/mon[oó]tono/i);
    expect(await eventos('INICIO_CARGA')).toHaveLength(0);
  });

  it('treats a repeat of the same etapa as a no-op and writes no second ledger event', async () => {
    await evento({ tipo: 'CARGA_DISPONIBLE' }).expect(201);
    const antes = await eventos();

    const res = await evento({ tipo: 'CARGA_DISPONIBLE' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, noop: true, etapa: 'disponible' });

    // The offline queue in CampoView retries; a retry must not duplicate the timeline.
    expect(await eventos()).toHaveLength(antes.length);
    const audit = await query(`SELECT id FROM audit_log WHERE action='CARGA_DISPONIBLE'`);
    expect(audit.rows).toHaveLength(1);
  });
});

describe('input the ledger must refuse', () => {
  it('rejects an ocurridoAt more than 10 minutes in the future', async () => {
    const res = await evento({ tipo: 'FIN_CARGA', ocurridoAt: new Date(Date.now() + 60 * MIN).toISOString() });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/futuro/);
    expect(await eventos()).toHaveLength(0);
  });

  it('accepts small clock drift into the future — a phone is not a chronometer', async () => {
    await evento({ tipo: 'FIN_CARGA', ocurridoAt: new Date(Date.now() + 2 * MIN).toISOString() }).expect(201);
  });

  it('rejects an ocurridoAt older than 48 hours', async () => {
    const res = await evento({ tipo: 'FIN_CARGA', ocurridoAt: iso(72 * 60 * MIN) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/48 horas/);
  });

  it('rejects an override with no motivo', async () => {
    const res = await evento({ tipo: 'CARGA_DISPONIBLE', override: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/motivo/);
    expect(await eventos()).toHaveLength(0);

    const blank = await evento({ tipo: 'CARGA_DISPONIBLE', override: true, motivo: '   ' });
    expect(blank.status).toBe(400);
  });

  it('accepts an override that states its motivo, and stores both', async () => {
    await evento({
      tipo: 'CARGA_DISPONIBLE',
      override: true,
      motivo: 'El almacén avisó por teléfono; la app no tenía señal.',
    }).expect(201);
    const ev = (await eventos('CARGA_DISPONIBLE'))[0];
    expect(ev.override).toBe(true);
    const { rows } = await query<{ motivo: string }>(
      `SELECT motivo FROM operacion_eventos WHERE id=$1`, [ev.id],
    );
    expect(rows[0].motivo).toMatch(/tel[eé]fono/);
  });

  it('rejects an unknown tipo', async () => {
    const res = await evento({ tipo: 'INVENTADO' });
    expect(res.status).toBe(400);
  });
});

describe('evidencia — the photo Alfonso demanded (R32/D5)', () => {
  it('stores the file with its sha256, the evidencia row and a ledger event', async () => {
    const capturadoAt = iso(3 * MIN);
    const res = await request(app)
      .post(`/api/campo/operaciones/${opId}/evidencia`)
      .set('Authorization', `Bearer ${tramitadorToken}`)
      .field('tipo', 'inicio_carga')
      .field('capturadoAt', capturadoAt)
      .field('lat', '19.4361')
      .field('lng', '-99.0719')
      .field('deviceId', 'pixel-de-jorge')
      .attach('file', PNG, 'carga.png');

    expect(res.status).toBe(201);
    const esperado = createHash('sha256').update(PNG).digest('hex');
    expect(res.body.contentHash).toBe(esperado);

    const file = await query<{ kind: string; content_hash: string; size_bytes: number }>(
      'SELECT kind, content_hash, size_bytes FROM files WHERE id=$1', [res.body.fileId],
    );
    expect(file.rows[0]).toMatchObject({ kind: 'evidencia', content_hash: esperado });
    expect(Number(file.rows[0].size_bytes)).toBe(PNG.length);

    const ev = await query<{
      tipo: string; file_id: string; evento_id: string; device_id: string;
      capturado_at: Date; registrado_at: Date; lat: string; lng: string;
    }>(
      `SELECT tipo, file_id, evento_id, device_id, capturado_at, registrado_at, lat, lng
         FROM operacion_evidencias WHERE id=$1`,
      [res.body.evidenciaId],
    );
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0]).toMatchObject({ tipo: 'inicio_carga', file_id: res.body.fileId, device_id: 'pixel-de-jorge' });
    // Device clock vs. server clock, kept apart exactly as ocurrido_at/registrado_at are.
    expect(new Date(ev.rows[0].capturado_at).toISOString()).toBe(capturadoAt);
    expect(new Date(ev.rows[0].registrado_at).getTime()).toBeGreaterThan(
      new Date(ev.rows[0].capturado_at).getTime(),
    );
    expect(ev.rows[0].evento_id).toBe(res.body.eventoId);

    const ledger = await eventos('EVIDENCIA_CAPTURADA');
    expect(ledger).toHaveLength(1);
    expect(ledger[0].payload).toMatchObject({
      tipo: 'inicio_carga',
      fileId: res.body.fileId,
      contentHash: esperado,
    });
    expect(ledger[0].origen).toBe('tramitador');

    const audit = await query(`SELECT id FROM audit_log WHERE action='EVIDENCIA_CAPTURADA'`);
    expect(audit.rows).toHaveLength(1);

    // Evidence corroborates a fact, it does not assert one: the etapa is untouched.
    expect((await etapaDe()).etapa).toBe('arribado');
  });

  it('links the photo to a prior field event when one is named', async () => {
    const inicio = await evento({ tipo: 'INICIO_CARGA' });
    expect(inicio.status).toBe(201);

    const res = await request(app)
      .post(`/api/campo/operaciones/${opId}/evidencia`)
      .set('Authorization', `Bearer ${tramitadorToken}`)
      .field('tipo', 'inicio_carga')
      .field('capturadoAt', iso(MIN))
      .field('eventoId', inicio.body.eventoId)
      .attach('file', PNG, 'carga.png');
    expect(res.status).toBe(201);

    const { rows } = await query<{ evento_id: string }>(
      'SELECT evento_id FROM operacion_evidencias WHERE id=$1', [res.body.evidenciaId],
    );
    expect(rows[0].evento_id).toBe(inicio.body.eventoId);
  });

  it('refuses an eventoId belonging to another operación', async () => {
    const otro = await query<{ id: string }>(
      `INSERT INTO operacion_eventos (operacion_id, operacion_mawb, tipo, origen, ocurrido_at)
       VALUES ($1,'160-00000001','FIN_CARGA','tramitador',now()) RETURNING id`,
      [entregadaId],
    );
    const res = await request(app)
      .post(`/api/campo/operaciones/${opId}/evidencia`)
      .set('Authorization', `Bearer ${tramitadorToken}`)
      .field('tipo', 'otro')
      .field('capturadoAt', iso(MIN))
      .field('eventoId', String(otro.rows[0].id))
      .attach('file', PNG, 'x.png');
    expect(res.status).toBe(400);
  });

  it('refuses a content type that is not an image or a PDF', async () => {
    const res = await request(app)
      .post(`/api/campo/operaciones/${opId}/evidencia`)
      .set('Authorization', `Bearer ${tramitadorToken}`)
      .field('tipo', 'inicio_carga')
      .field('capturadoAt', iso(MIN))
      .attach('file', Buffer.from('#!/bin/sh\nrm -rf /\n'), {
        filename: 'evidencia.sh',
        contentType: 'application/x-sh',
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no permitido/);
    expect((await query('SELECT id FROM operacion_evidencias')).rows).toHaveLength(0);
    expect((await query(`SELECT id FROM files WHERE kind='evidencia'`)).rows).toHaveLength(0);
  });

  it('refuses an upload with no file and one with no capturadoAt', async () => {
    await request(app)
      .post(`/api/campo/operaciones/${opId}/evidencia`)
      .set('Authorization', `Bearer ${tramitadorToken}`)
      .field('tipo', 'inicio_carga')
      .field('capturadoAt', iso(MIN))
      .expect(400);

    await request(app)
      .post(`/api/campo/operaciones/${opId}/evidencia`)
      .set('Authorization', `Bearer ${tramitadorToken}`)
      .field('tipo', 'inicio_carga')
      .attach('file', PNG, 'x.png')
      .expect(400);
  });

  it('refuses autoridad', async () => {
    await request(app)
      .post(`/api/campo/operaciones/${opId}/evidencia`)
      .set('Authorization', `Bearer ${autoridadToken}`)
      .field('tipo', 'otro')
      .field('capturadoAt', iso(MIN))
      .attach('file', PNG, 'x.png')
      .expect(403);
  });
});

describe('GET /api/campo/tareas — the tramitador queue', () => {
  it('returns what is physically in play and excludes what is already delivered', async () => {
    const res = await request(app)
      .get('/api/campo/tareas')
      .set('Authorization', `Bearer ${tramitadorToken}`)
      .expect(200);

    const ids = res.body.map((r: { id: string }) => r.id);
    expect(ids).toContain(opId);
    expect(ids).not.toContain(entregadaId);

    const tarea = res.body.find((r: { id: string }) => r.id === opId);
    expect(tarea).toMatchObject({ mawb: '160-94705516', etapa: 'arribado', numeroVuelo: 'CI5215' });
    expect(tarea.arriboVueloAt).toBeTruthy();
  });

  it('keeps an operación in the queue as it moves through the field etapas', async () => {
    for (const [tipo, extra] of [
      ['CARGA_DISPONIBLE', {}],
      ['INICIO_CARGA', {}],
      ['MODULACION', { semaforo: 'red' }],
    ] as Array<[string, Record<string, unknown>]>) {
      await evento({ tipo, ...extra }).expect(201);
      const res = await request(app)
        .get('/api/campo/tareas')
        .set('Authorization', `Bearer ${tramitadorToken}`)
        .expect(200);
      expect(res.body.map((r: { id: string }) => r.id)).toContain(opId);
    }

    // Out of red and into transit: no longer the tramitador's problem.
    await evento({ tipo: 'SALIDA_ROJO' }).expect(201);
    const res = await request(app)
      .get('/api/campo/tareas')
      .set('Authorization', `Bearer ${tramitadorToken}`)
      .expect(200);
    expect(res.body.map((r: { id: string }) => r.id)).not.toContain(opId);
  });

  it('sorts by arrival with NULLS LAST so shipments with no arrival data do not head the queue', async () => {
    await query(
      `INSERT INTO operaciones (mawb, etapa, arribo_vuelo_at) VALUES ('160-00000002','arribado', NULL)`,
    );
    await query(
      `INSERT INTO operaciones (mawb, etapa, arribo_vuelo_at)
       VALUES ('160-00000003','arribado', now() - interval '6 hours')`,
    );
    const res = await request(app)
      .get('/api/campo/tareas')
      .set('Authorization', `Bearer ${tramitadorToken}`)
      .expect(200);
    const mawbs = res.body.map((r: { mawb: string }) => r.mawb);
    expect(mawbs[0]).toBe('160-00000003');
    expect(mawbs[mawbs.length - 1]).toBe('160-00000002');
  });
});
