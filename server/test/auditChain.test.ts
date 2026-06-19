import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '../src/db/pool';
import { recordAudit } from '../src/services/audit';
import { verifyAuditChain } from '../src/services/auditVerify';

describe('audit hash chain', () => {
  beforeEach(async () => { await query('TRUNCATE audit_log RESTART IDENTITY CASCADE'); });
  it('links each row to the previous hash and verifies intact', async () => {
    await recordAudit({ userId: null, action: 'LOGIN', ip: '10.0.0.1' });
    await recordAudit({ userId: null, action: 'RUN_RISK', entity: 'manifest', entityId: 'm1', ip: '10.0.0.2' });
    const { rows } = await query<{ prev_hash: string|null; hash: string; ip_address: string }>(
      'SELECT prev_hash, hash, ip_address FROM audit_log ORDER BY id');
    expect(rows[0].prev_hash).toBeNull();
    expect(rows[1].prev_hash).toBe(rows[0].hash);
    expect(rows[1].ip_address).toBe('10.0.0.2');
    expect((await verifyAuditChain()).ok).toBe(true);
  });
  it('verifies intact for a multi-key after payload (order-invariant hash)', async () => {
    await recordAudit({ userId: null, action: 'LOGIN', ip: '10.0.0.1' });
    await recordAudit({
      userId: null, action: 'RUN_RISK', entity: 'manifest', entityId: 'm1', ip: '10.0.0.2',
      after: { analizados: 3, aprobados: 1, validarEnPrevio: 1, rojos: 1 },
    });
    expect((await verifyAuditChain()).ok).toBe(true);
  });
  it('treats leading NULL-hash rows as a pre-chain era and verifies the rest', async () => {
    // seed a legacy row written before the hash-chain migration (no hash)
    await query(
      `INSERT INTO audit_log (user_id, action, entity, entity_id) VALUES (null, 'LEGACY', null, null)`);
    await recordAudit({ userId: null, action: 'LOGIN', ip: '10.0.0.1' });
    await recordAudit({ userId: null, action: 'RUN_RISK', entity: 'manifest', entityId: 'm1', ip: '10.0.0.2' });
    const result = await verifyAuditChain();
    expect(result.ok).toBe(true);
    expect(result.chainStartsAtId).toBeDefined();
  });
  it('detects tampering when a payload is mutated', async () => {
    await recordAudit({ userId: null, action: 'LOGIN', ip: '10.0.0.1' });
    // simulate storage-layer tampering by disabling the append-only trigger
    await query('ALTER TABLE audit_log DISABLE TRIGGER audit_no_update_delete');
    await query(`UPDATE audit_log SET action='HACKED' WHERE id=(SELECT min(id) FROM audit_log)`);
    await query('ALTER TABLE audit_log ENABLE TRIGGER audit_no_update_delete');
    expect((await verifyAuditChain()).ok).toBe(false);
  });
});
