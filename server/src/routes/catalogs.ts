import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/pool';
import { isUniqueViolation } from '../db/errors';
import { requireAuth, requireRole } from '../auth/middleware';
import { recordAudit } from '../services/audit';
import { withTransaction } from '../db/tx';
import { validate } from '../validation/middleware';
import { createClientBody, updateClientBody, configKeyParam, configValueBody, validatedRfcBody, clientPlatformBody, idParam, importerSchema, agentSchema, clientDireccionBody, clientDireccionUpdateBody, clientDireccionParam, type ClientDireccionBody, type ClientDireccionUpdateBody } from '../validation/schemas';
import { decryptField, encryptField } from '../crypto/fieldCrypto';
import { listAgentes, listImportadores, AGENTE_RETURNING, IMPORTADOR_RETURNING } from '../services/entityMaster';

export const catalogsRouter = Router();

// GET /api/catalogs/clients — any authenticated role
catalogsRouter.get('/clients', requireAuth, async (req, res) => {
  const { rows } = await query(
    `SELECT c.id, c.name, c.tax_id, c.address, c.phone, c.email, c.website, c.created_by, c.created_at,
            COALESCE(
              json_agg(
                json_build_object(
                  'id', p.id,
                  'commercialName', p.commercial_name,
                  'countryOfOrigin', p.country_of_origin,
                  'legalName', p.legal_name,
                  'email', p.email,
                  'url', p.url
                ) ORDER BY p.created_at
              ) FILTER (WHERE p.id IS NOT NULL),
              '[]'
            ) AS platforms
       FROM clients c
       LEFT JOIN client_platforms p ON p.client_id = c.id
       GROUP BY c.id
       ORDER BY c.name`,
  );
  res.json(rows);
});

// POST /api/catalogs/clients — admin or capturista
catalogsRouter.post(
  '/clients',
  requireAuth,
  requireRole('admin', 'capturista'),
  validate({ body: createClientBody }),
  async (req, res) => {
    const { name, tax_id, address, phone, email, website, platform } = req.body;

    // Create the initial platform row when the caller supplied non-empty platform data.
    const p = (platform ?? {}) as Record<string, unknown>;
    const pn = (k: string) => (typeof p[k] === 'string' && (p[k] as string).trim() !== '' ? (p[k] as string).trim() : null);

    const { client, platforms } = await withTransaction(async (q) => {
      const inserted = await q(
        `INSERT INTO clients (name, tax_id, address, phone, email, website, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, name, tax_id, address, phone, email, website, created_by, created_at`,
        [name, tax_id ?? null, address ?? null, phone ?? null, email ?? null, website ?? null, req.user!.userId],
      );
      const client = inserted.rows[0];

      let platforms: unknown[] = [];
      if (pn('commercialName') || pn('countryOfOrigin') || pn('legalName') || pn('email') || pn('url')) {
        const pr = await q(
          `INSERT INTO client_platforms (client_id, commercial_name, country_of_origin, legal_name, email, url, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, commercial_name AS "commercialName", country_of_origin AS "countryOfOrigin",
                     legal_name AS "legalName", email, url`,
          [client.id, pn('commercialName'), pn('countryOfOrigin'), pn('legalName'), pn('email'), pn('url'), req.user!.userId],
        );
        platforms = pr.rows;
      }

      return { client, platforms };
    });

    const after = { ...client, platforms };
    await recordAudit({
      userId: req.user!.userId, action: 'CREATE_CLIENT', entity: 'client',
      entityId: client.id, after, ip: req.ip,
    });
    res.status(201).json(after);
  },
);

// PUT /api/catalogs/clients/:id — admin or capturista
catalogsRouter.put(
  '/clients/:id',
  requireAuth,
  requireRole('admin', 'capturista'),
  validate({ params: idParam, body: updateClientBody }),
  async (req, res) => {
    const { id } = req.params;
    const { name, tax_id, address, phone, email, website } = req.body ?? {};

    const before = await query('SELECT * FROM clients WHERE id = $1', [id]);
    if (before.rows.length === 0) { res.status(404).json({ error: 'Client not found' }); return; }

    const { rows } = await query(
      `UPDATE clients
         SET name    = COALESCE($2, name),
             tax_id  = COALESCE($3, tax_id),
             address = COALESCE($4, address),
             phone   = COALESCE($5, phone),
             email   = COALESCE($6, email),
             website = COALESCE($7, website)
       WHERE id = $1
       RETURNING id, name, tax_id, address, phone, email, website, created_by, created_at`,
      [id, name ?? null, tax_id ?? null, address ?? null, phone ?? null, email ?? null, website ?? null],
    );
    await recordAudit({
      userId: req.user!.userId, action: 'UPDATE_CLIENT', entity: 'client',
      entityId: id, before: before.rows[0], after: rows[0], ip: req.ip,
    });
    res.json(rows[0]);
  },
);

