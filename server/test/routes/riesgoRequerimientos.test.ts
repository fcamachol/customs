import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { query } from '../../src/db/pool';
import { hashPassword } from '../../src/auth/password';
import { signToken } from '../../src/auth/token';
import { truncateAll } from '../helpers/db';

/**
 * RIESGO REQUERIMIENTOS — the risk→client bridge with a hard deadline (PRD-02 R18/D13) and its CT-4
 * expiry.
 *
 * What these tests defend, in order of how expensive it would be to get wrong:
 *
 *   - **The clock does not run against somebody who was never told.** A requerimiento whose
 *     notification was skipped (SMTP unprovisioned, #22) is NEVER expired, no matter how far past its
 *     deadline it is. Expiring it would freeze a client's cargo for missing a deadline they were
 *     never given — the failure with legal consequence the plan's risk register calls out by name.
 *   - The deadline is `eta_pais + ventana` (D13), re-derivable from the row, and a caso with no ETA
 *     is refused rather than given a deadline invented from `now()`.
 *   - Expiry opens exactly ONE `riesgo` hold (CT-4), reusing an already-open one instead of stacking
 *     a second freeze that outlives the first release.
 *   - Resolution lifts the freeze it caused — by `hold_id`, not by guessing at the tipo — but only
 *     when it was the LAST outstanding requerimiento. A half-answered demand keeps the cargo parked.
 *   - Late resolution is accepted (§8.4 `riesgo_vencido → riesgo_ok`), and the ledger records that it
 *     was late.
 *   - Every act writes exactly one append-only `operacion_eventos` row and one audit row.
 *
 * The mailer is mocked, and its DEFAULT is the unconfigured production reality of today: `omitido`.
 */
const sendMail = vi.fn(
  async (_msg: { to: string; subject: string; text: string }) =>
    ({ status: 'omitido', motivo: 'SMTP no configurado (SMTP_HOST/SMTP_FROM)' }) as unknown,
);
vi.mock('../../src/services/mailer', () => ({
  sendMail: (msg: { to: string; subject: string; text: string }) => sendMail(msg),
  loadMailerConfig: () => null,
  mailerConfigurado: () => false,
  resetMailer: () => undefined,
}));

const { createApp } = await import('../../src/app');
const { runRequerimientosSweep, calcularVenceAt, ventanaHorasPorDefecto, resolverDestinatario, construirCorreoRequerimiento } =
  await import('../../src/services/requerimientosService');
const app = createApp();

const OMITIDO = { status: 'omitido', motivo: 'SMTP no configurado (SMTP_HOST/SMTP_FROM)' };
const ENVIADO = {
  status: 'enviado',
  destinatario: 'client@example.com',
  messageId: '<x@customs>',
  aceptados: ['client@example.com'],
  rechazados: [],
};

let adminToken: string;
let capturistaToken: string;
let tramitadorToken: string;
let autoridadToken: string;

let opConEta: string;
let opSinEta: string;
let guiaA: string;
let guiaOtra: string;

/** ETA far enough out that a freshly emitted requerimiento is never accidentally overdue. */
const ETA = new Date(Date.now() + 24 * 3_600_000);

async function requerimientoRow(id: string) {
  const { rows } = await query<Record<string, any>>('SELECT * FROM riesgo_requerimientos WHERE id = $1', [id]);
  return rows[0];
}

async function eventosDe(operacionId: string, tipo?: string) {
  const { rows } = await query<{ tipo: string; origen: string; payload: Record<string, unknown> }>(
    `SELECT tipo, origen, payload FROM operacion_eventos
      WHERE operacion_id = $1 AND ($2::text IS NULL OR tipo = $2) ORDER BY id ASC`,
    [operacionId, tipo ?? null],
  );
  return rows;
}

async function auditoriasDe(action: string) {
  const { rows } = await query<{ entity_id: string; after: Record<string, unknown> }>(
    'SELECT entity_id, after FROM audit_log WHERE action = $1 ORDER BY id ASC',
    [action],
  );
  return rows;
}

