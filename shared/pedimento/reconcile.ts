import type { ExpectedPedimento, ExtractedPedimento, ReconciliationReport, LineResult, FieldDiff } from '../types/reports';

export interface ExpectedShipment {
  guideId: string;
  customsValueUsd: number;
  consignee: { name: string; rfc?: string | null; curp?: string | null };
}

export function buildExpectedFromManifest(shipments: ExpectedShipment[]): { expected: ExpectedPedimento; warnings: string[] } {
  const byGuia = new Map<string, { valueUsd: number; consigneeName: string; id: string; names: Set<string>; ids: Set<string>; acceptedIds: Set<string> }>();
  for (const s of shipments) {
    const id = (s.consignee.curp ?? s.consignee.rfc ?? '') as string;
    const credentials = [s.consignee.rfc, s.consignee.curp].filter((c): c is string => !!c);
    const existing = byGuia.get(s.guideId);
    if (!existing) {
      byGuia.set(s.guideId, { valueUsd: s.customsValueUsd, consigneeName: s.consignee.name, id, names: new Set([s.consignee.name]), ids: new Set([id]), acceptedIds: new Set(credentials) });
    } else {
      existing.valueUsd += s.customsValueUsd;
      existing.names.add(s.consignee.name);
      existing.ids.add(id);
      credentials.forEach((c) => existing.acceptedIds.add(c));
    }
  }
  const warnings: string[] = [];
  const lines = [...byGuia.entries()].map(([guia, e]) => {
    if (e.names.size > 1) warnings.push(`Guía ${guia}: múltiples destinatarios en el manifiesto (${[...e.names].join(', ')})`);
    if (e.ids.size > 1) warnings.push(`Guía ${guia}: múltiples RFC/CURP en el manifiesto`);
    return { guia, valueUsd: Math.round(e.valueUsd * 100) / 100, consigneeName: e.consigneeName, id: e.id, acceptedIds: [...e.acceptedIds] };
  });
  return { expected: { header: {}, lines }, warnings };
}

// Uppercase, fold accents (JOSÉ → JOSE), collapse whitespace — pedimento text is unaccented
// uppercase while manifests arrive mixed-case accented.
const norm = (s: string | null | undefined) =>
  (s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toUpperCase();

// Word-order-insensitive name key: pedimentos print surnames first ("MONTENEGRO QUINTERO
// ANGELICA MIREYA") while manifests list given names first.
const nameKey = (s: string | null | undefined) => norm(s).split(' ').sort().join(' ');

function numDiff(field: string, expected: number | null, actual: number | null, tolerance = 0.01): FieldDiff {
  const ok = expected != null && actual != null && Math.abs(expected - actual) < tolerance;
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
    // Consolidado observation fields truncate 18-char CURPs to 13 chars, so a substantial
    // prefix (≥12 chars — initials, full birthdate, gender, state) of either side matches.
    const idMatches = (credential: string | null, actual: string | null) => {
      const c = norm(credential), a = norm(actual);
      if (!c || !a) return false;
      if (c === a) return true;
      const [shorter, longer] = c.length <= a.length ? [c, a] : [a, c];
      return shorter.length >= 12 && longer.startsWith(shorter);
    };
    const idOk = [exp.id, ...(exp.acceptedIds ?? [])].some((c) => idMatches(c, act.id));
    const diffs: FieldDiff[] = [
      // Consolidado values are back-converted from whole-peso VAL ADU, so allow the rounding delta.
      numDiff('valorUsd', exp.valueUsd, act.valueUsd, act.valueUsdApprox ? 0.05 : 0.01),
      { field: 'nombre', expected: exp.consigneeName, actual: act.consigneeName, ok: nameKey(exp.consigneeName) === nameKey(act.consigneeName) },
      // The pedimento may print either credential of the consignee (RFC or CURP).
      { field: 'rfcCurp', expected: exp.id, actual: act.id, ok: idOk },
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
