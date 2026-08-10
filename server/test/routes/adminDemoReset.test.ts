/**
 * Demo Reset — route tests for POST /api/admin/demo-reset.
 *
 * Verifies the DEMO_MODE 404 gate, the admin/super_admin role gate, the full manifest cascade
 * (+ explicit monthly_history / files cleanup), survivor tables, and the DEMO_RESET audit event.
 *
 * AND THE BLAST RADIUS, WHICH IS THE POINT OF HALF THIS FILE. A demo button that can TRUNCATE the
 * append-only `operacion_eventos` ledger, and destroy signed carrier convenios, on a request with no
 * body at all, is a worse defect than the stale demo board it was added to fix. So:
 *   - the operational graph goes ONLY on an explicit `{ incluirOperaciones: true }`;
 *   - the durable commercial catalogs (carriers, fleets, convenios, tarifas, client addresses) NEVER
 *     go, and neither do the signed documents attached to them;
 *   - the response names exactly which surfaces it touched.
 *
 * THE SHAPE ASSERTIONS ARE `toEqual`, NOT `toMatchObject`, DELIBERATELY. A reset endpoint's response
 * is a claim about what was destroyed; an extra key leaking into it (the internal `storagePaths`
 * list, say — server filesystem layout, handed to a client) is exactly the kind of regression a
 * loose matcher waves through. If this file has to be edited because a key was added, that is the
 * test working.
 *
 * DEMO_MODE is pinned explicitly per the MFA_ENFORCEMENT test convention.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../../src/app';
import { hashPassword } from '../../src/auth/password';
import { signToken, type Role } from '../../src/auth/token';
import { recordAudit } from '../../src/services/audit';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

const app = createApp();

// Disk scratch dir so the post-commit best-effort unlink has real blobs to remove.
const scratch = mkdtempSync(join(tmpdir(), 'demo-reset-'));

const ORIGINAL_DEMO_MODE = process.env.DEMO_MODE;
beforeEach(async () => {
  await truncateAll();
  process.env.DEMO_MODE = 'true';
});
afterEach(() => {
  if (ORIGINAL_DEMO_MODE === undefined) delete process.env.DEMO_MODE;
  else process.env.DEMO_MODE = ORIGINAL_DEMO_MODE;
});

async function seedUser(role: Role): Promise<{ id: string; token: string }> {
  const { rows } = await query<{ id: string; token_version: number }>(
    `INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', $2)
       RETURNING id, token_version`,
    [`demo-${role}-${randomUUID()}`, role],
  );
  return { id: rows[0].id, token: signToken({ userId: rows[0].id, role, tv: rows[0].token_version }) };
}

async function seedFile(kind: string, uploadedBy: string): Promise<{ id: string; path: string }> {
  const id = randomUUID();
  const path = join(scratch, `${id}.bin`);
  writeFileSync(path, 'blob');
  await query(
    `INSERT INTO files (id, kind, original_name, storage_path, size_bytes, uploaded_by, content_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, kind, `${id}.bin`, path, 4, uploadedBy, randomUUID()],
  );
  return { id, path };
}

let numeroCounter = 0;
function uniqueNumero(): string {
  numeroCounter += 1;
  return `${Date.now()}${numeroCounter}${Math.floor(Math.random() * 1e6)}`;
}

async function insManifest(createdBy: string, opts: { riskFile?: string; sourceFile?: string } = {}): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO manifests (mawb_reference, created_by, risk_file_id, source_file_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
    [`MAWB-${randomUUID()}`, createdBy, opts.riskFile ?? null, opts.sourceFile ?? null],
  );
  return rows[0].id;
}

async function insShipment(manifestId: string): Promise<void> {
  await query(`INSERT INTO shipments (id, manifest_id, data) VALUES ($1, $2, '{}'::jsonb)`, [randomUUID(), manifestId]);
}

async function insPedimento(manifestId: string, createdBy: string, opts: { file?: string; report?: string } = {}): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO pedimentos (manifest_id, numero_pedimento, file_id, report_file_id, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [manifestId, uniqueNumero(), opts.file ?? null, opts.report ?? null, createdBy],
  );
  return rows[0].id;
}

async function insScan(manifestId: string, fileId: string, createdBy: string): Promise<void> {
  await query(
    `INSERT INTO pedimento_scans (manifest_id, file_id, verdict, created_by) VALUES ($1, $2, 'ok', $3)`,
    [manifestId, fileId, createdBy],
  );
}

async function insMonthly(manifestId: string | null): Promise<void> {
  await query(
    `INSERT INTO monthly_history (consignee_name_norm, period, manifest_id, seen_count) VALUES ($1, '2026-07', $2, 1)`,
    [`c-${randomUUID()}`, manifestId],
  );
}

async function count(table: string): Promise<number> {
  const { rows } = await query<{ c: number }>(`SELECT count(*)::int AS c FROM ${table}`);
  return rows[0].c;
}

/** The durable catalogs the response promises to have kept, in the order the route declares them. */
const CATALOGOS_DURABLES = [
  'transportistas',
  'transportista_unidades',
  'transportista_convenios',
  'transportista_tarifas',
  'client_direcciones',
  'client_tarifas',
  'convenios',
];

