import * as XLSX from 'xlsx';

export interface RiskRow {
  Guia: string;
  Destinatario: string;
  'Descripción de la mercancía'?: string;
  Resultado: string;
  Motivo: string;
}

export interface BrandingHeader {
  companyName?: string;
  rfc?: string;
}

function workbook(rows: Record<string, unknown>[], branding?: BrandingHeader): Buffer {
  const wb = XLSX.utils.book_new();

  if (branding && (branding.companyName || branding.rfc)) {
    // Insert a branding header row above the data rows
    const headerRow: Record<string, unknown> = {
      Empresa: branding.companyName ?? '',
      RFC: branding.rfc ?? '',
    };
    const allRows = [headerRow, {}, ...rows];
    const ws = XLSX.utils.json_to_sheet(allRows);
    XLSX.utils.book_append_sheet(wb, ws, 'Hoja1');
  } else {
    const ws = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, 'Hoja1');
  }

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

export function buildRiskWorkbook(rows: RiskRow[], branding?: BrandingHeader): Buffer {
  return workbook(rows as unknown as Record<string, unknown>[], branding);
}

export function buildGenericWorkbook(rows: Record<string, unknown>[], branding?: BrandingHeader): Buffer {
  return workbook(rows, branding);
}
