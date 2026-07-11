import { Router } from 'express';
import { query } from '../db/pool';
import { verifyPassword } from '../auth/password';
import { signToken, signEnrollmentToken, signTokenForUser } from '../auth/token';
import { requireAuth, requireAuthAllowEnrollment, rejectEnrollmentScope } from '../auth/middleware';
import { recordAudit } from '../services/audit';
import { generateSecret, keyUri, verifyTotp } from '../auth/mfa';
import { loginLimiter } from '../middleware/rateLimit';
import { isPrivilegedRole, getMfaEnforcement, isDemoMode } from '../auth/roles';
import { validate } from '../validation/middleware';
import { mfaEnableBody } from '../validation/schemas';

export const authRouter = Router();

authRouter.post('/login', loginLimiter, async (req, res) => {
  const { username, password, code } = req.body ?? {};
  const { rows } = await query(
    `SELECT id, username, password_hash, role, mfa_secret, mfa_enabled, token_version FROM users WHERE username=$1`,
    [username],
  );
  const user = rows[0];
  if (!user || !(await verifyPassword(password ?? '', user.password_hash))) {
    res.status(401).json({ error: 'Invalid credentials' }); return;
  }
  // MFA second factor — required if already enrolled
  if (user.mfa_enabled) {
    if (!code || !verifyTotp(user.mfa_secret, code)) {
      res.status(401).json({ error: 'mfa_required' }); return;
    }
  } else if (isPrivilegedRole(user.role)) {
    // Privileged user without MFA: enforce or warn depending on env config
    const enforcement = getMfaEnforcement();
    if (enforcement === 'enforce') {
      // Issue a short-lived enrollment-scoped token, not a full session token
      const enrollmentToken = signEnrollmentToken(user as { id: string; role: import('../auth/token').Role; token_version: number });
      console.warn(`[MFA] Privileged user ${user.username} (${user.role}) logged in without MFA — issuing enrollment token`);
      res.status(403).json({ error: 'mfa_enrollment_required', enrollmentToken });
      return;
    } else {
      // warn mode: allow login but log a warning
      console.warn(`[MFA] WARN: Privileged user ${user.username} (${user.role}) logged in without MFA (enforcement=warn)`);
    }
  }
  await recordAudit({ userId: user.id, action: 'LOGIN', entity: 'session', ip: req.ip });
  const token = signToken({ userId: user.id, role: user.role, tv: user.token_version });
  res.json({ token, user: { id: user.id, username: user.username, role: user.role, demoMode: isDemoMode() } });
});

authRouter.get('/me', requireAuth, rejectEnrollmentScope, async (req, res) => {
  const { rows } = await query(`SELECT id, username, role, created_at FROM users WHERE id=$1`, [req.user!.userId]);
  // Narrow TOCTOU: the user can be deleted between requireAuth's lookup and this query.
  if (!rows[0]) { res.status(401).json({ error: 'User not found' }); return; }
  // demoMode tells the client whether the DEMO_MODE-gated reset UI should render.
  res.json({ ...rows[0], demoMode: isDemoMode() });
});

// POST /api/auth/logout — bumps token_version, invalidating all outstanding tokens (logout-all).
authRouter.post('/logout', requireAuth, rejectEnrollmentScope, async (req, res) => {
  const userId = req.user!.userId;
  await query(`UPDATE users SET token_version = token_version + 1 WHERE id=$1`, [userId]);
  await recordAudit({ userId, action: 'LOGOUT', entity: 'session', ip: req.ip });
  res.json({ ok: true });
});

// POST /api/auth/mfa/setup — generate a secret, store in DB (not yet enabled), return secret + otpauth URL
// Uses requireAuthAllowEnrollment so enrollment-scoped tokens (from privileged users without MFA) can access this.
authRouter.post('/mfa/setup', requireAuthAllowEnrollment, async (req, res) => {
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
// Uses requireAuthAllowEnrollment so enrollment-scoped tokens can complete the enrollment flow.
authRouter.post('/mfa/enable', requireAuthAllowEnrollment, validate({ body: mfaEnableBody }), async (req, res) => {
  const userId = req.user!.userId;
  const { code } = req.body;

  const { rows } = await query(`SELECT mfa_secret FROM users WHERE id=$1`, [userId]);
  const user = rows[0];
  if (!user?.mfa_secret) { res.status(400).json({ error: 'MFA not set up. Call /mfa/setup first.' }); return; }

  if (!verifyTotp(user.mfa_secret, code)) {
    res.status(400).json({ error: 'Invalid TOTP code' }); return;
  }

  await query(`UPDATE users SET mfa_enabled=true WHERE id=$1`, [userId]);
  await recordAudit({ userId, action: 'MFA_ENABLED', entity: 'user', entityId: userId, ip: req.ip });

  // Mint a FULL session token so the just-enrolled user can proceed without re-login.
  // Fetch fresh token_version in case it changed.
  const { rows: freshRows } = await query(
    `SELECT role, token_version FROM users WHERE id=$1`,
    [userId],
  );
  const freshUser = freshRows[0];
  const fullToken = signTokenForUser({ id: userId, role: freshUser.role, token_version: freshUser.token_version });

  res.json({ enabled: true, token: fullToken });
});
