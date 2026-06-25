import 'dotenv/config';
import { Pool } from 'pg';
import { hashPassword } from '../src/auth/password';

/**
 * One-shot, env-gated user seed.
 *
 * Reads SEED_USERS_B64 — a base64-encoded JSON array of [username, password, role]
 * tuples — decodes it, hashes each password in-container with the app's own bcrypt
 * (so rounds/format always match login verification), and upserts the rows.
 *
 * Base64 is used deliberately: a raw JSON value containing bcrypt hashes ($2b$12$…)
 * gets mangled by env-var `$`-interpolation when injected into the container, which
 * silently corrupts the stored hash and breaks login. Base64 has no `$`, so it is
 * immune. Idempotent (upsert by username); no-op when SEED_USERS_B64 is unset.
 */
async function main(): Promise<void> {
  const b64 = process.env.SEED_USERS_B64;
  if (!b64 || b64.trim() === '') {
    console.log('[seedUsers] SEED_USERS_B64 not set — skipping');
    return;
  }
  const users = JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as Array<[string, string, string]>;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    // Diagnostic: show the currently-stored hash prefix so a corrupted hash is visible.
    const before = await pool.query('SELECT username, left(password_hash, 7) AS hash_prefix FROM users ORDER BY username');
    console.log('[seedUsers] existing hash prefixes:', JSON.stringify(before.rows));

    for (const [username, password, role] of users) {
      const passwordHash = await hashPassword(password);
      await pool.query(
        `INSERT INTO users (username, password_hash, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (username)
         DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role`,
        [username, passwordHash, role],
      );
      console.log(`[seedUsers] upserted ${username} (${role}) hash=${passwordHash.slice(0, 7)}…`);
    }
    const { rows } = await pool.query('SELECT username, role FROM users ORDER BY role, username');
    console.log('[seedUsers] users now:', JSON.stringify(rows));
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[seedUsers] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
