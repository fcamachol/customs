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


/**
 * Decide cómo entregarle los bytes a SheetJS.
 *
 * EL PROBLEMA: un CSV en UTF-8 sin BOM llegaba con los acentos rotos. SheetJS adivina la
 * codificación de un CSV y, sin BOM, asume CP1252: los dos bytes de "Ñ" (c3 91) se leen como dos
 * caracteres distintos y el nombre queda doblemente codificado ("MAGAÃ‘A"). No es cosmético — el
 * nombre del consignatario es PII cifrada Y uno de los campos que la reconciliación compara contra
 * el pedimento, así que corromperlo produce discrepancias FALSAS.
 *
 * POR QUÉ NO BASTA `codepage: 65001`: la distribución de `xlsx` que usa este proyecto no incluye
 * las tablas de codepage (avisa "Codepage tables are not loaded"), así que ese parámetro se ignora
 * en silencio — el peor tipo de arreglo, el que parece aplicado y no hace nada.
 *
 * LA SOLUCIÓN: decodificar nosotros. Los formatos binarios se reconocen por sus bytes mágicos
 * (ZIP "PK" para .xlsx, el encabezado OLE para .xls) y se pasan tal cual; cualquier otra cosa es
 * texto, se decodifica como UTF-8 —quitando el BOM si lo trae— y se entrega ya decodificada.
 */
function readArgs(bytes: Buffer): [Buffer | string, XLSX.ParsingOptions] {
  const esZip = bytes.length > 1 && bytes[0] === 0x50 && bytes[1] === 0x4b; // "PK" → xlsx/xlsm/xlsb
  const esOle = bytes.length > 1 && bytes[0] === 0xd0 && bytes[1] === 0xcf; // .xls (BIFF/OLE2)
  if (esZip || esOle) return [bytes, { type: 'buffer' }];
  const texto = bytes.toString('utf-8').replace(/^\uFEFF/, '');
  return [texto, { type: 'string' }];
}

// Server-only: turn workbook bytes into (header row, data rows) and validate.
// A workbook may carry notes/instructions sheets before the real manifest, so every sheet is scored
// by how many headers resolve; the best-scoring sheet is ingested (ties resolve to the earliest).
export function ingestWorkbook(bytes: Buffer, mawb: string, extraMappings?: Record<string, string>): IngestResult {
  const wb = XLSX.read(...readArgs(bytes));
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
