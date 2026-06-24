import { Router } from 'express';
import { query } from '../db/pool';
import { requireAuth, requireRole } from '../auth/middleware';
import { recordAudit } from '../services/audit';
import { validate } from '../validation/middleware';
import { createClientBody, configKeyParam, configValueBody, validatedRfcBody, clientPlatformBody, idParam } from '../validation/schemas';

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
                  'email', p.email
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
    const { rows } = await query(
      `INSERT INTO clients (name, tax_id, address, phone, email, website, platform, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, name, tax_id, address, phone, email, website, platform, created_by, created_at`,
      [name, tax_id ?? null, address ?? null, phone ?? null, email ?? null, website ?? null,
       platform != null ? JSON.stringify(platform) : null,
       req.user!.userId],
    );
    await recordAudit({
      userId: req.user!.userId,
      action: 'CREATE_CLIENT',
      entity: 'client',
      entityId: rows[0].id,
      after: rows[0],
      ip: req.ip,
    });
    res.status(201).json(rows[0]);
  },
);

// PUT /api/catalogs/clients/:id — admin or capturista
catalogsRouter.put(
  '/clients/:id',
  requireAuth,
  requireRole('admin', 'capturista'),
  async (req, res) => {
    const { id } = req.params;
    const { name, tax_id, address, phone, email, website, platform } = req.body ?? {};

    // Fetch before state for audit
    const before = await query('SELECT * FROM clients WHERE id = $1', [id]);
    if (before.rows.length === 0) {
      res.status(404).json({ error: 'Client not found' });
      return;
    }

    const { rows } = await query(
      `UPDATE clients
       SET name     = COALESCE($2, name),
           tax_id   = COALESCE($3, tax_id),
           address  = COALESCE($4, address),
           phone    = COALESCE($5, phone),
           email    = COALESCE($6, email),
           website  = COALESCE($7, website),
           platform = COALESCE($8, platform)
       WHERE id = $1
       RETURNING id, name, tax_id, address, phone, email, website, platform, created_by, created_at`,
      [id,
       name ?? null,
       tax_id ?? null,
       address ?? null,
       phone ?? null,
       email ?? null,
       website ?? null,
       platform != null ? JSON.stringify(platform) : null],
    );
    await recordAudit({
      userId: req.user!.userId,
      action: 'UPDATE_CLIENT',
      entity: 'client',
      entityId: id,
      before: before.rows[0],
      after: rows[0],
      ip: req.ip,
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
   legal_name AS "legalName", email`;

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
    const { commercialName, countryOfOrigin, legalName, email } = req.body;
    const { rows } = await query(
      `INSERT INTO client_platforms (client_id, commercial_name, country_of_origin, legal_name, email, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${PLATFORM_RETURNING}`,
      [id, orNull(commercialName), orNull(countryOfOrigin), orNull(legalName), orNull(email), req.user!.userId],
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
    const { commercialName, countryOfOrigin, legalName, email } = req.body;
    const { rows } = await query(
      `UPDATE client_platforms
         SET commercial_name = $3, country_of_origin = $4, legal_name = $5, email = $6
       WHERE id = $1 AND client_id = $2
       RETURNING ${PLATFORM_RETURNING}`,
      [pid, id, orNull(commercialName), orNull(countryOfOrigin), orNull(legalName), orNull(email)],
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

// ─── Config endpoints ───────────────────────────────────────────────────────

const ALLOWED_CONFIG_KEYS = new Set([
  'prohibited',
  'piracy_brands',
  'branding',
  'validation_params',
  'denied_parties',
  'tasa_vigencias',        // §10 — parametrizable tasa-global vigencias (super_admin only to edit)
  'pedimento_scan_policy', // RF-08/RF-10 — PDF/QR scan sensitivity policy
]);

// §10: editing tasa-global vigencias is restricted to super_admin (everything else is admin).
// F18: denied_parties (sanctions list) is also super_admin-only to prevent tampering.
const SUPER_ADMIN_CONFIG_KEYS = new Set(['tasa_vigencias', 'denied_parties']);

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
      res.status(403).json({ error: 'Solo el Super Admin puede modificar las vigencias de tasa global' });
      return;
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
