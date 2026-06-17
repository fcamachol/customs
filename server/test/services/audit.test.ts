import { beforeEach, describe, expect, it } from 'vitest';
import { recordAudit } from '../../src/services/audit';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

describe('audit', () => {
  beforeEach(truncateAll);
  it('writes an append-only audit row', async () => {
    await recordAudit({ userId: null, action: 'LOGIN', entity: 'session' });
    const { rows } = await query('SELECT action, entity FROM audit_log');
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('LOGIN');
    expect(rows[0].entity).toBe('session');
  });
});