// DELETE /api/catalogs/clients/:id — admin only
catalogsRouter.delete(
  '/clients/:id',
  requireAuth,
  requireRole('admin'),
  async (req, res) => {
    const { id } = req.params;

    // Fetch before state for audit
    const before = await query('SELECT * FROM clients WHERE id = $1', [id]);
    if (before.rows.length === 0) {
      res.status(404).json({ error: 'Client not found' });
      return;
    }

    await query('DELETE FROM clients WHERE id = $1', [id]);
    await recordAudit({
      userId: req.user!.userId,
      action: 'DELETE_CLIENT',
      entity: 'client',
      entityId: id,
      before: before.rows[0],
      ip: req.ip,
    });
    res.json({ ok: true });
  },
);

// ─── Client platforms (one client → many) ───────────────────────────────────

const PLATFORM_RETURNING =
  `id, commercial_name AS "commercialName", country_of_origin AS "countryOfOrigin",
   legal_name AS "legalName", email, url`;

// helper: normalize '' → null
const orNull = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

// POST /api/catalogs/clients/:id/platforms — admin or capturista
catalogsRouter.post(
  '/clients/:id/platforms',
  requireAuth,
  requireRole('admin', 'capturista'),
  validate({ params: idParam, body: clientPlatformBody }),
  async (req, res) => {
    const { id } = req.params;
    const client = await query('SELECT id FROM clients WHERE id=$1', [id]);
    if (client.rows.length === 0) { res.status(404).json({ error: 'Client not found' }); return; }
    const { commercialName, countryOfOrigin, legalName, email, url } = req.body;
    const { rows } = await query(
      `INSERT INTO client_platforms (client_id, commercial_name, country_of_origin, legal_name, email, url, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${PLATFORM_RETURNING}`,
      [id, orNull(commercialName), orNull(countryOfOrigin), orNull(legalName), orNull(email), orNull(url), req.user!.userId],
    );
    await recordAudit({
      userId: req.user!.userId, action: 'CREATE_CLIENT_PLATFORM', entity: 'client_platform',
      entityId: rows[0].id, after: rows[0], ip: req.ip,
    });
    res.status(201).json(rows[0]);
  },
);

// PUT /api/catalogs/clients/:id/platforms/:pid — admin or capturista
catalogsRouter.put(
  '/clients/:id/platforms/:pid',
  requireAuth,
  requireRole('admin', 'capturista'),
  validate({ params: idParam.passthrough(), body: clientPlatformBody }),
  async (req, res) => {
    const { id, pid } = req.params;
    const before = await query('SELECT * FROM client_platforms WHERE id=$1 AND client_id=$2', [pid, id]);
    if (before.rows.length === 0) { res.status(404).json({ error: 'Platform not found' }); return; }
    const { commercialName, countryOfOrigin, legalName, email, url } = req.body;
    const { rows } = await query(
      `UPDATE client_platforms
         SET commercial_name = $3, country_of_origin = $4, legal_name = $5, email = $6, url = $7
       WHERE id = $1 AND client_id = $2
       RETURNING ${PLATFORM_RETURNING}`,
      [pid, id, orNull(commercialName), orNull(countryOfOrigin), orNull(legalName), orNull(email), orNull(url)],
    );
    await recordAudit({
      userId: req.user!.userId, action: 'UPDATE_CLIENT_PLATFORM', entity: 'client_platform',
      entityId: pid, before: before.rows[0], after: rows[0], ip: req.ip,
    });
    res.json(rows[0]);
  },
);

