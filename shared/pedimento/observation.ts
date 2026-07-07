export interface ObservationInput {
  guideId: string;
  valueUsd: number;
  consigneeName: string;
  id: string;               // RFC or CURP
}

export function partidaObservation(i: ObservationInput): string {
  const value = i.valueUsd.toFixed(2);
  return `GUIA ${i.guideId} VALOR ${value} USD NOMBRE ${i.consigneeName.toUpperCase()} RFC-CURP ${i.id}`;
}

// Punctuation/accent tolerance only: an optional colon after each label (GUIA:/VALOR:/NOMBRE:/
// RFC-CURP:), the accented GUÍA, and the RFC-CURP / RFC/CURP / RFC CURP separator variants. A
// different agente aduanal writes these variations; we accept them but NOT semantic wording
// changes — a different label (e.g. DESTINATARIO for NOMBRE) still fails, because a wrong field
// mapping is worse than no data.
const OBS_RE = /^GU[IÍ]A:?\s+(\S+)\s+VALOR:?\s+([\d.,]+)\s+USD\s+NOMBRE:?\s+(.+?)\s+RFC[-/\s]CURP:?\s+(\S+)\s*$/;

export function parseObservation(line: string): ObservationInput | null {
  const m = (line ?? '').trim().match(OBS_RE);
  if (!m) return null;
  return {
    guideId: m[1],
    valueUsd: Number(m[2].replace(/,/g, '')),
    consigneeName: m[3].trim(),
    id: m[4],
  };
}

// pdf-parse wraps long observation lines (the RFC-CURP tail lands on the next line), so scanning
// must run over whitespace-collapsed text instead of per-line ^…$ anchors. Same punctuation/accent
// tolerance as OBS_RE (colons, GUÍA, RFC-CURP/RFC/CURP/RFC CURP); note the collapsed text turns the
// RFC CURP separator into a single space, which [-/\s] matches.
const OBS_SCAN_RE = /\bGU[IÍ]A:?\s+(\S+)\s+VALOR:?\s+([\d.,]+)\s+USD\s+NOMBRE:?\s+(.+?)\s+RFC[-/\s]CURP:?\s+(\S+)/g;

export function scanObservations(text: string): ObservationInput[] {
  const t = (text ?? '').replace(/\s+/g, ' ');
  return [...t.matchAll(OBS_SCAN_RE)].map((m) => ({
    guideId: m[1],
    valueUsd: Number(m[2].replace(/,/g, '')),
    consigneeName: m[3].trim(),
    id: m[4],
  }));
}