interface Conteos {
  manifests?: number; pedimentos?: number; shipments?: number; files?: number;
  operaciones?: number; prealertas?: number; despachos?: number; pods?: number; facturas?: number;
}

/**
 * The EXACT body this endpoint is allowed to return. Anything else in it fails the assertion, which
 * is the whole reason these are `toEqual` — see the file header.
 */
function cuerpoEsperado(
  conteos: Conteos,
  opts: { operaciones: boolean; transportistas?: number; convenios?: number },
) {
  return {
    deleted: {
      manifests: 0, pedimentos: 0, shipments: 0, files: 0,
      operaciones: 0, prealertas: 0, despachos: 0, pods: 0, facturas: 0,
      ...conteos,
    },
    superficies: {
      manifiestos: true,
      archivos: true,
      operaciones: opts.operaciones,
      catalogosDurables: false,
    },
    conservado: {
      catalogosDurables: CATALOGOS_DURABLES,
      transportistas: opts.transportistas ?? 0,
      convenios: opts.convenios ?? 0,
    },
  };
}

/**
 * A caso with everything hanging off it: guías, a LEDGER ENTRY, a hold, campo evidence pinned to a
 * file by an ON DELETE RESTRICT FK, a carrier with a trip and a partida, a published plan, a risk
 * requerimiento and a client convenio.
 */
async function seedOperaciones(adminId: string): Promise<{ clientId: string; opId: string; evidencia: { id: string; path: string } }> {
  const { rows: cli } = await query<{ id: string }>(
    `INSERT INTO clients (name) VALUES ('Ops Co') RETURNING id`,
  );
  const clientId = cli[0].id;

  const { rows: op } = await query<{ id: string }>(
    `INSERT INTO operaciones (mawb, etapa, client_id) VALUES ('160-77777777','arribado',$1) RETURNING id`,
    [clientId],
  );
  const opId = op[0].id;
  await query(
    `INSERT INTO operacion_guias (operacion_id, guia_norm, estado) VALUES ($1,'HAWB-1','declarada')`,
    [opId],
  );
  await query(
    `INSERT INTO operacion_eventos (operacion_id, operacion_mawb, tipo, origen, ocurrido_at, payload)
     VALUES ($1,'160-77777777','CARGA_DISPONIBLE','tramitador',now(),'{}'::jsonb)`,
    [opId],
  );
  await query(
    `INSERT INTO operacion_holds (operacion_id, tipo, alcance, activo, motivo)
     VALUES ($1,'riesgo','operacion',true,'prueba')`,
    [opId],
  );
  // The RESTRICT edge into `files`: while the ops surface stands, this file is pinned by it.
  const evidencia = await seedFile('evidencia', adminId);
  await query(
    `INSERT INTO operacion_evidencias (operacion_id, tipo, file_id, capturado_at, created_by)
     VALUES ($1,'disponible',$2,now(),$3)`,
    [opId, evidencia.id, adminId],
  );

  const { rows: tr } = await query<{ id: string }>(
    `INSERT INTO transportistas (razon_social) VALUES ('Fletes Demo') RETURNING id`,
  );
  const { rows: dsp } = await query<{ id: string }>(
    `INSERT INTO despachos (folio, fecha_operacion, tipo_unidad, transportista_id)
     VALUES ('D-20260810-001','2026-08-10','tracto',$1) RETURNING id`,
    [tr[0].id],
  );
  await query(
    `INSERT INTO despacho_partidas (despacho_id, operacion_id) VALUES ($1,$2)`,
    [dsp[0].id, opId],
  );
  await query(
    `INSERT INTO plan_publicaciones (fecha_operacion, version, snapshot) VALUES ('2026-08-10',1,'{}'::jsonb)`,
  );
  await query(
    `INSERT INTO riesgo_requerimientos (operacion_id, reason_codes, vence_at)
     VALUES ($1,'[]'::jsonb, now() + interval '3 hours')`,
    [opId],
  );
  await query(`INSERT INTO convenios (client_id) VALUES ($1)`, [clientId]);

  return { clientId, opId, evidencia };
}

