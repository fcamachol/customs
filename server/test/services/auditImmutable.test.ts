import { beforeEach, describe, expect, it } from 'vitest';
import { recordAudit } from '../../src/services/audit';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

describe('audit immutability', () => {
  beforeEach(truncateAll);

  it('blocks UPDATE and DELETE on audit_log', async () => {
    await recordAudit({ userId: null, action: 'LOGIN' });
    await expect(query(`UPDATE audit_log SET action='X'`)).rejects.toThrow(/append-only/);
    await expect(query(`DELETE FROM audit_log`)).rejects.toThrow(/append-only/);
  });
});
