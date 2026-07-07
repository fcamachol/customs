import { PDFParse } from 'pdf-parse';
import { parsePedimentoText } from '../../../../shared/pedimento/parsePedimentoText';
import { parseGuiaList, parseSubdivision } from '../../../../shared/pedimento/subdivision';
import type { ExtractedPedimento } from '../../../../shared/types/reports';

export function extractFromText(fullText: string): ExtractedPedimento {
  const base = parsePedimentoText(fullText);
  const subdivision = parseSubdivision(fullText);
  // Covered guías come from the partida observations when present (subdivision layout) and from
  // the (GUIA/ORDEN EMBARQUE) M/H list otherwise (consolidado layout, which has no GUIA/VALOR
  // observations). The list's M entry also supplies the master guide when the subdivision
  // observation text is absent.
  const guiaList = parseGuiaList(fullText);
  const coveredGuias = [...new Set(
    [...base.lines.map((l) => l.guia), ...guiaList.houseGuias].filter(Boolean),
  )] as string[];
  if (!subdivision.masterGuide && guiaList.masterGuide) subdivision.masterGuide = guiaList.masterGuide;
  return { ...base, subdivision, coveredGuias };
}

export async function getPdfText(buffer: Buffer): Promise<string> {
  const r = await new PDFParse({ data: new Uint8Array(buffer) }).getText();
  return r.text;
}

// Below this many non-whitespace characters the text layer is treated as absent (image-only scan).
// A real pedimento carries thousands of characters, so the threshold only trips on genuinely empty
// or near-empty extractions — never on a legitimately parsed document.
const TEXT_LAYER_MIN_CHARS = 50;

export async function extractPedimento(buffer: Buffer): Promise<ExtractedPedimento> {
  const text = await getPdfText(buffer);
  const extracted = extractFromText(text);
  // An image-only PDF does not throw in pdf-parse — getPdfText returns an empty/near-empty string,
  // so extraction quietly yields all-nulls and the pdf_unparseable path (which needs a thrown error)
  // never fires. Flag the missing text layer here so the upload route can warn distinctly.
  if (text.replace(/\s/g, '').length < TEXT_LAYER_MIN_CHARS) extracted.scannedNoTextLayer = true;
  return extracted;
}
