const ORDINALS: Record<string, number> = {
  PRIMERA: 1, SEGUNDA: 2, TERCERA: 3, CUARTA: 4, QUINTA: 5,
  SEXTA: 6, SEPTIMA: 7, 'SÉPTIMA': 7, OCTAVA: 8, NOVENA: 9, DECIMA: 10, 'DÉCIMA': 10,
};

export function normPedimentoNumero(s: string): string {
  return (s ?? '').replace(/\D/g, '');
}

export interface SubdivisionInfo {
  masterGuide: string | null;
  ordinal: number | null;
  isLast: boolean;
  siblings: string[];
  bultos: number | null;
  pesoBrutoKg: number | null;
}

export interface GuiaList {
  masterGuide: string | null;
  houseGuias: string[];
}

// Parse the "(GUIA/ORDEN EMBARQUE)/ID:" list: `<value> M` marks the master guide and `<value> H`
// the covered house guías. Multi-page consolidados fragment the list with page headers, so houses
// are collected by a global scan rather than consuming a contiguous run. Guía-shaped tokens (≥8
// chars containing a digit) keep short `<code> H` identificador rows (e.g. "EP H") out; the master
// stays anchored to the "ID:" label.
export function parseGuiaList(text: string): GuiaList {
  const t = (text ?? '').replace(/\s+/g, ' ');
  const master = t.match(/\bID:?\s*([A-Z0-9][A-Z0-9-]{5,})\s+M\b/i);
  const houseGuias: string[] = [];
  const seen = new Set<string>();
  for (const m of t.matchAll(/\b([A-Z0-9][A-Z0-9-]{7,})\s+H\b/g)) {
    if (!/\d/.test(m[1]) || seen.has(m[1])) continue;
    seen.add(m[1]);
    houseGuias.push(m[1]);
  }
  return { masterGuide: master ? master[1] : null, houseGuias };
}

export function parseSubdivision(text: string): SubdivisionInfo {
  // Collapse line breaks / runs of whitespace so cross-line anchors match.
  const t = (text ?? '').replace(/\s+/g, ' ').toUpperCase();
  const empty: SubdivisionInfo = { masterGuide: null, ordinal: null, isLast: false, siblings: [], bultos: null, pesoBrutoKg: null };

  const sub = t.match(/\b(PRIMERA|SEGUNDA|TERCERA|CUARTA|QUINTA|SEXTA|S[ÉE]PTIMA|OCTAVA|NOVENA|D[ÉE]CIMA)(\s+Y\s+[ÚU]LTIMA)?\s+SUBDIVISION/);
  if (!sub) return empty;
  const ordinal = ORDINALS[sub[1]] ?? null;
  const isLast = !!sub[2] || /\b[ÚU]LTIMA\s+SUBDIVISION/.test(t);

  const master = t.match(/GUIA\s+MASTER\s+NO\.?\s+([0-9][0-9-]+)/);
  const bultos = t.match(/(\d+)\s+BULTOS/);
  const peso = t.match(/PESO\s+DE\s+([\d.,]+)\s+KG/);

  let siblings: string[] = [];
  const rel = t.match(/SE\s+RELACIONA\s+CON\s+LOS\s+PEDIMENTOS\s+(.+?)\./);
  if (rel) {
    siblings = rel[1]
      .split(/\s+Y\s+|,/)
      .map(normPedimentoNumero)
      .filter((n) => n.length === 15);
  }

  return {
    masterGuide: master ? master[1] : null,
    ordinal,
    isLast,
    siblings,
    bultos: bultos ? parseInt(bultos[1], 10) : null,
    pesoBrutoKg: peso ? parseFloat(peso[1].replace(',', '')) : null,
  };
}
