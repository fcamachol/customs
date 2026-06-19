import { query } from '../db/pool';
import { canonicalPayload, rowHash, type AuditEntry } from './audit';

export async function verifyAuditChain(): Promise<{ ok: boolean; brokenAtId?: string; chainStartsAtId?: string }> {
  const { rows } = await query<any>(
    `SELECT id, user_id, action, entity, entity_id, before, after, ip_address, prev_hash, hash, created_at
     FROM audit_log ORDER BY id`);
  let prevHash: string | null = null;
  let started = false;
  let chainStartsAtId: string | undefined;
  for (const r of rows) {
    // Pre-chain era: rows written before the hash-chain migration have hash IS NULL.
    // Treat leading NULL-hash rows as outside the chain and start verifying at the
    // first hashed row. A NULL hash AFTER the chain has started is a break.
    if (!started) {
      if (r.hash == null) continue;
      started = true;
      chainStartsAtId = String(r.id);
    }
    if (r.hash == null) return { ok: false, brokenAtId: String(r.id), chainStartsAtId };
    const e: AuditEntry = { userId: r.user_id, action: r.action, entity: r.entity ?? undefined,
      entityId: r.entity_id ?? undefined, before: r.before ?? undefined, after: r.after ?? undefined, ip: r.ip_address };
    const payload = canonicalPayload(e, new Date(r.created_at).toISOString());
    if (r.prev_hash !== prevHash || r.hash !== rowHash(prevHash, payload)) {
      return { ok: false, brokenAtId: String(r.id), chainStartsAtId };
    }
    prevHash = r.hash;
  }
  return { ok: true, chainStartsAtId };
}
