import * as XLSX from 'xlsx';
import { validateManifest } from '../../../shared/parsing/validateManifest';
import { resolveHeader } from '../../../shared/parsing/headerSynonyms';
import type { IngestResult } from '../../../shared/types/staging';

// Read a sheet's first row as trimmed header strings (used both for scoring and for ingestion).
function readSheet(sheet: XLSX.WorkSheet): { headerRow: string[]; dataRows: unknown[][] } {
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '', blankrows: false });
  const headerRow = (aoa[0] ?? []).map((h) => String(h ?? '').trim());
  return { headerRow, dataRows: aoa.slice(1) };
}

// How many of a header row's cells resolve to a canonical path (client overrides included). This is
// the score that decides which sheet is the actual manifest.
function mappableCount(headerRow: string[], extraMappings?: Record<string, string>): number {
  return headerRow.reduce((n, h) => (h && resolveHeader(h, extraMappings) ? n + 1 : n), 0);
}

// Server-only: turn workbook bytes into (header row, data rows) and validate.
// A workbook may carry notes/instructions sheets before the real manifest, so every sheet is scored
// by how many headers resolve; the best-scoring sheet is ingested (ties resolve to the earliest).
export function ingestWorkbook(bytes: Buffer, mawb: string, extraMappings?: Record<string, string>): IngestResult {
  const wb = XLSX.read(bytes, { type: 'buffer' });
  const names = wb.SheetNames;

  let bestIndex = 0;
  let bestScore = -1;
  names.forEach((name, i) => {
    const { headerRow } = readSheet(wb.Sheets[name]);
    const score = mappableCount(headerRow, extraMappings);
    if (score > bestScore) { bestScore = score; bestIndex = i; } // strict > → earliest on ties
  });

  const chosenName = names[bestIndex];
  const { headerRow, dataRows } = readSheet(wb.Sheets[chosenName]);
  const result = validateManifest(headerRow, dataRows, mawb, extraMappings);
  return {
    ...result,
    sheetName: chosenName,
    skippedSheets: names.filter((_, i) => i !== bestIndex),
  };
}
