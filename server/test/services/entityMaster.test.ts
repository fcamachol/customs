import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';
import { loadImporterOfRecord, loadCustomsAgent } from '../../src/services/entityMaster';

async function setConfig(key: string, value: unknown) {
  await query(`INSERT INTO config (key, value) VALUES ($1,$2)
               ON CONFLICT (key) DO UPDATE SET value=$2`, [key, JSON.stringify(value)]);
}

describe('entityMaster', () => {
  beforeEach(truncateAll);
  it('returns null when unset', async () => {
    expect(await loadImporterOfRecord()).toBeNull();
    expect(await loadCustomsAgent()).toBeNull();
  });
  it('returns the validated importer + agent when set', async () => {
    await setConfig('importer_of_record', { rfc: 'ADM130509UQ0', name: 'ADMERCE SA DE CV', fiscalAddress: 'CDMX' });
    await setConfig('customs_agent', { patente: '1653', name: 'GUZMOR', agentRfc: 'GUMM710831UYA', agencyRfc: 'GLG1502247K9' });
    expect(await loadImporterOfRecord()).toMatchObject({ rfc: 'ADM130509UQ0', fiscalAddress: 'CDMX' });
    expect(await loadCustomsAgent()).toMatchObject({ patente: '1653', agencyRfc: 'GLG1502247K9' });
  });
  it('returns null when the stored value fails the shape (defensive)', async () => {
    await setConfig('importer_of_record', { rfc: 'X' }); // missing name + fiscalAddress
    expect(await loadImporterOfRecord()).toBeNull();
  });
});