async function operacion(id: string) {
  const { rows } = await query<{ hold_activo: boolean; estado_documental: string }>(
    'SELECT hold_activo, estado_documental FROM operaciones WHERE id = $1',
    [id],
  );
  return rows[0];
}

async function holdsDe(operacionId: string) {
  const { rows } = await query<{ id: string; tipo: string; activo: boolean; motivo: string }>(
    'SELECT id, tipo, activo, motivo FROM operacion_holds WHERE operacion_id = $1 ORDER BY abierto_at ASC',
    [operacionId],
  );
  return rows;
}

function emitir(opId: string, body: Record<string, unknown>, token = capturistaToken) {
  return request(app)
    .post(`/api/operaciones/${opId}/riesgo-requerimientos`)
    .set('Authorization', `Bearer ${token}`)
    .send(body);
}

const HALLAZGOS = [{ signalId: 'monto', points: 40, weight: 40, detail: 'declared value below floor' }];

/** Emit and then force the row past its deadline, optionally pretending the client was notified. */
async function emitirVencido(opId: string, opts: { notificado: boolean }): Promise<string> {
  const res = await emitir(opId, { reasonCodes: HALLAZGOS, rulesetVersion: '2026-07b' }).expect(201);
  const id = res.body.requerimientoId as string;
  await query(
    `UPDATE riesgo_requerimientos
        SET vence_at = now() - interval '1 hour',
            notificado_at = CASE WHEN $2::boolean THEN now() - interval '5 hours' ELSE NULL END,
            notificacion_estado = CASE WHEN $2::boolean THEN 'enviada' ELSE notificacion_estado END
      WHERE id = $1`,
    [id, opts.notificado],
  );
  return id;
}

beforeEach(async () => {
  await truncateAll();
  vi.clearAllMocks();
  sendMail.mockResolvedValue(OMITIDO);

  const hash = await hashPassword('p');
  const [adm, cap, tram, auto] = await Promise.all([
    query<{ id: string }>(`INSERT INTO users (username,password_hash,role) VALUES ('rq_adm',$1,'admin') RETURNING id`, [hash]),
    query<{ id: string }>(`INSERT INTO users (username,password_hash,role) VALUES ('rq_cap',$1,'capturista') RETURNING id`, [hash]),
    query<{ id: string }>(`INSERT INTO users (username,password_hash,role) VALUES ('rq_tra',$1,'tramitador') RETURNING id`, [hash]),
    query<{ id: string }>(`INSERT INTO users (username,password_hash,role) VALUES ('rq_aut',$1,'autoridad') RETURNING id`, [hash]),
  ]);
  adminToken = signToken({ userId: adm.rows[0].id, role: 'admin', tv: 0 });
  capturistaToken = signToken({ userId: cap.rows[0].id, role: 'capturista', tv: 0 });
  tramitadorToken = signToken({ userId: tram.rows[0].id, role: 'tramitador', tv: 0 });
  autoridadToken = signToken({ userId: auto.rows[0].id, role: 'autoridad', tv: 0 });

  const cliente = await query<{ id: string }>(
    `INSERT INTO clients (name, email) VALUES ('Cliente Demo','client@example.com') RETURNING id`,
  );

  const ops = await query<{ id: string; mawb: string }>(
    `INSERT INTO operaciones (mawb, mawb_raw, etapa, estado_documental, eta_pais, client_id) VALUES
       ('160-77770001','160-77770001','en_vuelo','riesgo_con_hallazgos',$1,$2),
       ('160-77770002','160-77770002','prealerta','riesgo_con_hallazgos',NULL,$2)
     RETURNING id, mawb`,
    [ETA.toISOString(), cliente.rows[0].id],
  );
  opConEta = ops.rows.find((r) => r.mawb === '160-77770001')!.id;
  opSinEta = ops.rows.find((r) => r.mawb === '160-77770002')!.id;

  const guias = await query<{ id: string; guia_norm: string }>(
    `INSERT INTO operacion_guias (operacion_id, guia_norm, guia_raw, piezas, estado) VALUES
       ($1,'HAWB0001','HAWB-0001',100,'declarada'),
       ($2,'HAWB0002','HAWB-0002',50,'declarada')
     RETURNING id, guia_norm`,
    [opConEta, opSinEta],
  );
  guiaA = guias.rows.find((r) => r.guia_norm === 'HAWB0001')!.id;
  guiaOtra = guias.rows.find((r) => r.guia_norm === 'HAWB0002')!.id;
});

