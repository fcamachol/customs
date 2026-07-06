import { beforeEach, describe, expect, it } from 'vitest';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

// The data-migration statements from 1700003400000_entity_catalogs.ts. Kept verbatim so this test
// exercises the exact SQL the migration runs (the migration itself is a one-shot at boot, so we
// re-run the seed step here against freshly-seeded config rows).
const SEED_AGENTE = `
  INSERT INTO agentes_aduanales (patente, name, agent_rfc, agency_rfc, verified)
  SELECT value->>'patente', value->>'name', value->>'agentRfc', value->>'agencyRfc', true
  FROM config WHERE key = 'customs_agent' AND COALESCE(value->>'patente', '') <> ''
  ON CONFLICT (patente) DO NOTHING`;
const SEED_IMPORTADOR = `
  INSERT INTO importadores (rfc, name, fiscal_address, verified)
  SELECT value->>'rfc', value->>'name', value->>'fiscalAddress', true
  FROM config WHERE key = 'importer_of_record' AND COALESCE(value->>'rfc', '') <> ''
  ON CONFLICT (rfc) DO NOTHING`;

describe('entity catalogs migration', () => {
  beforeEach(async () => { await truncateAll(); });

  it('enforces UNIQUE patente / rfc and defaults verified=false', async () => {
    await query(`INSERT INTO agentes_aduanales (patente) VALUES ('1653')`);
    const ag = await query<{ verified: boolean }>(`SELECT verified FROM agentes_aduanales WHERE patente='1653'`);
    expect(ag.rows[0].verified).toBe(false);
    await expect(query(`INSERT INTO agentes_aduanales (patente) VALUES ('1653')`)).rejects.toMatchObject({ code: '23505' });

    await query(`INSERT INTO importadores (rfc) VALUES ('ADM130509UQ0')`);
    const im = await query<{ verified: boolean }>(`SELECT verified FROM importadores WHERE rfc='ADM130509UQ0'`);
    expect(im.rows[0].verified).toBe(false);
    await expect(query(`INSERT INTO importadores (rfc) VALUES ('ADM130509UQ0')`)).rejects.toMatchObject({ code: '23505' });
  });

  it('data-migrates legacy config keys into verified rows', async () => {
    await query(`INSERT INTO config (key,value) VALUES ('customs_agent',$1)`,
      [JSON.stringify({ patente: '1653', name: 'GUZMOR', agentRfc: 'GUMM710831UYA', agencyRfc: 'GLG1502247K9' })]);
    await query(`INSERT INTO config (key,value) VALUES ('importer_of_record',$1)`,
      [JSON.stringify({ rfc: 'ADM130509UQ0', name: 'ADMERCE SA DE CV', fiscalAddress: 'CDMX' })]);

    await query(SEED_AGENTE);
    await query(SEED_IMPORTADOR);

    const ag = await query<{ name: string; agent_rfc: string; agency_rfc: string; verified: boolean }>(
      `SELECT name, agent_rfc, agency_rfc, verified FROM agentes_aduanales WHERE patente='1653'`);
    expect(ag.rows[0]).toMatchObject({ name: 'GUZMOR', agent_rfc: 'GUMM710831UYA', agency_rfc: 'GLG1502247K9', verified: true });

    const im = await query<{ name: string; fiscal_address: string; verified: boolean }>(
      `SELECT name, fiscal_address, verified FROM importadores WHERE rfc='ADM130509UQ0'`);
    expect(im.rows[0]).toMatchObject({ name: 'ADMERCE SA DE CV', fiscal_address: 'CDMX', verified: true });
  });

  it('skips config rows with no usable natural key', async () => {
    await query(`INSERT INTO config (key,value) VALUES ('customs_agent',$1)`, [JSON.stringify({ name: 'NO PATENTE' })]);
    await query(`INSERT INTO config (key,value) VALUES ('importer_of_record',$1)`, [JSON.stringify({ name: 'NO RFC' })]);
    await query(SEED_AGENTE);
    await query(SEED_IMPORTADOR);
    expect((await query(`SELECT id FROM agentes_aduanales`)).rows).toHaveLength(0);
    expect((await query(`SELECT id FROM importadores`)).rows).toHaveLength(0);
  });
});
