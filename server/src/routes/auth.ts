import { Router } from 'express';
import { query } from '../db/pool';
import { verifyPassword } from '../auth/password';
import { signToken } from '../auth/token';
import { requireAuth } from '../auth/middleware';
import { recordAudit } from '../services/audit';
import { generateSecret, keyUri, verifyTotp } from '../auth/mfa';

export const authRouter = Router();

authRouter.post('/login', async (req, res) => {
  const { username, password, code } = req.body ?? {};
  const { rows } = await query(
    `SELECT id, username, password_hash, role, mfa_secret, mfa_enabled FROM users WHERE username=$1`,
    [username],
  );
  const user = rows[0];
  if (!user || !(await verifyPassword(password ?? '', user.password_hash))) {
    res.status(401).json({ error: 'Invalid credentials' }); return;
  }
  // MFA second factor
  if (user.mfa_enabled) {
    if (!code || !verifyTotp(user.mfa_secret, code)) {
      res.status(401).json({ error: 'mfa_required' }); return;
    }
  }
  await recordAudit({ userId: user.id, action: 'LOGIN', entity: 'session', ip: req.ip });
  const token = signToken({ userId: user.id, role: user.role });
  res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
});

authRouter.get('/me', requireAuth, async (req, res) => {
  const { rows } = await query(`SELECT id, username, role, created_at FROM users WHERE id=$1`, [req.user!.userId]);
  res.json(rows[0]);
});

// POST /api/auth/mfa/setup — generate a secret, store in DB (not yet enabled), return secret + otpauth URL
authRouter.post('/mfa/setup', requireAuth, async (req, res) => {
  const userId = req.user!.userId;
  const { rows } = await query(`SELECT username FROM users WHERE id=$1`, [userId]);
  const user = rows[0];
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }

  const secret = generateSecret();
  const otpauthUrl = keyUri(user.username, secret);

  // Store the secret (NOT enabling MFA yet)
  await query(`UPDATE users SET mfa_secret=$1 WHERE id=$2`, [secret, userId]);
  await recordAudit({ userId, action: 'MFA_SETUP', entity: 'user', entityId: userId, ip: req.ip });

  res.json({ secret, otpauthUrl });
});

// POST /api/auth/mfa/enable — verify code against stored secret; on success set mfa_enabled=true
authRouter.post('/mfa/enable', requireAuth, async (req, res) => {
  const userId = req.user!.userId;
  const { code } = req.body ?? {};

  const { rows } = await query(`SELECT mfa_secret FROM users WHERE id=$1`, [userId]);
  const user = rows[0];
  if (!user?.mfa_secret) { res.status(400).json({ error: 'MFA not set up. Call /mfa/setup first.' }); return; }

  if (!code || !verifyTotp(user.mfa_secret, code)) {
    res.status(400).json({ error: 'Invalid TOTP code' }); return;
  }

  await query(`UPDATE users SET mfa_enabled=true WHERE id=$1`, [userId]);
  await recordAudit({ userId, action: 'MFA_ENABLED', entity: 'user', entityId: userId, ip: req.ip });

  res.json({ enabled: true });
});
