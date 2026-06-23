import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { extractMawb } from './extractMawb';

function makeFile(rows: unknown[][]): File {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  return new File([buf], 'm.xlsx', {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

describe('extractMawb', () => {
  it('returns the single MWB value when the column is uniform', async () => {
    const file = makeFile([['MWB', 'Codigo HS'], ['369-94705516', '1'], ['369-94705516', '2']]);
    expect(await extractMawb(file)).toEqual({ mawb: '369-94705516', ambiguous: false });
  });

  it('returns null without ambiguity when there is no MWB column', async () => {
    const file = makeFile([['Codigo HS', 'Divisa'], ['1', 'USD']]);
    expect(await extractMawb(file)).toEqual({ mawb: null, ambiguous: false });
  });

  it('flags ambiguous when the MWB column has multiple distinct values', async () => {
    const file = makeFile([['MWB'], ['369-1'], ['369-2']]);
    expect(await extractMawb(file)).toEqual({ mawb: null, ambiguous: true });
  });

  it('returns null on an unreadable file', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'bad.xlsx');
    expect(await extractMawb(file)).toEqual({ mawb: null, ambiguous: false });
  });
});
