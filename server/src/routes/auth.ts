import { Router } from 'express';
import { query } from '../db/pool';
import { verifyPassword } from '../auth/password';
import { signToken } from '../auth/token';
import { requireAuth } from '../auth/middleware';
import { recordAudit } from '../services/audit';

export const authRouter = Router();

authRouter.post('/login', async (req, res) => {
  const { username, password } = req.body ?? {};
  const { rows } = await query(`SELECT id, username, password_hash, role FROM users WHERE username=$1`, [username]);
  const user = rows[0];
  if (!user || !(await verifyPassword(password ?? '', user.password_hash))) {
    res.status(401).json({ error: 'Invalid credentials' }); return;
  }
  await recordAudit({ userId: user.id, action: 'LOGIN', entity: 'session', ip: req.ip });
  const token = signToken({ userId: user.id, role: user.role });
  res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
});

authRouter.get('/me', requireAuth, async (req, res) => {
  const { rows } = await query(`SELECT id, username, role, created_at FROM users WHERE id=$1`, [req.user!.userId]);
  res.json(rows[0]);
});