const TABLAS_OPS = [
  'operaciones', 'operacion_guias', 'operacion_eventos', 'operacion_evidencias',
  'operacion_holds', 'riesgo_requerimientos', 'despachos', 'despacho_partidas',
  'plan_publicaciones',
];

describe('POST /api/admin/demo-reset — gates', () => {
  it('404 when DEMO_MODE is unset, even for an admin', async () => {
    delete process.env.DEMO_MODE;
    const admin = await seedUser('admin');
    const res = await request(app).post('/api/admin/demo-reset').set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(404);
  });

  it('404 without a token when DEMO_MODE is unset (feature is hidden entirely)', async () => {
    delete process.env.DEMO_MODE;
    const res = await request(app).post('/api/admin/demo-reset');
    expect(res.status).toBe(404);
  });

  it('401 without a token in demo mode', async () => {
    const res = await request(app).post('/api/admin/demo-reset');
    expect(res.status).toBe(401);
  });

  it('403 for a capturista in demo mode — nothing is deleted', async () => {
    const cap = await seedUser('capturista');
    await insManifest(cap.id);
    const res = await request(app).post('/api/admin/demo-reset').set('Authorization', `Bearer ${cap.token}`);
    expect(res.status).toBe(403);
    expect(await count('manifests')).toBe(1);
  });

  it('403 for an autoridad in demo mode', async () => {
    const aut = await seedUser('autoridad');
    const res = await request(app).post('/api/admin/demo-reset').set('Authorization', `Bearer ${aut.token}`);
    expect(res.status).toBe(403);
  });

  it('allows super_admin', async () => {
    const sa = await seedUser('super_admin');
    const res = await request(app).post('/api/admin/demo-reset').set('Authorization', `Bearer ${sa.token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(cuerpoEsperado({}, { operaciones: false }));
  });
});

describe('POST /api/admin/demo-reset — cascade + survivors + audit', () => {
  it('wipes the manifest graph, removes files, preserves catalogs/users/audit, and logs DEMO_RESET', async () => {
    const admin = await seedUser('admin');

    // M1: risk + source files, one shipment, one pedimento (pdf + report) and a scan (own file).
    const riskF = await seedFile('risk_analysis', admin.id);
    const srcF = await seedFile('manifest', admin.id);
    const m1 = await insManifest(admin.id, { riskFile: riskF.id, sourceFile: srcF.id });
    await insShipment(m1);
    const p1pdf = await seedFile('pedimento_pdf', admin.id);
    const p1rep = await seedFile('report', admin.id);
    await insPedimento(m1, admin.id, { file: p1pdf.id, report: p1rep.id });
    const scanF = await seedFile('pedimento_pdf', admin.id);
    await insScan(m1, scanF.id, admin.id);
    await insMonthly(m1);

    // M2: two shipments, two pedimentos (pdf each).
    const m2 = await insManifest(admin.id);
    await insShipment(m2);
    await insShipment(m2);
    const p2pdf = await seedFile('pedimento_pdf', admin.id);
    const p3pdf = await seedFile('pedimento_pdf', admin.id);
    await insPedimento(m2, admin.id, { file: p2pdf.id });
    await insPedimento(m2, admin.id, { file: p3pdf.id });

    // M3: two pedimentos (pdf each), no shipments.
    const m3 = await insManifest(admin.id);
    const p4pdf = await seedFile('pedimento_pdf', admin.id);
    const p5pdf = await seedFile('pedimento_pdf', admin.id);
    await insPedimento(m3, admin.id, { file: p4pdf.id });
    await insPedimento(m3, admin.id, { file: p5pdf.id });

    // Legacy monthly_history aggregate with NO manifest_id — must be removed explicitly.
    await insMonthly(null);

    // A files row NOT referenced by anything (abandoned upload: saveFile commits before
    // the referencing row is attached). The reset wipes it too — files is not a survivor.
    const orphanF = await seedFile('manifest', admin.id);

    // Survivors: users, clients, catalogs, validated RFCs, config, and the audit log.
    await query(`INSERT INTO clients (name) VALUES ('Survivor Co')`);
    await query(`INSERT INTO agentes_aduanales (patente) VALUES ('9999')`);
    await query(`INSERT INTO importadores (rfc) VALUES ('RFC999999XXX')`);
    await query(`INSERT INTO validated_rfcs (id_ref) VALUES ('REF-1')`);
    await query(`INSERT INTO config (key, value) VALUES ('branding', '{}'::jsonb)`);
    await recordAudit({ userId: admin.id, action: 'LOGIN', entity: 'session', ip: '127.0.0.1' });

    const allFiles = [riskF, srcF, p1pdf, p1rep, scanF, p2pdf, p3pdf, p4pdf, p5pdf, orphanF];
    const expectedCounts = { manifests: 3, pedimentos: 5, shipments: 3, files: allFiles.length };

    const res = await request(app).post('/api/admin/demo-reset').set('Authorization', `Bearer ${admin.token}`);

    expect(res.status).toBe(200);
    // EXACT shape. An extra key here — `storagePaths`, once — is the server handing a client its
    // own filesystem layout, and a loose matcher is how that ships.
    expect(res.body).toEqual(cuerpoEsperado(expectedCounts, { operaciones: false }));

    // Operational graph gone (manifests + all cascade + explicit deletes).
    expect(await count('manifests')).toBe(0);
    expect(await count('shipments')).toBe(0);
    expect(await count('pedimentos')).toBe(0);
    expect(await count('pedimento_scans')).toBe(0);
    expect(await count('monthly_history')).toBe(0); // includes the NULL-manifest_id legacy row

    // ALL files rows removed (graph-referenced AND the never-referenced orphan) + blobs unlinked.
    expect(await count('files')).toBe(0);
    for (const f of allFiles) expect(existsSync(f.path)).toBe(false);

    // Survivors intact.
    expect(await count('users')).toBe(1);
    expect(await count('clients')).toBe(1);
    expect(await count('agentes_aduanales')).toBe(1);
    expect(await count('importadores')).toBe(1);
    expect(await count('validated_rfcs')).toBe(1);
    expect(await count('config')).toBe(1);

    // Audit log survives and the DEMO_RESET event carries the counts.
    const login = await query(`SELECT count(*)::int AS c FROM audit_log WHERE action='LOGIN'`);
    expect(login.rows[0].c).toBe(1);
    const demo = await query<{ after: unknown }>(`SELECT after FROM audit_log WHERE action='DEMO_RESET'`);
    expect(demo.rows).toHaveLength(1);
    // The chain records EXACTLY what the caller was told, key for key: "who wiped what, and did they
    // mean to" has to be answerable from the audit log alone.
    expect(demo.rows[0].after).toEqual(cuerpoEsperado(expectedCounts, { operaciones: false }));

    // Hash chain stays valid: DEMO_RESET links to the prior row's hash.
    const chain = await query<{ action: string; prev_hash: string | null; hash: string }>(
      `SELECT action, prev_hash, hash FROM audit_log ORDER BY id`,
    );
    const last = chain.rows[chain.rows.length - 1];
    const prev = chain.rows[chain.rows.length - 2];
    expect(last.action).toBe('DEMO_RESET');
    expect(last.prev_hash).toBe(prev.hash);
  });

  /**
   * THE DEFAULT: the operational surface is NOT demo debris.
   *
   * `operacion_eventos` is append-only by trigger — the ledger exists precisely so no later fact can
   * be smuggled into an earlier one — and a demo button that TRUNCATEs it on a bodiless request can
   * erase the record of what the system said. Holds, requerimientos, trips and invoices are the same
   * kind of thing. So the default does what this endpoint did before PRD-02: the manifest graph and
   * the files, and nothing else.
   */
  it('leaves the operations graph, the ledger and campo evidence alone unless asked', async () => {
    const admin = await seedUser('admin');
    const { evidencia } = await seedOperaciones(admin.id);
    const m1 = await insManifest(admin.id);
    await insShipment(m1);

    const res = await request(app).post('/api/admin/demo-reset').set('Authorization', `Bearer ${admin.token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      cuerpoEsperado(
        { manifests: 1, shipments: 1, files: 0 },
        { operaciones: false, transportistas: 1, convenios: 1 },
      ),
    );

    // The manifest graph went; every operational table stands.
    expect(await count('manifests')).toBe(0);
    for (const t of TABLAS_OPS) expect(await count(t)).toBe(1);
    expect(await count('operacion_eventos')).toBe(1);

    // The pinned evidence file survived — row AND blob. `operacion_evidencias.file_id` is ON DELETE
    // RESTRICT, so a blanket `DELETE FROM files` here would not merely delete it: it would 500.
    expect(await count('files')).toBe(1);
    expect(existsSync(evidencia.path)).toBe(true);
  });

  /**
   * THE OPT-IN: with `incluirOperaciones: true` the whole PRD-02 surface goes, ledger included.
   *
   * That is a legitimate thing to want between demos — a "pristine" board that still opens with
   * yesterday's trucks on it is a demo tool lying about state. It just has to be ASKED for.
   */
  it('wipes the whole operations surface, ledger and campo evidence included, when asked', async () => {
    const admin = await seedUser('admin');
    const { evidencia } = await seedOperaciones(admin.id);

    const res = await request(app)
      .post('/api/admin/demo-reset')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ incluirOperaciones: true });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      cuerpoEsperado(
        { operaciones: 1, despachos: 1, files: 1 },
        { operaciones: true, transportistas: 1, convenios: 1 },
      ),
    );

    for (const t of TABLAS_OPS) expect(await count(t)).toBe(0);
    expect(await count('operacion_eventos')).toBe(0);
    expect(await count('files')).toBe(0);
    expect(existsSync(evidencia.path)).toBe(false);

    // Survivors: the client and the scheduler's watermark rows are not demo data.
    expect(await count('clients')).toBe(1);
    expect(await count('integracion_cursores')).toBeGreaterThan(0);
  });

  /**
   * THE DURABLE CATALOGS SURVIVE BOTH MODES, WITH THEIR SIGNED PAPER.
   *
   * A carrier, its fleet, its convenio and the rates inside it are counterparties and commercial
   * terms an admin entered, and `transportista_convenios` carries a NOM-151 signed document plus its
   * evidence hash (R25/D9). Truncating those to clean up a demo board destroys signed agreements —
   * and the ON DELETE SET NULL on their `file_id` makes the failure quiet: the convenio would keep
   * its row and lose the document it was signed on.
   */
  it('never touches the durable commercial catalogs, nor the documents attached to them', async () => {
    const admin = await seedUser('admin');
    const { clientId } = await seedOperaciones(admin.id);

    const { rows: tr } = await query<{ id: string }>(
      `INSERT INTO transportistas (razon_social) VALUES ('Fletes Durables') RETURNING id`,
    );
    await query(
      `INSERT INTO transportista_unidades (transportista_id, placas, tipo_unidad) VALUES ($1,'DUR1234','tracto')`,
      [tr[0].id],
    );
    const convenioFirmado = await seedFile('convenio', admin.id);
    const evidenciaFirma = await seedFile('evidencia', admin.id);
    const { rows: cv } = await query<{ id: string }>(
      `INSERT INTO transportista_convenios (transportista_id, estado_firma, firmado_at, file_id, firma_evidencia_file_id)
         VALUES ($1,'firmado',now(),$2,$3) RETURNING id`,
      [tr[0].id, convenioFirmado.id, evidenciaFirma.id],
    );
    await query(
      `INSERT INTO transportista_tarifas (convenio_id, tipo_unidad, tarifa, moneda)
         VALUES ($1,'tracto',8500,'MXN')`,
      [cv[0].id],
    );
    const dir = await query<{ id: string }>(
      `INSERT INTO client_direcciones (client_id, alias, direccion) VALUES ($1,'Cuautitlán','Parque 12') RETURNING id`,
      [clientId],
    );
    const contrato = await seedFile('convenio', admin.id);
    await query(
      `INSERT INTO client_tarifas (client_id, concepto, unidad, precio, moneda, contrato_file_id)
         VALUES ($1,'flete','despacho',1200,'MXN',$2)`,
      [clientId, contrato.id],
    );
    expect(dir.rows).toHaveLength(1);

    // The most destructive request the endpoint accepts.
    const res = await request(app)
      .post('/api/admin/demo-reset')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ incluirOperaciones: true });
    expect(res.status).toBe(200);
    expect(res.body.superficies.catalogosDurables).toBe(false);
    expect(res.body.conservado.catalogosDurables).toEqual(CATALOGOS_DURABLES);

    for (const t of CATALOGOS_DURABLES) expect(await count(t)).toBeGreaterThan(0);
    expect(await count('transportistas')).toBe(2); // the seeded one and this one

    // The signed convenio still POINTS AT its document — row, blob and FK all intact.
    const cvAfter = await query<{ file_id: string | null; firma_evidencia_file_id: string | null }>(
      `SELECT file_id, firma_evidencia_file_id FROM transportista_convenios WHERE id = $1`, [cv[0].id]);
    expect(cvAfter.rows[0].file_id).toBe(convenioFirmado.id);
    expect(cvAfter.rows[0].firma_evidencia_file_id).toBe(evidenciaFirma.id);
    for (const f of [convenioFirmado, evidenciaFirma, contrato]) {
      expect(existsSync(f.path)).toBe(true);
    }
    expect(await count('files')).toBe(3);
  });

  it('rejects a non-boolean incluirOperaciones instead of guessing what was meant', async () => {
    const admin = await seedUser('admin');
    await seedOperaciones(admin.id);
    const res = await request(app)
      .post('/api/admin/demo-reset')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ incluirOperaciones: 'quizá' });
    expect(res.status).toBe(400);
    expect(await count('operaciones')).toBe(1);
  });
});

