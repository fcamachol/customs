import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';
import {
  loadImporterOfRecord, loadCustomsAgent,
  upsertAgente, upsertImportador, findImportadoresDuplicados,
} from '../../src/services/entityMaster';

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

/**
 * RFC hygiene at the point of capture.
 *
 * These values are OCR'd off a pedimento PDF, so a single misread character yields a well-shaped
 * but invalid RFC. Persisting it is what produced the two failures seen in production: a pedimento
 * blocked at prevalidation by an agent RFC nobody could edit from the capture form, and two
 * importador rows for one company whose RFCs differed by one character.
 */
describe('entityMaster — RFC inválido al registrar entidades', () => {
  beforeEach(truncateAll);

  it('drops an agente RFC whose check digit does not match, keeping the row usable', async () => {
    const row = await upsertAgente({
      patente: '5108', name: 'COMERCIO EXTERIOR DEL PACIFICO Y CIA',
      agentRfc: 'VACI690503RH8',   // check digit should be A
      agencyRfc: 'CEP1006157B3',   // valid
    });
    expect(row).toMatchObject({ patente: '5108', agentRfc: null, agencyRfc: 'CEP1006157B3' });
  });

  it('keeps a valid agente RFC and normalizes it', async () => {
    const row = await upsertAgente({ patente: '5108', agentRfc: ' vaci690503rha ' });
    expect(row?.agentRfc).toBe('VACI690503RHA');
  });

  it('refuses to create an importador with an invalid RFC (no phantom row)', async () => {
    expect(await upsertImportador({ rfc: 'CCE180415AB2', name: 'CAPITAL CENTENNIALS SA DE CV' })).toBeNull();
    const { rows } = await query('SELECT count(*)::int AS n FROM importadores');
    expect(rows[0]).toMatchObject({ n: 0 });
  });

  it('still creates the importador when the RFC is valid', async () => {
    const row = await upsertImportador({ rfc: 'cce180415ab7', name: 'CAPITAL CENTENNIALS SA DE CV' });
    expect(row).toMatchObject({ rfc: 'CCE180415AB7' });
  });

  it('accepts the SAT generic RFC (ventas al público en general)', async () => {
    expect(await upsertImportador({ rfc: 'XAXX010101000', name: 'PUBLICO EN GENERAL' }))
      .toMatchObject({ rfc: 'XAXX010101000' });
  });
});

describe('findImportadoresDuplicados', () => {
  beforeEach(truncateAll);

  const insert = (rfc: string, name: string) =>
    query('INSERT INTO importadores (rfc, name) VALUES ($1,$2)', [rfc, name]);

  it('pairs the same company whose RFC differs by one character, naming which to keep', async () => {
    await insert('CCE180415AB7', 'CAPITAL CENTENNIALS SA DE CV'); // valid
    await insert('CCE180415AB2', 'CAPITAL CENTENNIALS SA DE CV'); // OCR artifact
    const dups = await findImportadoresDuplicados();
    expect(dups).toHaveLength(1);
    expect(dups[0].valido.rfc).toBe('CCE180415AB7');
    expect(dups[0].sospechoso.rfc).toBe('CCE180415AB2');
  });

  it('does not pair two different companies', async () => {
    await insert('CCE180415AB7', 'CAPITAL CENTENNIALS SA DE CV');
    await insert('LFB170822PT6', 'LOGISTICA FRONTERIZA DEL BAJIO SA DE CV');
    expect(await findImportadoresDuplicados()).toEqual([]);
  });

  // Both RFCs valid and one character apart is a real possibility (CDE180415AB7 passes the check
  // digit too). Reporting that pair would invite merging two genuinely different companies, so the
  // rule deliberately requires exactly one side to be invalid.
  it('does not pair two VALID RFCs one character apart — they may be distinct companies', async () => {
    await insert('CCE180415AB7', 'GRUPO X SA DE CV');
    await insert('CDE180415AB7', 'GRUPO X SA DE CV');
    expect(await findImportadoresDuplicados()).toEqual([]);
  });

  it('does not pair two INVALID RFCs — neither side can be trusted as the survivor', async () => {
    await insert('CCE180415AB2', 'GRUPO Y SA DE CV');
    await insert('CCE180415AB3', 'GRUPO Y SA DE CV');
    expect(await findImportadoresDuplicados()).toEqual([]);
  });
});
