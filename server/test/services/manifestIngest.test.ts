import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { ingestWorkbook } from '../../src/services/manifestIngest';

function buildXlsx(aoa: unknown[][]): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Hoja1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

function buildMultiSheetXlsx(sheets: { name: string; aoa: unknown[][] }[]): Buffer {
  const wb = XLSX.utils.book_new();
  for (const s of sheets) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s.aoa), s.name);
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

  const HDR = ['Número de guía de embarque', 'Descripción del Producto', 'Código HS', 'Número de productos', 'Valor total declarado', 'Divisa', 'Código de país del remitente'];
  const row = (guia: unknown) => [guia, 'Camisa', '6109100022', '1', '6.03', 'Dólar estadounidense', 'CN'];

  it('preserves a long numeric guía cell without scientific notation (join key must not corrupt)', () => {
    // A guía column Excel typed as a number arrives as a JS number. String() renders values ≥ 1e21
    // in scientific notation ("1e+21"), which would silently break every downstream guía match.
    const bytes = buildXlsx([HDR, row(1000000000000000000000)]);
    const r = ingestWorkbook(bytes, 'MAWB');
    expect(r.rows[0].shipment.guideId).toBe('1000000000000000000000');
    expect(r.rows[0].shipment.guideId).not.toMatch(/[eE]\+/);
  });

  it('round-trips a mid-range numeric guía exactly', () => {
    const bytes = buildXlsx([HDR, row(36900100000)]);
    const r = ingestWorkbook(bytes, 'MAWB');
    expect(r.rows[0].shipment.guideId).toBe('36900100000');
  });

  it('keeps the formatted text of a text-typed guía (leading zeros survive when the source is text)', () => {
    // aoa_to_sheet stores a JS string as a text cell (type 's'), so it reaches us verbatim.
    const bytes = buildXlsx([HDR, row('0012345')]);
    const r = ingestWorkbook(bytes, 'MAWB');
    expect(r.rows[0].shipment.guideId).toBe('0012345');
  });

  it('reports the (only) sheet name and no skipped sheets for a single-sheet workbook', () => {
    const r = ingestWorkbook(buildXlsx([HDR, row('G1')]), 'MAWB');
    expect(r.sheetName).toBe('Hoja1');
    expect(r.skippedSheets).toEqual([]);
  });
});

describe('ingestWorkbook multi-sheet selection', () => {
  const HDR = ['Número de guía de embarque', 'Descripción del Producto', 'Código HS', 'Número de productos', 'Valor total declarado', 'Divisa', 'Código de país del remitente'];
  const row = ['G1', 'Camisa', '6109100022', '1', '6.03', 'Dólar estadounidense', 'CN'];

  it('ingests the mappable sheet, not a leading notes/instructions sheet', () => {
    const bytes = buildMultiSheetXlsx([
      { name: 'Instrucciones', aoa: [['Lea esto primero'], ['columna sin sentido']] },
      { name: 'Datos', aoa: [HDR, row] },
    ]);
    const r = ingestWorkbook(bytes, 'MAWB');
    expect(r.sheetName).toBe('Datos');
    expect(r.skippedSheets).toEqual(['Instrucciones']);
    expect(r.counts.total).toBe(1);
    expect(r.rows[0].shipment.guideId).toBe('G1');
  });

  it('breaks a tie by choosing the earliest sheet', () => {
    const bytes = buildMultiSheetXlsx([
      { name: 'Primera', aoa: [HDR, row] },
      { name: 'Segunda', aoa: [HDR, row] },
    ]);
    const r = ingestWorkbook(bytes, 'MAWB');
    expect(r.sheetName).toBe('Primera');
    expect(r.skippedSheets).toEqual(['Segunda']);
  });

  it('counts client-mapped headers toward a sheet score', () => {
    const CH = HDR.map((h) => (h === 'Descripción del Producto' ? 'Detalle Mercancía' : h));
    // Without the mapping "Datos" would still win by the other headers, so remove them all but one
    // in the notes sheet and give the data sheet only the mapped header to prove it counts.
    const bytes = buildMultiSheetXlsx([
      { name: 'Notas', aoa: [['algo'], ['x']] },
      { name: 'Datos', aoa: [CH, ['G1', 'Camisa', '6109100022', '1', '6.03', 'Dólar estadounidense', 'CN']] },
    ]);
    const extra = { 'detalle mercancia': 'core.description' };
    const r = ingestWorkbook(bytes, 'MAWB', extra);
    expect(r.sheetName).toBe('Datos');
    expect(r.rows[0].shipment.description).toBe('Camisa');
  });
});