// -------------------------------------------------------------------------------------------------
describe('deadline arithmetic (R18/D13)', () => {
  it('defaults the offload window to the 3 h PRD-02 assumption and honours the override', () => {
    const original = process.env.REQUERIMIENTO_VENTANA_HORAS;
    delete process.env.REQUERIMIENTO_VENTANA_HORAS;
    expect(ventanaHorasPorDefecto()).toBe(3);
    process.env.REQUERIMIENTO_VENTANA_HORAS = '6';
    expect(ventanaHorasPorDefecto()).toBe(6);
    process.env.REQUERIMIENTO_VENTANA_HORAS = 'no-es-un-numero';
    expect(ventanaHorasPorDefecto()).toBe(3);
    if (original === undefined) delete process.env.REQUERIMIENTO_VENTANA_HORAS;
    else process.env.REQUERIMIENTO_VENTANA_HORAS = original;
  });

  it('adds the window to the ETA', () => {
    const eta = new Date('2026-08-10T00:00:00.000Z');
    expect(calcularVenceAt(eta, 3).toISOString()).toBe('2026-08-10T03:00:00.000Z');
  });
});

describe('recipient resolution', () => {
  it('prefers the address chosen on the requerimiento, then the client, then the prealerta sender', () => {
    expect(
      resolverDestinatario({ destinatario_email: 'a@x.com', cliente_email: 'b@x.com', remitente: 'c@x.com' }),
    ).toBe('a@x.com');
    expect(resolverDestinatario({ destinatario_email: null, cliente_email: 'b@x.com', remitente: 'c@x.com' })).toBe('b@x.com');
    expect(resolverDestinatario({ destinatario_email: null, cliente_email: '  ', remitente: 'c@x.com' })).toBe('c@x.com');
    expect(resolverDestinatario({ destinatario_email: null, cliente_email: null, remitente: null })).toBeNull();
  });
});

describe('the client-facing message (N6, English, explicit deadline)', () => {
  it('states the deadline and the consequence, and quotes the findings', () => {
    const { subject, text } = construirCorreoRequerimiento({
      mawb: '160-77770001',
      guia_norm: 'HAWB0001',
      vence_at: new Date('2026-08-10T03:00:00.000Z'),
      reason_codes: HALLAZGOS,
      detalle: null,
      ruleset_version: '2026-07b',
    });
    expect(subject).toMatch(/ACTION REQUIRED/);
    expect(text).toContain('DEADLINE: 2026-08-10 03:00 UTC.');
    expect(text).toContain('declared value below floor');
    expect(text).toMatch(/placed on hold/);
  });
});

// -------------------------------------------------------------------------------------------------
describe('emission — role gates and routing', () => {
  it('lets a capturista emit and refuses the tramitador', async () => {
    await emitir(opConEta, { reasonCodes: HALLAZGOS }).expect(201);
    await emitir(opConEta, { reasonCodes: HALLAZGOS }, tramitadorToken).expect(403);
  });

  it('does not let /api/operaciones/:id/riesgo-requerimientos be shadowed by the operaciones detail route', async () => {
    await emitir(opConEta, { reasonCodes: HALLAZGOS }).expect(201);
    const res = await request(app)
      .get(`/api/operaciones/${opConEta}/riesgo-requerimientos`)
      .set('Authorization', `Bearer ${autoridadToken}`)
      .expect(200);
    expect(res.body).toHaveLength(1);
  });

  it('answers 400, never 500, for a non-uuid operación id', async () => {
    await request(app)
      .get('/api/operaciones/no-un-uuid/riesgo-requerimientos')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
  });

  it('404s for an operación that does not exist', async () => {
    await emitir('11111111-1111-1111-1111-111111111111', { reasonCodes: HALLAZGOS }).expect(404);
  });
});

