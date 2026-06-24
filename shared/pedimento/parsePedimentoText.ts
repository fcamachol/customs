import type { ExtractedPedimento, ExtractedPedimentoLine } from '../types/reports';
import type { SubdivisionInfo } from './subdivision';
import { parseObservation } from './observation';

const emptySubdivision: SubdivisionInfo = {
  masterGuide: null,
  ordinal: null,
  isLast: false,
  siblings: [],
  bultos: null,
  pesoBrutoKg: null,
};

const NUMERO_RE = /\b(\d{2})\s+(\d{2})\s+(\d{4})\s+(\d{7})\b/;       // "25 85 1653 5001684"
const RFC_RE = /\b[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}\b/g;

export function parsePedimentoText(text: string): ExtractedPedimento {
  const t = text ?? '';
  const lines: ExtractedPedimentoLine[] = [];
  for (const raw of t.split(/\r?\n/)) {
    const obs = parseObservation(raw);
    if (obs) lines.push({ guia: obs.guideId, valueUsd: obs.valueUsd, consigneeName: obs.consigneeName, id: obs.id });
  }

  const num = t.match(NUMERO_RE);
  const numeroPedimento = num ? num[1] + num[2] + num[3] + num[4] : null;
  // Patente is the 4-digit group of the pedimento number ("25 85 1653 5001684" → "1653").
  const patente = num ? num[3] : null;
  // Tipo de cambio: the first decimal token with ≥4 decimals (e.g. "20.45680"). The peso bruto in
  // the same cluster carries ≤3 decimals, so ≥4 isolates the exchange rate. Best-effort.
  const tcMatch = t.match(/\b\d{1,3}\.\d{4,6}\b/);
  const tipoCambio = tcMatch ? Number(tcMatch[0]) : null;
  const clave = /\bT1\b/.test(t) ? 'T1' : null;
  const rfcs = t.match(RFC_RE) ?? [];
  const importerRfc = rfcs[0] ?? null;     // first RFC on the page is the importer block

  // FECHAS block: first dd/mm/yyyy = ENTRADA, second = PAGO. Normalize to ISO. Best-effort.
  const isoDates = [...t.matchAll(/\b(\d{2})\/(\d{2})\/(\d{4})\b/g)].map((m) => `${m[3]}-${m[2]}-${m[1]}`);
  const entryDate = isoDates[0] ?? null;
  const paymentDate = isoDates[1] ?? null;

  const warnings: string[] = [];
  if (lines.length === 0) warnings.push('No se encontraron observaciones a nivel partida en el texto.');

  return {
    header: {
      numeroPedimento, clave, importerRfc,
      agentRfc: null, agencyRfc: null, patente,
      customsClearanceCode: null, tipoCambio,
      entryDate, paymentDate, totalBultos: null,
    },
    lines,
    extractionMethod: 'deterministic',
    usedPositional: false,
    confidence: lines.length > 0 ? 0.9 : 0.1,
    warnings,
    subdivision: emptySubdivision,
    coveredGuias: [],
  };
}
