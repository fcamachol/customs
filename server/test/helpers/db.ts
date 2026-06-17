import { pool } from '../../src/db/pool';

export async function truncateAll(): Promise<void> {
  await pool.query(
    `TRUNCATE users, audit_log, files, manifests, shipments, monthly_history RESTART IDENTITY CASCADE`,
  );
}