describe('demoMode flag on auth responses', () => {
  // Capturista avoids the MFA enforcement gate for privileged roles.
  async function seedLoginUser(): Promise<string> {
    const username = `demo-login-${randomUUID()}`;
    await query(
      `INSERT INTO users (username, password_hash, role) VALUES ($1, $2, 'capturista')`,
      [username, await hashPassword('pass')],
    );
    return username;
  }

  it('POST /login includes demoMode: true on the user when DEMO_MODE is pinned true', async () => {
    const username = await seedLoginUser();
    const res = await request(app).post('/api/auth/login').send({ username, password: 'pass' });
    expect(res.status).toBe(200);
    expect(res.body.user.demoMode).toBe(true);
  });

  it('POST /login includes demoMode: false when DEMO_MODE is unset', async () => {
    delete process.env.DEMO_MODE;
    const username = await seedLoginUser();
    const res = await request(app).post('/api/auth/login').send({ username, password: 'pass' });
    expect(res.status).toBe(200);
    expect(res.body.user.demoMode).toBe(false);
  });

  it('GET /me includes demoMode: true when DEMO_MODE is pinned true', async () => {
    const cap = await seedUser('capturista');
    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${cap.token}`);
    expect(res.status).toBe(200);
    expect(res.body.demoMode).toBe(true);
  });
});
