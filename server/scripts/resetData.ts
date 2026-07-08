import 'dotenv/config';
import { readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';

/**
 * One-shot, env-gated data reset: wipe every table EXCEPT users (and the
 * pgmigrations bookkeeping table), then clear the file-storage blobs so disk
 * state matches the emptied `files` table.
 *
 * Runs only when RESET_DATA_KEEP_USERS=true. The entrypoint invokes it on every
 * container start, so UNSET the variable immediately after the one reset you
 * wanted — otherwise each restart wipes again.
 *
 * After truncation it re-inserts the empty `denied_parties` config row that
 * migration 1700002100000 guarantees (the row's absence breaks the catalogs
 * endpoint contract and the risk engine's first load).
 */
async function main(): Promise<void> {
  if (process.env.RESET_DATA_KEEP_USERS !== 'true') {
    console.log('[resetData] RESET_DATA_KEEP_USERS not "true" — skipping');
    return;
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const { rows } = await pool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables
       WHERE schemaname = 'public' AND tablename NOT IN ('users', 'pgmigrations')
       ORDER BY tablename`,
    );
    if (rows.length === 0) {
      console.log('[resetData] nothing to truncate');
    } else {
      const tables = rows.map((r) => `"${r.tablename}"`).join(', ');
      console.log(`[resetData] truncating ${rows.length} tables: ${tables}`);
      await pool.query(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
    }

    // Restore the invariant from migration 1700002100000_denied_parties_seed.
    await pool.query(
      `INSERT INTO config (key, value, updated_at)
       VALUES ('denied_parties', '[]'::jsonb, now())
       ON CONFLICT (key) DO NOTHING`,
    );

    const users = await pool.query('SELECT username, role FROM users ORDER BY role, username');
    console.log('[resetData] users kept:', JSON.stringify(users.rows));
  } finally {
    await pool.end();
  }

  // Blobs are orphaned once `files` is truncated — remove them so the volume
  // doesn't accumulate unreachable artifacts.
  const storageDir = resolve(process.env.FILE_STORAGE_DIR ?? './storage');
  try {
    const entries = await readdir(storageDir);
    for (const entry of entries) {
      await rm(join(storageDir, entry), { recursive: true, force: true });
    }
    console.log(`[resetData] cleared file storage at ${storageDir} (${entries.length} entries)`);
  } catch (err) {
    // Missing dir is fine; anything else is worth surfacing but not fatal —
    // the DB reset (the part that matters for consistency) already committed.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[resetData] could not clear file storage:', err instanceof Error ? err.message : err);
    }
  }

  console.log('[resetData] DONE — unset RESET_DATA_KEEP_USERS now to prevent re-wipes on restart.');
}

main().catch((err) => {
  console.error('[resetData] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
