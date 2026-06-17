import { query } from '../db/pool';
export interface AuditEntry { userId: string | null; action: string; entity?: string; entityId?: string; before?: unknown; after?: unknown; }
export async function recordAudit(e: AuditEntry): Promise<void> {
  await query(
    `INSERT INTO audit_log (user_id, action, entity, entity_id, before, after) VALUES ($1, $2, $3, $4, $5, $6)`,
    [e.userId, e.action, e.entity ?? null, e.entityId ?? null, e.before ? JSON.stringify(e.before) : null, e.after ? JSON.stringify(e.after) : null],
  );
}
