import { Router } from 'express';
import { query } from '../db/pool';
import { requireAuth, requireRole } from '../auth/middleware';
import { recordAudit } from '../services/audit';
import { validate } from '../validation/middleware';
import { headerMappingCreateBody } from '../validation/schemas';
import { normalize, CANONICAL_PATHS } from '../../../shared/parsing/headerSynonyms';
import { HEADER_MAPPING_COLS } from '../services/headerMappings';

export const headerMappingsRouter = Router();

// GET /api/header-mappings?clientId=... — list the mappings that apply to a client (its own rows +
// global rows). Omit clientId to list only the global rows. Admin-only (management surface).
headerMappingsRouter.get('/', requireAuth, requireRole('admin'), async (req, res) => {
  const clientId = typeof req.query.clientId === 'string' && req.query.clientId ? req.query.clientId : null;
  const { rows } = await query(
    `SELECT ${HEADER_MAPPING_COLS} FROM client_header_mappings
     WHERE client_id IS NULL OR client_id = $1
     ORDER BY client_id NULLS FIRST, header_normalized`,
    [clientId],
  );
  res.json(rows);
});

// POST /api/header-mappings — admin. Create/replace a mapping (per-client when clientId is given,
// else global). The header is stored normalized; the canonical_path must be one the parser knows.
headerMappingsRouter.post(
  '/',
  requireAuth,
  requireRole('admin'),
  validate({ body: headerMappingCreateBody }),
  async (req, res) => {
    const { clientId, header, canonicalPath } = req.body;
    if (!CANONICAL_PATHS.includes(canonicalPath)) {
      res.status(400).json({ error: `Ruta canónica no reconocida: ${canonicalPath}` });
      return;
    }
    const headerNormalized = normalize(header);
    if (!headerNormalized) { res.status(400).json({ error: 'Encabezado vacío tras normalizar' }); return; }

    if (clientId) {
      const c = await query('SELECT id FROM clients WHERE id=$1', [clientId]);
      if (c.rows.length === 0) { res.status(404).json({ error: 'Client not found' }); return; }
    }

    // Upsert on the COALESCE(client_id, sentinel) unique index so re-saving a header just updates
    // its target path (the sentinel must match the migration's index expression exactly).
    const { rows } = await query(
      `INSERT INTO client_header_mappings (client_id, header_normalized, canonical_path, created_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (COALESCE(client_id, '00000000-0000-0000-0000-000000000000'::uuid), header_normalized)
       DO UPDATE SET canonical_path = EXCLUDED.canonical_path
       RETURNING ${HEADER_MAPPING_COLS}`,
      [clientId ?? null, headerNormalized, canonicalPath, req.user!.userId],
    );
    await recordAudit({
      userId: req.user!.userId, action: 'UPSERT_HEADER_MAPPING', entity: 'client_header_mapping',
      entityId: rows[0].id, after: rows[0], ip: req.ip,
    });
    res.status(201).json(rows[0]);
  },
);

// DELETE /api/header-mappings/:id — admin.
headerMappingsRouter.delete('/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const { id } = req.params;
  const before = await query('SELECT * FROM client_header_mappings WHERE id=$1', [id]);
  if (before.rows.length === 0) { res.status(404).json({ error: 'Not found' }); return; }
  await query('DELETE FROM client_header_mappings WHERE id=$1', [id]);
  await recordAudit({
    userId: req.user!.userId, action: 'DELETE_HEADER_MAPPING', entity: 'client_header_mapping',
    entityId: id, before: before.rows[0], ip: req.ip,
  });
  res.json({ ok: true });
});
