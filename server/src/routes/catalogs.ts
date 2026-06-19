import { Router } from 'express';
import { query } from '../db/pool';
import { requireAuth, requireRole } from '../auth/middleware';
import { recordAudit } from '../services/audit';

export const catalogsRouter = Router();

// GET /api/catalogs/clients — any authenticated role
catalogsRouter.get('/clients', requireAuth, async (req, res) => {
  const { rows } = await query(
    `SELECT id, name, tax_id, address, phone, email, platform, created_by, created_at
     FROM clients ORDER BY name`,
  );
  res.json(rows);
});

// POST /api/catalogs/clients — admin or capturista
catalogsRouter.post(
  '/clients',
  requireAuth,
  requireRole('admin', 'capturista'),
  async (req, res) => {
    const { name, tax_id, address, phone, email, platform } = req.body ?? {};
    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    const { rows } = await query(
      `INSERT INTO clients (name, tax_id, address, phone, email, platform, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, name, tax_id, address, phone, email, platform, created_by, created_at`,
      [name, tax_id ?? null, address ?? null, phone ?? null, email ?? null,
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
    const { name, tax_id, address, phone, email, platform } = req.body ?? {};

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
           platform = COALESCE($7, platform)
       WHERE id = $1
       RETURNING id, name, tax_id, address, phone, email, platform, created_by, created_at`,
      [id,
       name ?? null,
       tax_id ?? null,
       address ?? null,
       phone ?? null,
       email ?? null,
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
