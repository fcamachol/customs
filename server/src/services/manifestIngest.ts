import * as XLSX from 'xlsx';
import { validateManifest } from '../../../shared/parsing/validateManifest';
import type { IngestResult } from '../../../shared/types/staging';

// Server-only: turn workbook bytes into (header row, data rows) and validate.
export function ingestWorkbook(bytes: Buffer, mawb: string): IngestResult {
  const wb = XLSX.read(bytes, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '', blankrows: false });
  const headerRow = (aoa[0] ?? []).map((h) => String(h ?? '').trim());
  const dataRows = aoa.slice(1);
  return validateManifest(headerRow, dataRows, mawb);
}
