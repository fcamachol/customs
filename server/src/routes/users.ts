import { Router } from 'express';
import { query } from '../db/pool';
import { hashPassword } from '../auth/password';
import { requireAuth, requireRole } from '../auth/middleware';
import { recordAudit } from '../services/audit';
import { isPrivilegedRole } from '../auth/roles';

export const usersRouter = Router();

usersRouter.post('/', requireAuth, requireRole('admin'), async (req, res) => {
  const { username, password, role } = req.body ?? {};
  if (!['capturista', 'admin', 'autoridad'].includes(role)) { res.status(400).json({ error: 'Invalid role' }); return; }
  const hash = await hashPassword(password);
  const { rows } = await query(`INSERT INTO users (username, password_hash, role) VALUES ($1,$2,$3) RETURNING id, username, role`, [username, hash, role]);
  // F10: Record MFA-pending audit note for privileged users — enforcement happens at first login.
  const auditNote = isPrivilegedRole(role) ? { mfaPending: true } : undefined;
  await recordAudit({ userId: req.user!.userId, action: 'CREATE_USER', entity: 'user', entityId: rows[0].id, after: { ...rows[0], ...auditNote }, ip: req.ip });
  res.status(201).json(rows[0]);
});

// PATCH /api/users/:id/role — update a user's role and bump token_version to invalidate outstanding tokens.
usersRouter.patch('/:id/role', requireAuth, requireRole('admin'), async (req, res) => {
  const { id } = req.params;
  const { role } = req.body ?? {};
  if (!['capturista', 'admin', 'autoridad'].includes(role)) {
    res.status(400).json({ error: 'Invalid role' }); return;
  }
  const { rows } = await query(
    `UPDATE users SET role=$1, token_version = token_version + 1 WHERE id=$2 RETURNING id, username, role`,
    [role, id],
  );
  if (!rows[0]) { res.status(404).json({ error: 'User not found' }); return; }
  await recordAudit({ userId: req.user!.userId, action: 'UPDATE_ROLE', entity: 'user', entityId: id, after: rows[0], ip: req.ip });
  res.json(rows[0]);
});
