import * as XLSX from 'xlsx';

export interface RiskRow {
  Guia: string;
  Destinatario: string;
  Resultado: string;
  Motivo: string;
}

function workbook(rows: Record<string, unknown>[]): Buffer {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Hoja1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

export function buildRiskWorkbook(rows: RiskRow[]): Buffer {
  return workbook(rows as unknown as Record<string, unknown>[]);
}

export function buildGenericWorkbook(rows: Record<string, unknown>[]): Buffer {
  return workbook(rows);
}