// DELETE /api/catalogs/clients/:id/platforms/:pid — admin only
catalogsRouter.delete(
  '/clients/:id/platforms/:pid',
  requireAuth,
  requireRole('admin'),
  validate({ params: idParam.passthrough() }),
  async (req, res) => {
    const { id, pid } = req.params;
    const before = await query('SELECT * FROM client_platforms WHERE id=$1 AND client_id=$2', [pid, id]);
    if (before.rows.length === 0) { res.status(404).json({ error: 'Platform not found' }); return; }
    await query('DELETE FROM client_platforms WHERE id=$1 AND client_id=$2', [pid, id]);
    await recordAudit({
      userId: req.user!.userId, action: 'DELETE_CLIENT_PLATFORM', entity: 'client_platform',
      entityId: pid, before: before.rows[0], ip: req.ip,
    });
    res.json({ ok: true });
  },
);

// ─── Client delivery addresses (R38 / D15) ──────────────────────────────────
//
// The destination catalog decision D15 asked for, and a hard dependency of two things that do not
// look related: a despacho carries ONE destination for N clients' cargo (R29), and the R36 arrival
// estimate cannot run at all without `lat`/`lng` — with no coordinates it returns nothing rather
// than a plausible-looking time (shared/operaciones/eta.ts).
//
// `alias` is what the operation says out loud ("IMILE Cuautitlán") and is unique per client, because
// the published plan, the tariff and the POD all refer to the destination by that string; two
// addresses sharing one alias would make a published plan ambiguous about where a truck went.
//
// Addresses are DEACTIVATED, never deleted: despachos and published plans name them, and a deleted
// row would leave old trips pointing at nothing.
//
// The contact fields are encrypted at rest — they are personal data of the receiving warehouse's
// staff, who never contracted with us. decryptField passes plaintext through unchanged.

const DIRECCION_RETURNING = `
  id, alias, direccion, ciudad, estado, cp, lat, lng,
  contacto_nombre AS "contactoNombre", contacto_telefono AS "contactoTelefono",
  horario, activo`;

interface FilaDireccion {
  contactoNombre: string | null;
  contactoTelefono: string | null;
  [k: string]: unknown;
}

const descifrarDireccion = (d: FilaDireccion): FilaDireccion => ({
  ...d,
  contactoNombre: d.contactoNombre ? decryptField(d.contactoNombre) : null,
  contactoTelefono: d.contactoTelefono ? decryptField(d.contactoTelefono) : null,
});

const cifrarOrNull = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s ? encryptField(s) : null;
};

// GET /api/catalogs/clients/:id/direcciones — any authenticated role (the planner needs it).
catalogsRouter.get(
  '/clients/:id/direcciones',
  requireAuth,
  validate({ params: idParam }),
  async (req, res) => {
    const { rows } = await query(
      `SELECT ${DIRECCION_RETURNING} FROM client_direcciones WHERE client_id = $1
        ORDER BY activo DESC, alias`,
      [req.params.id],
    );
    res.json((rows as unknown as FilaDireccion[]).map(descifrarDireccion));
  },
);

catalogsRouter.post(
  '/clients/:id/direcciones',
  requireAuth,
  requireRole('admin', 'capturista'),
  validate({ params: idParam, body: clientDireccionBody }),
  async (req, res) => {
    const { id } = req.params;
    const client = await query('SELECT id FROM clients WHERE id=$1', [id]);
    if (client.rows.length === 0) { res.status(404).json({ error: 'Client not found' }); return; }
    const b = req.body as ClientDireccionBody;
    try {
      const { rows } = await query(
        `INSERT INTO client_direcciones
           (client_id, alias, direccion, ciudad, estado, cp, lat, lng,
            contacto_nombre, contacto_telefono, horario, activo, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,COALESCE($12,true),$13)
         RETURNING ${DIRECCION_RETURNING}`,
        [
          id, b.alias, orNull(b.direccion), orNull(b.ciudad), orNull(b.estado), orNull(b.cp),
          b.lat ?? null, b.lng ?? null,
          cifrarOrNull(b.contactoNombre), cifrarOrNull(b.contactoTelefono),
          orNull(b.horario), b.activo ?? null, req.user!.userId,
        ],
      );
      const creada = descifrarDireccion(rows[0] as unknown as FilaDireccion);
      await recordAudit({
        userId: req.user!.userId, action: 'CREATE_CLIENT_DIRECCION', entity: 'client_direccion',
        // Contact details deliberately left out of the permanent hash-chained record.
        entityId: rows[0].id as string,
        after: { clientId: id, alias: b.alias, ciudad: b.ciudad ?? null, lat: b.lat ?? null, lng: b.lng ?? null },
        ip: req.ip,
      });
      res.status(201).json(creada);
    } catch (err) {
      if (isUniqueViolation(err)) {
        res.status(409).json({ error: 'Ese cliente ya tiene una dirección con ese alias.' });
        return;
      }
      throw err;
    }
  },
);

