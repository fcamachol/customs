import type { ExpectedPedimento, ExtractedPedimento, ReconciliationReport, LineResult, FieldDiff } from '../types/reports';

export interface ExpectedShipment {
  guideId: string;
  customsValueUsd: number;
  consignee: { name: string; rfc?: string | null; curp?: string | null };
}

export function buildExpectedFromManifest(shipments: ExpectedShipment[]): { expected: ExpectedPedimento; warnings: string[] } {
  const byGuia = new Map<string, { valueUsd: number; consigneeName: string; id: string; names: Set<string>; ids: Set<string> }>();
  for (const s of shipments) {
    const id = (s.consignee.curp ?? s.consignee.rfc ?? '') as string;
    const existing = byGuia.get(s.guideId);
    if (!existing) {
      byGuia.set(s.guideId, { valueUsd: s.customsValueUsd, consigneeName: s.consignee.name, id, names: new Set([s.consignee.name]), ids: new Set([id]) });
    } else {
      existing.valueUsd += s.customsValueUsd;
      existing.names.add(s.consignee.name);
      existing.ids.add(id);
    }
  }
  const warnings: string[] = [];
  const lines = [...byGuia.entries()].map(([guia, e]) => {
    if (e.names.size > 1) warnings.push(`Guía ${guia}: múltiples destinatarios en el manifiesto (${[...e.names].join(', ')})`);
    if (e.ids.size > 1) warnings.push(`Guía ${guia}: múltiples RFC/CURP en el manifiesto`);
    return { guia, valueUsd: Math.round(e.valueUsd * 100) / 100, consigneeName: e.consigneeName, id: e.id };
  });
  return { expected: { header: {}, lines }, warnings };
}

const norm = (s: string | null | undefined) => (s ?? '').trim().toUpperCase();

function numDiff(field: string, expected: number | null, actual: number | null): FieldDiff {
  const ok = expected != null && actual != null && Math.abs(expected - actual) < 0.01;
  return { field, expected, actual, ok };
}
function strDiff(field: string, expected: string | null, actual: string | null): FieldDiff {
  return { field, expected, actual, ok: norm(expected) === norm(actual) };
}

export function reconcile(
  expected: ExpectedPedimento,
  extracted: ExtractedPedimento,
  opts: { notes?: string[]; generatedAt?: string } = {},
): ReconciliationReport {
  const actualByGuia = new Map(extracted.lines.map((l) => [l.guia, l]));
  const expectedGuias = new Set(expected.lines.map((l) => l.guia));
  const lines: LineResult[] = [];

  for (const exp of expected.lines) {
    const act = actualByGuia.get(exp.guia);
    if (!act) { lines.push({ guia: exp.guia, status: 'missing_in_pedimento', diffs: [] }); continue; }
    const diffs: FieldDiff[] = [
      numDiff('valorUsd', exp.valueUsd, act.valueUsd),
      strDiff('nombre', exp.consigneeName, act.consigneeName),
      strDiff('rfcCurp', exp.id, act.id),
    ];
    lines.push({ guia: exp.guia, status: diffs.every((d) => d.ok) ? 'matched' : 'mismatch', diffs });
  }
  for (const act of extracted.lines) {
    if (!expectedGuias.has(act.guia)) lines.push({ guia: act.guia, status: 'extra_in_pedimento', diffs: [] });
  }

  const summary = {
    matched: lines.filter((l) => l.status === 'matched').length,
    mismatched: lines.filter((l) => l.status === 'mismatch').length,
    missingInPedimento: lines.filter((l) => l.status === 'missing_in_pedimento').length,
    extraInPedimento: lines.filter((l) => l.status === 'extra_in_pedimento').length,
    color: 'verde' as ReconciliationReport['summary']['color'],
  };
  if (extracted.lines.length === 0) summary.color = 'gris';
  else if (summary.mismatched || summary.missingInPedimento || summary.extraInPedimento) summary.color = 'amarillo';

  const expTotal = Math.round(expected.lines.reduce((a, l) => a + l.valueUsd, 0) * 100) / 100;
  const actTotal = Math.round(extracted.lines.reduce((a, l) => a + (l.valueUsd ?? 0), 0) * 100) / 100;

  return {
    generatedAt: opts.generatedAt ?? '',
    extractionMethod: extracted.extractionMethod,
    usedPositional: extracted.usedPositional,
    confidence: extracted.confidence,
    header: [],
    totals: [numDiff('totalValorUsd', expTotal, actTotal)],
    lines,
    summary,
    notes: opts.notes ?? [],
  };
}
