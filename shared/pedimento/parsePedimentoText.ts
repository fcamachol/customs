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
  const clave = /\bT1\b/.test(t) ? 'T1' : null;
  const rfcs = t.match(RFC_RE) ?? [];
  const importerRfc = rfcs[0] ?? null;     // first RFC on the page is the importer block

  const warnings: string[] = [];
  if (lines.length === 0) warnings.push('No se encontraron observaciones a nivel partida en el texto.');

  return {
    header: {
      numeroPedimento, clave, importerRfc,
      agentRfc: null, agencyRfc: null, patente: null,
      customsClearanceCode: null, tipoCambio: null,
      entryDate: null, paymentDate: null, totalBultos: null,
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