catalogsRouter.put(
  '/clients/:id/direcciones/:did',
  requireAuth,
  requireRole('admin', 'capturista'),
  validate({ params: clientDireccionParam, body: clientDireccionUpdateBody }),
  async (req, res) => {
    const { id, did } = req.params;
    const b = req.body as ClientDireccionUpdateBody;
    const sets: string[] = [];
    const params: unknown[] = [did, id];
    const set = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
    if (b.alias !== undefined) set('alias', b.alias);
    if (b.direccion !== undefined) set('direccion', orNull(b.direccion));
    if (b.ciudad !== undefined) set('ciudad', orNull(b.ciudad));
    if (b.estado !== undefined) set('estado', orNull(b.estado));
    if (b.cp !== undefined) set('cp', orNull(b.cp));
    if (b.lat !== undefined) set('lat', b.lat ?? null);
    if (b.lng !== undefined) set('lng', b.lng ?? null);
    if (b.contactoNombre !== undefined) set('contacto_nombre', cifrarOrNull(b.contactoNombre));
    if (b.contactoTelefono !== undefined) set('contacto_telefono', cifrarOrNull(b.contactoTelefono));
    if (b.horario !== undefined) set('horario', orNull(b.horario));
    if (b.activo !== undefined) set('activo', b.activo);
    if (!sets.length) { res.status(400).json({ error: 'No hay nada que actualizar.' }); return; }

    try {
      const { rows } = await query(
        `UPDATE client_direcciones SET ${sets.join(', ')}
          WHERE id = $1 AND client_id = $2 RETURNING ${DIRECCION_RETURNING}`,
        params,
      );
      if (!rows.length) { res.status(404).json({ error: 'Dirección no encontrada' }); return; }
      await recordAudit({
        userId: req.user!.userId, action: 'UPDATE_CLIENT_DIRECCION', entity: 'client_direccion',
        entityId: did, after: { clientId: id, alias: rows[0].alias, activo: rows[0].activo },
        ip: req.ip,
      });
      res.json(descifrarDireccion(rows[0] as unknown as FilaDireccion));
    } catch (err) {
      if (isUniqueViolation(err)) {
        res.status(409).json({ error: 'Ese cliente ya tiene una dirección con ese alias.' });
        return;
      }
      throw err;
    }
  },
);

// DELETE = deactivate. See the section header for why the row survives.
catalogsRouter.delete(
  '/clients/:id/direcciones/:did',
  requireAuth,
  requireRole('admin'),
  validate({ params: clientDireccionParam }),
  async (req, res) => {
    const { id, did } = req.params;
    const { rows } = await query(
      `UPDATE client_direcciones SET activo = false WHERE id = $1 AND client_id = $2
       RETURNING id, alias, activo`,
      [did, id],
    );
    if (!rows.length) { res.status(404).json({ error: 'Dirección no encontrada' }); return; }
    await recordAudit({
      userId: req.user!.userId, action: 'DESACTIVAR_CLIENT_DIRECCION', entity: 'client_direccion',
      entityId: did, after: { clientId: id, ...rows[0] }, ip: req.ip,
    });
    res.json({ ok: true, ...rows[0] });
  },
);

// ─── Config endpoints ───────────────────────────────────────────────────────

const ALLOWED_CONFIG_KEYS = new Set([
  'prohibited',
  'piracy_brands',
  'branding',
  'validation_params',
  'denied_parties',
  'tasa_vigencias',        // §10 — parametrizable tasa-global vigencias (super_admin only to edit)
  'pedimento_scan_policy', // RF-08/RF-10 — PDF/QR scan sensitivity policy
  'importer_of_record',   // Phase 2 entity master — stable importer of record (super_admin only)
  'customs_agent',         // Phase 2 entity master — stable customs agent (super_admin only)
]);

