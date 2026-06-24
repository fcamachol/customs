import { describe, it, expect } from 'vitest';
import { crossCheckEntities } from './entityCrossCheck';

const importer = { rfc: 'ADM130509UQ0' };
const agent = { patente: '1653', agentRfc: 'GUMM710831UYA', agencyRfc: 'GLG1502247K9' };

describe('crossCheckEntities', () => {
  it('no mismatch when extracted matches the configured entities (case-insensitive)', () => {
    const r = crossCheckEntities(
      { importerRfc: 'adm130509uq0', agentRfc: null, agencyRfc: null, patente: '1653' }, importer, agent);
    expect(r).toEqual({ importerRfcMismatch: false, agentRfcMismatch: false, agencyRfcMismatch: false, patenteMismatch: false });
  });
  it('flags importerRfc + patente mismatches', () => {
    const r = crossCheckEntities(
      { importerRfc: 'WRONG010101AAA', agentRfc: null, agencyRfc: null, patente: '9999' }, importer, agent);
    expect(r.importerRfcMismatch).toBe(true);
    expect(r.patenteMismatch).toBe(true);
  });
  it('makes no claim when the extracted field is null', () => {
    const r = crossCheckEntities(
      { importerRfc: null, agentRfc: null, agencyRfc: null, patente: null }, importer, agent);
    expect(r).toEqual({ importerRfcMismatch: false, agentRfcMismatch: false, agencyRfcMismatch: false, patenteMismatch: false });
  });
  it('makes no claim when the configured entity is null', () => {
    const r = crossCheckEntities(
      { importerRfc: 'ADM130509UQ0', agentRfc: 'GUMM710831UYA', agencyRfc: 'GLG1502247K9', patente: '1653' }, null, null);
    expect(r.importerRfcMismatch).toBe(false);
    expect(r.agentRfcMismatch).toBe(false);
  });
});
