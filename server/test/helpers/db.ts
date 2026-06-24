import { pool } from '../../src/db/pool';

export async function truncateAll(): Promise<void> {
  await pool.query(
    `TRUNCATE users, audit_log, files, manifests, shipments, monthly_history, clients, client_platforms, config, pedimento_scans, validated_rfcs, manifest_staging_rows RESTART IDENTITY CASCADE`,
  );
}
