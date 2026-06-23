import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { ingestWorkbook } from '../../src/services/manifestIngest';

function buildXlsx(aoa: unknown[][]): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Hoja1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

describe('ingestWorkbook', () => {
  it('reads a workbook and validates rows', () => {
    const bytes = buildXlsx([
      ['Número de guía de embarque', 'Descripción del Producto', 'Código HS', 'Número de productos', 'Valor total declarado', 'Divisa', 'Código de país del remitente'],
      ['G1', 'Camisa', '6109100022', '1', '6.03', 'Dólar estadounidense', 'CN'],
    ]);
    const r = ingestWorkbook(bytes, 'MAWB');
    expect(r.counts.total).toBe(1);
    expect(r.rows[0].shipment.guideId).toBe('G1');
    expect(r.rows[0].shipment.currency).toBe('USD');
  });
});