// §10: editing tasa-global vigencias is restricted to super_admin (everything else is admin).
// F18: denied_parties (sanctions list) is also super_admin-only to prevent tampering.
const SUPER_ADMIN_CONFIG_KEYS = new Set(['tasa_vigencias', 'denied_parties', 'importer_of_record', 'customs_agent']);

// GET /api/catalogs/config/:key — any authenticated role
catalogsRouter.get('/config/:key', requireAuth, validate({ params: configKeyParam }), async (req, res) => {
  const { key } = req.params;
  const { rows } = await query('SELECT value FROM config WHERE key=$1', [key]);
  res.json({ key, value: rows[0]?.value ?? null });
});

// PUT /api/catalogs/config/:key — admin only
catalogsRouter.put(
  '/config/:key',
  requireAuth,
  requireRole('admin'),
  validate({ params: configKeyParam, body: configValueBody }),
  async (req, res) => {
    const { key } = req.params;
    // §10: tasa-global vigencias may only be edited by super_admin.
    if (SUPER_ADMIN_CONFIG_KEYS.has(key) && req.user!.role !== 'super_admin') {
      res.status(403).json({ error: 'Solo el Super Admin puede modificar esta configuración.' });
      return;
    }
    const SHAPE_BY_KEY: Record<string, typeof importerSchema | typeof agentSchema> = {
      importer_of_record: importerSchema,
      customs_agent: agentSchema,
    };
    const shape = SHAPE_BY_KEY[key];
    if (shape) {
      const parsed = shape.safeParse(req.body?.value);
      if (!parsed.success) {
        res.status(400).json({ error: 'Forma inválida para esta configuración', details: parsed.error.issues });
        return;
      }
    }
    const value = req.body?.value;
    const { rows } = await query(
      `INSERT INTO config (key, value, updated_by, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (key) DO UPDATE SET value=$2, updated_by=$3, updated_at=now()
       RETURNING key, value, updated_at`,
      [key, JSON.stringify(value), req.user!.userId],
    );
    await recordAudit({
      userId: req.user!.userId,
      action: 'UPDATE_CONFIG',
      entity: 'config',
      entityId: key,
      after: { key, value },
      ip: req.ip,
    });
    res.json(rows[0]);
  },
);

// ─── Validated-RFCs catalog (D3) ────────────────────────────────────────────

// GET /api/catalogs/validated-rfcs — any authenticated role
catalogsRouter.get('/validated-rfcs', requireAuth, async (_req, res) => {
  const { rows } = await query(
    'SELECT id, id_ref, rfc, curp, name, created_by, created_at FROM validated_rfcs ORDER BY id_ref',
  );
  res.json(rows);
});

// POST /api/catalogs/validated-rfcs — admin (super_admin via superset)
catalogsRouter.post('/validated-rfcs', requireAuth, requireRole('admin'), validate({ body: validatedRfcBody }), async (req, res) => {
  const { id_ref, rfc, curp, name } = req.body;
  const { rows } = await query(
    `INSERT INTO validated_rfcs (id_ref, rfc, curp, name, created_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id_ref) DO UPDATE SET rfc=$2, curp=$3, name=$4
     RETURNING id, id_ref, rfc, curp, name, created_by, created_at`,
    [id_ref, rfc ?? null, curp ?? null, name ?? null, req.user!.userId],
  );
  await recordAudit({
    userId: req.user!.userId,
    action: 'UPSERT_VALIDATED_RFC',
    entity: 'validated_rfc',
    entityId: rows[0].id,
    after: rows[0],
    ip: req.ip,
  });
  res.status(201).json(rows[0]);
});

// DELETE /api/catalogs/validated-rfcs/:id — admin only
catalogsRouter.delete('/validated-rfcs/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const { id } = req.params;
  const before = await query('SELECT * FROM validated_rfcs WHERE id=$1', [id]);
  if (before.rows.length === 0) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  await query('DELETE FROM validated_rfcs WHERE id=$1', [id]);
  await recordAudit({
    userId: req.user!.userId,
    action: 'DELETE_VALIDATED_RFC',
    entity: 'validated_rfc',
    entityId: id,
    before: before.rows[0],
    ip: req.ip,
  });
  res.json({ ok: true });
});

