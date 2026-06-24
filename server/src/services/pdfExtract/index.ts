import { PDFParse } from 'pdf-parse';
import { parsePedimentoText } from '../../../../shared/pedimento/parsePedimentoText';
import { parseSubdivision } from '../../../../shared/pedimento/subdivision';
import type { ExtractedPedimento } from '../../../../shared/types/reports';

export function extractFromText(fullText: string): ExtractedPedimento {
  const base = parsePedimentoText(fullText);
  const subdivision = parseSubdivision(fullText);
  const coveredGuias = [...new Set(base.lines.map((l) => l.guia).filter(Boolean))] as string[];
  return { ...base, subdivision, coveredGuias };
}

export async function getPdfText(buffer: Buffer): Promise<string> {
  const r = await new PDFParse({ data: new Uint8Array(buffer) }).getText();
  return r.text;
}

export async function extractPedimento(buffer: Buffer): Promise<ExtractedPedimento> {
  return extractFromText(await getPdfText(buffer));
}
