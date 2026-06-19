import { Router } from 'express';
import { query } from '../db/pool';
import { hashPassword } from '../auth/password';
import { requireAuth, requireRole } from '../auth/middleware';
import { recordAudit } from '../services/audit';

export const usersRouter = Router();

usersRouter.post('/', requireAuth, requireRole('admin'), async (req, res) => {
  const { username, password, role } = req.body ?? {};
  if (!['capturista', 'admin', 'autoridad'].includes(role)) { res.status(400).json({ error: 'Invalid role' }); return; }
  const hash = await hashPassword(password);
  const { rows } = await query(`INSERT INTO users (username, password_hash, role) VALUES ($1,$2,$3) RETURNING id, username, role`, [username, hash, role]);
  await recordAudit({ userId: req.user!.userId, action: 'CREATE_USER', entity: 'user', entityId: rows[0].id, after: rows[0], ip: req.ip });
  res.status(201).json(rows[0]);
});
