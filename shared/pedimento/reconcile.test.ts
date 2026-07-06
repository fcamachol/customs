import { describe, it, expect } from 'vitest';
import { buildExpectedFromManifest, reconcile } from './reconcile';
import type { ExtractedPedimento } from '../types/reports';

const ship = (guideId: string, customsValueUsd: number, name: string, rfc: string) =>
  ({ guideId, customsValueUsd, consignee: { name, rfc, curp: null } });

const extracted = (lines: ExtractedPedimento['lines']): ExtractedPedimento => ({
  header: { numeroPedimento: null, clave: null, importerRfc: null, agentRfc: null, agencyRfc: null, patente: null, customsEntryCode: null, customsClearanceCode: null, agenteAduanal: null, tasaImportacion: null, tipoCambio: null, entryDate: null, paymentDate: null, totalBultos: null },
  lines, extractionMethod: 'deterministic', usedPositional: false, confidence: 0.9, warnings: [], subdivision: { masterGuide: null, ordinal: null, isLast: false, siblings: [], bultos: null, pesoBrutoKg: null }, coveredGuias: [],
});

describe('buildExpectedFromManifest', () => {
  it('aggregates multiple product rows of one guía into a single summed line', () => {
    const { expected } = buildExpectedFromManifest([
      ship('G1', 6.00, 'JUAN PEREZ', 'PEXJ800101AA1'),
      ship('G1', 6.50, 'JUAN PEREZ', 'PEXJ800101AA1'),
      ship('G2', 12.00, 'ANA LOPEZ', 'LOAA900202BB2'),
    ]);
    expect(expected.lines).toHaveLength(2);
    expect(expected.lines.find((l) => l.guia === 'G1')).toMatchObject({ valueUsd: 12.5, consigneeName: 'JUAN PEREZ', id: 'PEXJ800101AA1' });
    expect(expected.lines.find((l) => l.guia === 'G2')!.valueUsd).toBe(12);
  });
  it('warns when one guía spans differing consignees', () => {
    const { warnings } = buildExpectedFromManifest([
      ship('G1', 6.00, 'JUAN PEREZ', 'PEXJ800101AA1'),
      ship('G1', 6.00, 'OTRO NOMBRE', 'PEXJ800101AA1'),
    ]);
    expect(warnings.some((w) => w.includes('G1'))).toBe(true);
  });
  it('uses curp over rfc for the id when present', () => {
    const { expected } = buildExpectedFromManifest([
      { guideId: 'G3', customsValueUsd: 5, consignee: { name: 'X', rfc: 'RFC010101AAA', curp: 'CURP010101HDFAAA09' } },
    ]);
    expect(expected.lines[0].id).toBe('CURP010101HDFAAA09');
  });
});

describe('reconcile', () => {
  const expected = { header: {}, lines: [
    { guia: 'G1', valueUsd: 12.5, consigneeName: 'JUAN PEREZ', id: 'PEXJ800101AA1' },
    { guia: 'G2', valueUsd: 12,   consigneeName: 'ANA LOPEZ',  id: 'LOAA900202BB2' },
  ] };

  it('matches identical lines (case-insensitive, value within tolerance)', () => {
    const r = reconcile(expected, extracted([
      { guia: 'G1', valueUsd: 12.5, consigneeName: 'juan perez', id: 'pexj800101aa1' },
      { guia: 'G2', valueUsd: 12.0, consigneeName: 'ANA LOPEZ', id: 'LOAA900202BB2' },
    ]), { generatedAt: '2026-06-24T00:00:00Z' });
    expect(r.summary).toMatchObject({ matched: 2, mismatched: 0, missingInPedimento: 0, extraInPedimento: 0, color: 'verde' });
  });
  it('flags a value mismatch', () => {
    const r = reconcile(expected, extracted([
      { guia: 'G1', valueUsd: 99, consigneeName: 'JUAN PEREZ', id: 'PEXJ800101AA1' },
      { guia: 'G2', valueUsd: 12, consigneeName: 'ANA LOPEZ', id: 'LOAA900202BB2' },
    ]));
    expect(r.summary.mismatched).toBe(1);
    expect(r.summary.color).toBe('amarillo');
    const g1 = r.lines.find((l) => l.guia === 'G1')!;
    expect(g1.status).toBe('mismatch');
    expect(g1.diffs.find((d) => d.field === 'valorUsd')!.ok).toBe(false);
  });
  it('flags missing (in manifest, not in pedimento) and extra (in pedimento, not in manifest)', () => {
    const r = reconcile(expected, extracted([
      { guia: 'G1', valueUsd: 12.5, consigneeName: 'JUAN PEREZ', id: 'PEXJ800101AA1' },
      { guia: 'G9', valueUsd: 5, consigneeName: 'EXTRA', id: 'X' },
    ]));
    expect(r.summary.missingInPedimento).toBe(1); // G2
    expect(r.summary.extraInPedimento).toBe(1);   // G9
  });
  it('gris when the pedimento has no extracted lines', () => {
    const r = reconcile(expected, extracted([]));
    expect(r.summary.color).toBe('gris');
  });
  it('carries notes through', () => {
    const r = reconcile(expected, extracted([]), { notes: ['nota X'] });
    expect(r.notes).toContain('nota X');
  });
});

