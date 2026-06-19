import { query } from '../db/pool';
import { canonicalPayload, rowHash, type AuditEntry } from './audit';

export async function verifyAuditChain(): Promise<{ ok: boolean; brokenAtId?: string }> {
  const { rows } = await query<any>(
    `SELECT id, user_id, action, entity, entity_id, before, after, ip_address, prev_hash, hash, created_at
     FROM audit_log ORDER BY id`);
  let prevHash: string | null = null;
  for (const r of rows) {
    const e: AuditEntry = { userId: r.user_id, action: r.action, entity: r.entity ?? undefined,
      entityId: r.entity_id ?? undefined, before: r.before ?? undefined, after: r.after ?? undefined, ip: r.ip_address };
    const payload = canonicalPayload(e, new Date(r.created_at).toISOString());
    if (r.prev_hash !== prevHash || r.hash !== rowHash(prevHash, payload)) return { ok: false, brokenAtId: String(r.id) };
    prevHash = r.hash;
  }
  return { ok: true };
}
