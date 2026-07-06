import { pool } from '../../src/db/pool';

export async function truncateAll(): Promise<void> {
  await pool.query(
    `TRUNCATE users, audit_log, files, manifests, shipments, monthly_history, clients, client_platforms, config, pedimento_scans, pedimentos, validated_rfcs, manifest_staging_rows, agentes_aduanales, importadores RESTART IDENTITY CASCADE`,
  );
}
