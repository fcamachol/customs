import { Router } from 'express';
import { query } from '../db/pool';
import { requireAuth, requireRole } from '../auth/middleware';

export const auditRouter = Router();

// Authority/admin audit-query endpoint: recent audit rows, newest first.
auditRouter.get('/', requireAuth, requireRole('autoridad', 'admin'), async (req, res) => {
  const conditions: string[] = [];
  const params: unknown[] = [];

  const action = req.query.action;
  if (typeof action === 'string' && action.length) {
    params.push(action);
    conditions.push(`action = $${params.length}`);
  }

  const entityId = req.query.entityId;
  if (typeof entityId === 'string' && entityId.length) {
    params.push(entityId);
    conditions.push(`entity_id = $${params.length}`);
  }

  let limit = Number.parseInt(String(req.query.limit ?? ''), 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 100;
  if (limit > 500) limit = 500;
  params.push(limit);
  const limitIdx = params.length;

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await query(
    `SELECT id, user_id AS "userId", action, entity, entity_id AS "entityId", created_at AS "createdAt"
     FROM audit_log ${where} ORDER BY created_at DESC, id DESC LIMIT $${limitIdx}`,
    params,
  );
  res.json(rows);
});
