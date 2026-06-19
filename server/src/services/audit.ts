import { createHash } from 'node:crypto';
import { withTransaction } from '../db/tx';

export interface AuditEntry {
  userId: string | null; action: string; entity?: string; entityId?: string;
  before?: unknown; after?: unknown; ip?: string | null;
}

export function canonicalPayload(e: AuditEntry, createdAtIso: string): string {
  return JSON.stringify({
    userId: e.userId ?? null, action: e.action, entity: e.entity ?? null,
    entityId: e.entityId ?? null, before: e.before ?? null, after: e.after ?? null,
    ip: e.ip ?? null, createdAt: createdAtIso,
  });
}
export function rowHash(prevHash: string | null, payload: string): string {
  return createHash('sha256').update((prevHash ?? '') + payload).digest('hex');
}

export async function recordAudit(e: AuditEntry): Promise<void> {
  await withTransaction(async (q) => {
    await q('SELECT pg_advisory_xact_lock(91234567)'); // serialize chain appends
    const prev = await q('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1');
    const prevHash: string | null = prev.rows[0]?.hash ?? null;
    const createdAt = new Date().toISOString();
    const payload = canonicalPayload(e, createdAt);
    const hash = rowHash(prevHash, payload);
    await q(
      `INSERT INTO audit_log (user_id, action, entity, entity_id, before, after, ip_address, prev_hash, hash, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [e.userId, e.action, e.entity ?? null, e.entityId ?? null,
       e.before ? JSON.stringify(e.before) : null, e.after ? JSON.stringify(e.after) : null,
       e.ip ?? null, prevHash, hash, createdAt]);
  });
}
