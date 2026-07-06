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

const OBS_RE = /^GUIA\s+(\S+)\s+VALOR\s+([\d.,]+)\s+USD\s+NOMBRE\s+(.+?)\s+RFC-CURP\s+(\S+)\s*$/;

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
// must run over whitespace-collapsed text instead of per-line ^…$ anchors.
const OBS_SCAN_RE = /\bGUIA\s+(\S+)\s+VALOR\s+([\d.,]+)\s+USD\s+NOMBRE\s+(.+?)\s+RFC-CURP\s+(\S+)/g;

export function scanObservations(text: string): ObservationInput[] {
  const t = (text ?? '').replace(/\s+/g, ' ');
  return [...t.matchAll(OBS_SCAN_RE)].map((m) => ({
    guideId: m[1],
    valueUsd: Number(m[2].replace(/,/g, '')),
    consigneeName: m[3].trim(),
    id: m[4],
  }));
}
