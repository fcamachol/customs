import 'dotenv/config';
import { Pool } from 'pg';

/**
 * One-shot, env-gated user seed.
 *
 * Reads SEED_USERS (a JSON array of [username, password_hash, role] tuples) and
 * upserts each row into the users table. Hashes are pre-computed (bcrypt) by the
 * operator, so no plaintext password is ever stored in config. Idempotent: an
 * existing username has its hash + role updated. No-op when SEED_USERS is unset.
 */
async function main(): Promise<void> {
  const raw = process.env.SEED_USERS;
  if (!raw || raw.trim() === '') {
    console.log('[seedUsers] SEED_USERS not set — skipping');
    return;
  }
  const users = JSON.parse(raw) as Array<[string, string, string]>;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    for (const [username, passwordHash, role] of users) {
      await pool.query(
        `INSERT INTO users (username, password_hash, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (username)
         DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role`,
        [username, passwordHash, role],
      );
      console.log(`[seedUsers] upserted ${username} (${role})`);
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
