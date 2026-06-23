import * as XLSX from 'xlsx';
import { resolveHeader } from '../../shared/parsing/headerSynonyms';

export interface MawbExtraction {
  mawb: string | null;
  ambiguous: boolean;
}

export async function extractMawb(file: File): Promise<MawbExtraction> {
  try {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '', blankrows: false });
    const headerRow = (aoa[0] ?? []).map((h) => String(h ?? '').trim());
    const colIdx = headerRow.findIndex((h) => resolveHeader(h) === 'core.mawb');
    if (colIdx === -1) return { mawb: null, ambiguous: false };
    const distinct = new Set(
      aoa.slice(1).map((r) => String(r[colIdx] ?? '').trim()).filter(Boolean),
    );
    if (distinct.size === 1) return { mawb: [...distinct][0], ambiguous: false };
    if (distinct.size > 1) return { mawb: null, ambiguous: true };
    return { mawb: null, ambiguous: false };
  } catch {
    return { mawb: null, ambiguous: false };
  }
}
