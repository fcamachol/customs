import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as XLSX from 'xlsx';
import { validateManifest } from './validateManifest';

describe('golden: real MANIFEST_TEST.xlsx', () => {
  const path = resolve(__dirname, '../../.playwright-mcp/MANIFEST_TEST.xlsx');
  const wb = XLSX.read(readFileSync(path), { type: 'buffer' });
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', blankrows: false });
  const header = (aoa[0] as unknown[]).map((h) => String(h ?? '').trim());
  const data = aoa.slice(1);

  it('ingests all 501 rows with 0 hard errors, origin warning on every row', () => {
    const r = validateManifest(header, data, 'GOLDEN');
    expect(r.fileRejected).toBe(false);
    expect(r.counts.total).toBe(501);
    expect(r.counts.error).toBe(0);
    expect(r.counts.warning).toBe(501); // every row carries the origin-undeclared warning
    expect(r.rows.every((row) => row.warnings.some((w) => w.code === 'origin_undeclared'))).toBe(true);
  });

  it('normalizes procedence/currency/weight and emits 501 distinct keys', () => {
    const r = validateManifest(header, data, 'GOLDEN');
    expect(r.rows[0].shipment.procedenceCountry).toBe('CN');
    expect(r.rows[0].shipment.currency).toBe('USD');
    expect(r.rows[0].shipment.weightKg).toBeCloseTo(0.245);
    expect(new Set(r.rows.map((row) => row.idempotencyKey)).size).toBe(501);
  });
});