describe('reconcile — peso-rounded (approx) values from consolidado VAL ADU', () => {
  const expected = { header: {}, lines: [
    { guia: 'JMX300674063160', valueUsd: 53.52, consigneeName: 'MONTENEGRO QUINTERO ANGELICA MIREYA', id: 'MOQA961209MSL' },
  ] };
  it('accepts a small conversion delta when the line value is approximate', () => {
    const rep = reconcile(expected, extracted([
      { guia: 'JMX300674063160', valueUsd: 53.55, consigneeName: 'MONTENEGRO QUINTERO ANGELICA MIREYA', id: 'MOQA961209MSL', valueUsdApprox: true },
    ]));
    expect(rep.lines[0].status).toBe('matched');
  });
  it('still flags the same delta as mismatch for exact (non-approx) values', () => {
    const rep = reconcile(expected, extracted([
      { guia: 'JMX300674063160', valueUsd: 53.55, consigneeName: 'MONTENEGRO QUINTERO ANGELICA MIREYA', id: 'MOQA961209MSL' },
    ]));
    expect(rep.lines[0].status).toBe('mismatch');
  });
  it('keeps real discrepancies as mismatch even when approximate', () => {
    const rep = reconcile(expected, extracted([
      { guia: 'JMX300674063160', valueUsd: 31.58, consigneeName: 'MONTENEGRO QUINTERO ANGELICA MIREYA', id: 'MOQA961209MSL', valueUsdApprox: true },
    ]));
    expect(rep.lines[0].status).toBe('mismatch');
  });
});

describe('reconcile — name normalization and RFC/CURP identity', () => {
  it('matches names regardless of case, accents, and word order', () => {
    // Manifest: given names first, mixed case, accented. Pedimento: surnames first, uppercase,
    // unaccented — same person, must match.
    const { expected } = buildExpectedFromManifest([
      ship('G1', 10, 'Angélica Mireya Montenegro Quintero', 'MOQA961209MSL'),
    ]);
    const rep = reconcile(expected, extracted([
      { guia: 'G1', valueUsd: 10, consigneeName: 'MONTENEGRO QUINTERO ANGELICA MIREYA', id: 'MOQA961209MSL' },
    ]));
    expect(rep.lines[0].status).toBe('matched');
  });
  it('accepts the RFC when the manifest id preference picked the CURP (and vice versa)', () => {
    // buildExpectedFromManifest prefers curp for the primary id, but the pedimento may print
    // the RFC — either credential of the same consignee must reconcile.
    const { expected } = buildExpectedFromManifest([
      { guideId: 'G2', customsValueUsd: 5, consignee: { name: 'JUAN PEREZ', rfc: 'PESJ850315HH7', curp: 'PESJ850315HDFRRR09' } },
    ]);
    const rep = reconcile(expected, extracted([
      { guia: 'G2', valueUsd: 5, consigneeName: 'JUAN PEREZ', id: 'PESJ850315HH7' },
    ]));
    expect(rep.lines[0].status).toBe('matched');
  });
  it('still flags genuinely different names and ids as mismatch', () => {
    const { expected } = buildExpectedFromManifest([ship('G3', 5, 'JUAN PEREZ', 'PESJ850315HH7')]);
    const rep = reconcile(expected, extracted([
      { guia: 'G3', valueUsd: 5, consigneeName: 'MARIA LOPEZ', id: 'LOMM900101AA1' },
    ]));
    expect(rep.lines[0].status).toBe('mismatch');
    expect(rep.lines[0].diffs.filter((d) => !d.ok).map((d) => d.field)).toEqual(['nombre', 'rfcCurp']);
  });
});

describe('reconcile — truncated CURP in the pedimento observation field', () => {
  it('accepts a 13-char truncation of the manifest CURP (real consolidado prints only 13)', () => {
    const { expected } = buildExpectedFromManifest([
      { guideId: 'JMX300676373341', customsValueUsd: 20, consignee: { name: 'DIANA ELISA GONZALEZ MARQUEZ', rfc: null, curp: 'GOMD960507MGTNRN04' } },
    ]);
    const rep = reconcile(expected, extracted([
      { guia: 'JMX300676373341', valueUsd: 20, consigneeName: 'GONZALEZ MARQUEZ DIANA ELISA', id: 'GOMD960507MGT' },
    ]));
    expect(rep.lines[0].status).toBe('matched');
  });
  it('rejects prefixes too short to be a credential', () => {
    const { expected } = buildExpectedFromManifest([
      { guideId: 'G1', customsValueUsd: 20, consignee: { name: 'DIANA ELISA GONZALEZ MARQUEZ', rfc: null, curp: 'GOMD960507MGTNRN04' } },
    ]);
    const rep = reconcile(expected, extracted([
      { guia: 'G1', valueUsd: 20, consigneeName: 'GONZALEZ MARQUEZ DIANA ELISA', id: 'GOMD9605' },
    ]));
    expect(rep.lines[0].status).toBe('mismatch');
  });
});
