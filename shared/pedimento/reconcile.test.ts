import { describe, it, expect } from 'vitest';
import { buildExpectedFromManifest, reconcile } from './reconcile';
import type { ExtractedPedimento } from '../types/reports';

const ship = (guideId: string, customsValueUsd: number, name: string, rfc: string) =>
  ({ guideId, customsValueUsd, consignee: { name, rfc, curp: null } });

const extracted = (lines: { guia: string; valueUsd: number | null; consigneeName: string | null; id: string | null }[]): ExtractedPedimento => ({
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