describe('emission — what the demand must say', () => {
  it('refuses a requerimiento that states neither findings nor a detalle', async () => {
    await emitir(opConEta, { reasonCodes: [] }).expect(400);
  });

  it('accepts a free-text detalle when the findings are not machine-readable', async () => {
    await emitir(opConEta, { detalle: 'Commercial invoice does not match the AWB.' }).expect(201);
  });

  it('derives the deadline from eta_pais + the window and stores both so it stays re-derivable', async () => {
    const res = await emitir(opConEta, { reasonCodes: HALLAZGOS, ventanaHoras: 5 }).expect(201);
    const row = await requerimientoRow(res.body.requerimientoId);
    expect(new Date(row.vence_at).getTime()).toBe(ETA.getTime() + 5 * 3_600_000);
    expect(Number(row.ventana_horas)).toBe(5);
    expect(new Date(row.eta_base).getTime()).toBe(ETA.getTime());
  });

  it('refuses a caso with no ETA instead of inventing a deadline from now()', async () => {
    const res = await emitir(opSinEta, { reasonCodes: HALLAZGOS }).expect(400);
    expect(res.body.error).toMatch(/venceAt/);
  });

  it('accepts an explicit venceAt for a caso with no ETA', async () => {
    const venceAt = new Date(Date.now() + 12 * 3_600_000).toISOString();
    const res = await emitir(opSinEta, { reasonCodes: HALLAZGOS, venceAt }).expect(201);
    const row = await requerimientoRow(res.body.requerimientoId);
    expect(new Date(row.vence_at).toISOString()).toBe(venceAt);
    // No window: the deadline was given, not derived.
    expect(row.ventana_horas).toBeNull();
  });

  it('refuses a guía that belongs to another caso', async () => {
    const res = await emitir(opConEta, { reasonCodes: HALLAZGOS, operacionGuiaId: guiaOtra }).expect(400);
    expect(res.body.error).toMatch(/no pertenece/);
  });

  it('refuses an unknown shipmentId with a sentence rather than a constraint violation', async () => {
    const res = await emitir(opConEta, {
      reasonCodes: HALLAZGOS,
      shipmentId: '22222222-2222-2222-2222-222222222222',
    }).expect(400);
    expect(res.body.error).toMatch(/shipmentId/);
  });

  it('writes one ledger event and one audit row, quoting the ruleset version', async () => {
    const res = await emitir(opConEta, {
      reasonCodes: HALLAZGOS,
      rulesetVersion: '2026-07b',
      rulesetHash: 'deadbeef',
      operacionGuiaId: guiaA,
    }).expect(201);

    const eventos = await eventosDe(opConEta, 'REQUERIMIENTO_EMITIDO');
    expect(eventos).toHaveLength(1);
    expect(eventos[0].origen).toBe('coordinador');
    expect(eventos[0].payload).toMatchObject({
      requerimientoId: res.body.requerimientoId,
      guia: 'HAWB0001',
      rulesetVersion: '2026-07b',
      hallazgos: ['monto'],
    });

    const audit = await auditoriasDe('REQUERIMIENTO_EMITIDO');
    expect(audit).toHaveLength(1);
    expect(audit[0].entity_id).toBe(res.body.requerimientoId);

    const row = await requerimientoRow(res.body.requerimientoId);
    expect(row.ruleset_hash).toBe('deadbeef');
    expect(row.reason_codes).toEqual(HALLAZGOS);
  });
});