// ─── Entity catalogs: agentes aduanales & importadores ───────────────────────
// Auto-registered from uploaded pedimentos; admin (super_admin via superset) may edit fields and
// flip `verified`. Not super_admin-only like the legacy config keys — these are working catalogs.

const agenteUpdateBody = z.object({
  patente: z.string().min(1).optional(),
  name: z.string().optional(),
  agentRfc: z.string().optional(),
  agencyRfc: z.string().optional(),
  verified: z.boolean().optional(),
});

const importadorUpdateBody = z.object({
  rfc: z.string().min(1).optional(),
  name: z.string().optional(),
  fiscalAddress: z.string().optional(),
  verified: z.boolean().optional(),
});

// GET /api/catalogs/agentes-aduanales — admin + super_admin
catalogsRouter.get('/agentes-aduanales', requireAuth, requireRole('admin'), async (_req, res) => {
  res.json(await listAgentes());
});

// PUT /api/catalogs/agentes-aduanales/:id — admin + super_admin
catalogsRouter.put(
  '/agentes-aduanales/:id',
  requireAuth,
  requireRole('admin'),
  validate({ params: idParam, body: agenteUpdateBody }),
  async (req, res) => {
    const { id } = req.params;
    const { patente, name, agentRfc, agencyRfc, verified } = req.body;
    const before = await query(`SELECT ${AGENTE_RETURNING} FROM agentes_aduanales WHERE id=$1`, [id]);
    if (before.rows.length === 0) { res.status(404).json({ error: 'Agente aduanal not found' }); return; }
    try {
      const { rows } = await query(
        `UPDATE agentes_aduanales SET
           patente    = COALESCE($2, patente),
           name       = COALESCE($3, name),
           agent_rfc  = COALESCE($4, agent_rfc),
           agency_rfc = COALESCE($5, agency_rfc),
           verified   = COALESCE($6, verified),
           updated_at = now()
         WHERE id = $1
         RETURNING ${AGENTE_RETURNING}`,
        [id, patente ?? null, name ?? null, agentRfc ?? null, agencyRfc ?? null, verified ?? null],
      );
      await recordAudit({
        userId: req.user!.userId, action: 'UPDATE_AGENTE_ADUANAL', entity: 'agente_aduanal',
        entityId: id, before: before.rows[0], after: rows[0], ip: req.ip,
      });
      res.json(rows[0]);
    } catch (err) {
      if (isUniqueViolation(err)) { res.status(409).json({ error: 'Ya existe un agente con esa patente' }); return; }
      throw err;
    }
  },
);

// GET /api/catalogs/importadores — admin + super_admin
catalogsRouter.get('/importadores', requireAuth, requireRole('admin'), async (_req, res) => {
  res.json(await listImportadores());
});

// PUT /api/catalogs/importadores/:id — admin + super_admin
catalogsRouter.put(
  '/importadores/:id',
  requireAuth,
  requireRole('admin'),
  validate({ params: idParam, body: importadorUpdateBody }),
  async (req, res) => {
    const { id } = req.params;
    const { rfc, name, fiscalAddress, verified } = req.body;
    const before = await query(`SELECT ${IMPORTADOR_RETURNING} FROM importadores WHERE id=$1`, [id]);
    if (before.rows.length === 0) { res.status(404).json({ error: 'Importador not found' }); return; }
    try {
      const { rows } = await query(
        `UPDATE importadores SET
           rfc            = COALESCE($2, rfc),
           name           = COALESCE($3, name),
           fiscal_address = COALESCE($4, fiscal_address),
           verified       = COALESCE($5, verified),
           updated_at     = now()
         WHERE id = $1
         RETURNING ${IMPORTADOR_RETURNING}`,
        [id, rfc ?? null, name ?? null, fiscalAddress ?? null, verified ?? null],
      );
      await recordAudit({
        userId: req.user!.userId, action: 'UPDATE_IMPORTADOR', entity: 'importador',
        entityId: id, before: before.rows[0], after: rows[0], ip: req.ip,
      });
      res.json(rows[0]);
    } catch (err) {
      if (isUniqueViolation(err)) { res.status(409).json({ error: 'Ya existe un importador con ese RFC' }); return; }
      throw err;
    }
  },
);