// -------------------------------------------------------------------------------------------------
describe('the unconfigured-SMTP path (#22 not provisioned)', () => {
  it('still creates the requerimiento, and says out loud that the client was NOT notified', async () => {
    const res = await emitir(opConEta, { reasonCodes: HALLAZGOS }).expect(201);
    expect(res.body.notificacion).toEqual({
      estado: 'omitido',
      detalle: 'SMTP no configurado (SMTP_HOST/SMTP_FROM)',
    });

    const row = await requerimientoRow(res.body.requerimientoId);
    expect(row.estado).toBe('abierto');
    expect(row.notificacion_estado).toBe('omitida');
    // THE gate: no delivery, so no clock.
    expect(row.notificado_at).toBeNull();
    expect(row.notificacion_detalle).toMatch(/SMTP no configurado/);
    expect(row.notificacion_intentos).toBe(1);
  });

  it('records `error` distinctly from `omitida` when the mail server is reachable but fails', async () => {
    sendMail.mockResolvedValue({ status: 'error', error: 'ECONNREFUSED' });
    const res = await emitir(opConEta, { reasonCodes: HALLAZGOS }).expect(201);
    const row = await requerimientoRow(res.body.requerimientoId);
    expect(row.notificacion_estado).toBe('error');
    expect(row.notificado_at).toBeNull();
  });

  it('records the address and the timestamp once the send succeeds', async () => {
    sendMail.mockResolvedValue(ENVIADO);
    const res = await emitir(opConEta, { reasonCodes: HALLAZGOS }).expect(201);
    expect(res.body.notificacion.estado).toBe('enviado');
    const row = await requerimientoRow(res.body.requerimientoId);
    expect(row.notificacion_estado).toBe('enviada');
    expect(row.notificado_at).not.toBeNull();
    expect(row.destinatario_email).toBe('client@example.com');
  });

  it('omits the send when the caso has no client email and no prealerta sender', async () => {
    await query('UPDATE operaciones SET client_id = NULL WHERE id = $1', [opConEta]);
    const res = await emitir(opConEta, { reasonCodes: HALLAZGOS }).expect(201);
    expect(res.body.notificacion.estado).toBe('omitido');
    expect(sendMail).not.toHaveBeenCalled();
    const row = await requerimientoRow(res.body.requerimientoId);
    expect(row.notificacion_detalle).toMatch(/sin destinatario/);
  });

  it('POST /notificar retries and does not restart a clock that is already running', async () => {
    sendMail.mockResolvedValue(ENVIADO);
    const res = await emitir(opConEta, { reasonCodes: HALLAZGOS }).expect(201);
    const primero = (await requerimientoRow(res.body.requerimientoId)).notificado_at;

    await request(app)
      .post(`/api/riesgo-requerimientos/${res.body.requerimientoId}/notificar`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const row = await requerimientoRow(res.body.requerimientoId);
    expect(new Date(row.notificado_at).getTime()).toBe(new Date(primero).getTime());
    expect(row.notificacion_intentos).toBe(2);
  });
});

// -------------------------------------------------------------------------------------------------
describe('CT-4 expiry sweep', () => {
  it('NEVER expires a requerimiento the client was never notified about, however overdue', async () => {
    // The single most important assertion in this file. Freezing cargo over a deadline that was never
    // communicated is the legal failure the whole notification-gating design exists to prevent.
    const id = await emitirVencido(opConEta, { notificado: false });

    const resumen = await runRequerimientosSweep();
    expect(resumen.vencidos).toBe(0);

    const row = await requerimientoRow(id);
    expect(row.estado).toBe('abierto');
    expect(await holdsDe(opConEta)).toHaveLength(0);
    expect((await operacion(opConEta)).hold_activo).toBe(false);
  });

  it('expires a notified, overdue requerimiento: hold de riesgo, riesgo_vencido, ledger, audit', async () => {
    const id = await emitirVencido(opConEta, { notificado: true });

    const resumen = await runRequerimientosSweep();
    expect(resumen.vencidos).toBe(1);
    expect(resumen.detalle[0]).toMatchObject({ requerimientoId: id, holdReutilizado: false });

    const row = await requerimientoRow(id);
    expect(row.estado).toBe('vencido');
    expect(row.vencido_at).not.toBeNull();
    expect(row.hold_id).not.toBeNull();

    const holds = await holdsDe(opConEta);
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({ tipo: 'riesgo', activo: true });
    expect(holds[0].motivo).toMatch(/CT-4/);

    const op = await operacion(opConEta);
    expect(op.hold_activo).toBe(true);
    expect(op.estado_documental).toBe('riesgo_vencido');

    const eventos = await eventosDe(opConEta, 'REQUERIMIENTO_VENCIDO');
    expect(eventos).toHaveLength(1);
    expect(eventos[0].origen).toBe('sistema');
    expect(String(eventos[0].payload.efecto)).toMatch(/CT-4/);

    expect(await auditoriasDe('REQUERIMIENTO_VENCIDO')).toHaveLength(1);
  });

  it('reuses an open riesgo hold instead of stacking a second freeze', async () => {
    const a = await emitirVencido(opConEta, { notificado: true });
    const b = await emitirVencido(opConEta, { notificado: true });

    const resumen = await runRequerimientosSweep();
    expect(resumen.vencidos).toBe(2);
    expect(resumen.detalle.filter((d) => d.holdReutilizado)).toHaveLength(1);

    const holds = await holdsDe(opConEta);
    expect(holds).toHaveLength(1);
    const rows = await Promise.all([requerimientoRow(a), requerimientoRow(b)]);
    expect(rows[0].hold_id).toBe(holds[0].id);
    expect(rows[1].hold_id).toBe(holds[0].id);
  });

  it('is idempotent — a second sweep finds nothing left to expire', async () => {
    await emitirVencido(opConEta, { notificado: true });
    expect((await runRequerimientosSweep()).vencidos).toBe(1);
    expect((await runRequerimientosSweep()).vencidos).toBe(0);
    expect(await eventosDe(opConEta, 'REQUERIMIENTO_VENCIDO')).toHaveLength(1);
  });

  it('does not expire a requerimiento whose deadline has not arrived', async () => {
    sendMail.mockResolvedValue(ENVIADO);
    await emitir(opConEta, { reasonCodes: HALLAZGOS }).expect(201);
    expect((await runRequerimientosSweep()).vencidos).toBe(0);
  });

  it('retries the notifications that were skipped, and reports that SMTP is the reason', async () => {
    const res = await emitir(opConEta, { reasonCodes: HALLAZGOS }).expect(201);

    let resumen = await runRequerimientosSweep();
    expect(resumen).toMatchObject({ notificacionesReintentadas: 1, notificacionesEnviadas: 0, smtpNoConfigurado: true });
    expect((await requerimientoRow(res.body.requerimientoId)).notificado_at).toBeNull();

    // The operator provisions SMTP; the very next tick tells everybody who was missed.
    sendMail.mockResolvedValue(ENVIADO);
    resumen = await runRequerimientosSweep();
    expect(resumen).toMatchObject({ notificacionesEnviadas: 1, smtpNoConfigurado: false });
    expect((await requerimientoRow(res.body.requerimientoId)).notificado_at).not.toBeNull();
  });

  it('tells the client, in the same sweep, when their overdue deadline is enforced', async () => {
    await emitirVencido(opConEta, { notificado: true });
    sendMail.mockResolvedValue(ENVIADO);
    const resumen = await runRequerimientosSweep();
    expect(resumen.detalle[0].avisoCliente).toBe('enviado');
    expect(String(sendMail.mock.calls.at(-1)?.[0]?.subject)).toMatch(/HOLD PLACED/);
  });
});

// -------------------------------------------------------------------------------------------------
describe('resolución', () => {
  function resolver(id: string, body: Record<string, unknown>, token = capturistaToken) {
    return request(app)
      .post(`/api/riesgo-requerimientos/${id}/resolver`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  it('requires a nota — "resolved" with no explanation is not an audit answer', async () => {
    const res = await emitir(opConEta, { reasonCodes: HALLAZGOS }).expect(201);
    await resolver(res.body.requerimientoId, { nota: '   ' }).expect(400);
  });

  it('walks estado_documental to riesgo_ok and records that the answer was in time', async () => {
    const res = await emitir(opConEta, { reasonCodes: HALLAZGOS }).expect(201);
    const out = await resolver(res.body.requerimientoId, { nota: 'invoice corregida' }).expect(200);
    expect(out.body).toMatchObject({ estado: 'resuelto', aTiempo: true, estadoDocumental: 'riesgo_ok', holdActivo: false });
    expect(await auditoriasDe('REQUERIMIENTO_RESUELTO')).toHaveLength(1);
    expect(await eventosDe(opConEta, 'REQUERIMIENTO_RESUELTO')).toHaveLength(1);
  });

  it('accepts a LATE resolution and lifts exactly the CT-4 hold that expiry opened (§8.4)', async () => {
    const id = await emitirVencido(opConEta, { notificado: true });
    await runRequerimientosSweep();
    const holdId = (await holdsDe(opConEta))[0].id;

    const out = await resolver(id, { nota: 'documentos llegaron tarde, aceptados' }).expect(200);
    expect(out.body).toMatchObject({
      estado: 'resuelto',
      aTiempo: false,
      holdCerrado: holdId,
      holdActivo: false,
      estadoDocumental: 'riesgo_ok',
    });

    const holds = await holdsDe(opConEta);
    expect(holds[0].activo).toBe(false);
    expect(await eventosDe(opConEta, 'HOLD_CERRADO')).toHaveLength(1);
  });

  it('keeps the freeze while another requerimiento is still outstanding', async () => {
    const a = await emitirVencido(opConEta, { notificado: true });
    const b = await emitirVencido(opConEta, { notificado: true });
    await runRequerimientosSweep();

    const parcial = await resolver(a, { nota: 'uno de dos' }).expect(200);
    expect(parcial.body).toMatchObject({ requerimientosPendientes: 1, holdCerrado: null, holdActivo: true });
    expect((await operacion(opConEta)).estado_documental).toBe('riesgo_vencido');

    const total = await resolver(b, { nota: 'el segundo' }).expect(200);
    expect(total.body).toMatchObject({ requerimientosPendientes: 0, holdActivo: false, estadoDocumental: 'riesgo_ok' });
  });

  it('does not lift a hold somebody else opened for another reason', async () => {
    const id = await emitirVencido(opConEta, { notificado: true });
    await runRequerimientosSweep();
    await request(app)
      .post(`/api/operaciones/${opConEta}/holds`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ tipo: 'csa', alcance: 'operacion', motivo: 'falta carta de cesión' })
      .expect(201);

    const out = await resolver(id, { nota: 'riesgo resuelto' }).expect(200);
    // The CT-4 freeze goes; the CSA one stays, and the caso is still blocked.
    expect(out.body.holdActivo).toBe(true);
    const holds = await holdsDe(opConEta);
    expect(holds.filter((h) => h.activo).map((h) => h.tipo)).toEqual(['csa']);
  });

  it('409s on a second resolution instead of writing a fictional one', async () => {
    const res = await emitir(opConEta, { reasonCodes: HALLAZGOS }).expect(201);
    await resolver(res.body.requerimientoId, { nota: 'ok' }).expect(200);
    await resolver(res.body.requerimientoId, { nota: 'otra vez' }).expect(409);
    expect(await eventosDe(opConEta, 'REQUERIMIENTO_RESUELTO')).toHaveLength(1);
  });

  it('404s for a requerimiento that does not exist', async () => {
    await resolver('33333333-3333-3333-3333-333333333333', { nota: 'x' }).expect(404);
  });
});

// -------------------------------------------------------------------------------------------------
describe('cancelación — the demand should never have been made', () => {
  function cancelar(id: string, body: Record<string, unknown>, token = adminToken) {
    return request(app)
      .post(`/api/riesgo-requerimientos/${id}/cancelar`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  it('is admin-only', async () => {
    const res = await emitir(opConEta, { reasonCodes: HALLAZGOS }).expect(201);
    await cancelar(res.body.requerimientoId, { motivo: 'el reparse corrigió el peso' }, capturistaToken).expect(403);
  });

  it('requires a motivo and releases the CT-4 freeze it caused', async () => {
    const id = await emitirVencido(opConEta, { notificado: true });
    await runRequerimientosSweep();

    await cancelar(id, { motivo: '' }).expect(400);
    const out = await cancelar(id, { motivo: 'el reparse corrigió el peso; el hallazgo era nuestro' }).expect(200);
    expect(out.body).toMatchObject({ estado: 'cancelado', holdActivo: false, estadoDocumental: 'riesgo_ok' });
    expect(await eventosDe(opConEta, 'REQUERIMIENTO_CANCELADO')).toHaveLength(1);
    expect(await auditoriasDe('REQUERIMIENTO_CANCELADO')).toHaveLength(1);
  });
});

// -------------------------------------------------------------------------------------------------
describe('GET /api/riesgo-requerimientos — the work queue', () => {
  it('lists the open ones with a countdown, for every authenticated role including autoridad', async () => {
    await emitir(opConEta, { reasonCodes: HALLAZGOS }).expect(201);
    const res = await request(app)
      .get('/api/riesgo-requerimientos')
      .set('Authorization', `Bearer ${autoridadToken}`)
      .expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].mawb).toBe('160-77770001');
    expect(res.body[0].venceEnMin).toBeGreaterThan(0);
    expect(res.body[0].notificacionEstado).toBe('omitida');
  });

  it('filters by estado and by the "about to expire" window', async () => {
    const pronto = await emitir(opConEta, { reasonCodes: HALLAZGOS, ventanaHoras: 1 }).expect(201);
    await emitir(opConEta, { reasonCodes: HALLAZGOS, ventanaHoras: 100 }).expect(201);

    const porVencer = await request(app)
      .get('/api/riesgo-requerimientos?porVencerHoras=30')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(porVencer.body.map((r: { id: string }) => r.id)).toEqual([pronto.body.requerimientoId]);

    const resueltos = await request(app)
      .get('/api/riesgo-requerimientos?estado=resuelto')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(resueltos.body).toHaveLength(0);
  });

  it('rejects a bogus estado rather than silently returning everything', async () => {
    await request(app)
      .get('/api/riesgo-requerimientos?estado=inventado')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
  });
});

// -------------------------------------------------------------------------------------------------
describe('POST /api/ops/tick — the requerimientos phase', () => {
  const ORIGINAL = process.env.OPS_TICK_TOKEN;
  const TOKEN = 'tick-secret-requerimientos';

  it('runs the sweep as a third phase and reports it', async () => {
    process.env.OPS_TICK_TOKEN = TOKEN;
    try {
      await query(`INSERT INTO integracion_cursores (fuente) VALUES ('vuelos') ON CONFLICT (fuente) DO NOTHING`);
      const id = await emitirVencido(opConEta, { notificado: true });

      const res = await request(app).post('/api/ops/tick').set('x-ops-token', TOKEN).expect(200);
      expect(res.body.requerimientos).toMatchObject({ ok: true, vencidos: 1 });
      expect((await requerimientoRow(id)).estado).toBe('vencido');
      expect((await operacion(opConEta)).hold_activo).toBe(true);
    } finally {
      if (ORIGINAL === undefined) delete process.env.OPS_TICK_TOKEN;
      else process.env.OPS_TICK_TOKEN = ORIGINAL;
    }
  });
});
