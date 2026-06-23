// shared/parsing/validateManifest.test.ts
import { describe, expect, it } from 'vitest';
import { validateManifest } from './validateManifest';

const H = ['Número de guía de embarque', 'Descripción del Producto', 'Código HS', 'Número de productos',
  'Valor total declarado', 'Divisa', 'Código de país del remitente', 'ID', 'Peso', 'Unidad de peso'];
const row = (over: Partial<Record<string, unknown>> = {}) => {
  const base: Record<string, unknown> = {
    'Número de guía de embarque': 'G1', 'Descripción del Producto': 'Camisa', 'Código HS': '6109100022',
    'Número de productos': '1', 'Valor total declarado': '6.03', 'Divisa': 'Dólar estadounidense',
    'Código de país del remitente': 'CN', 'ID': 'AERA790828HBSRBR04', 'Peso': '245', 'Unidad de peso': 'gramo',
  };
  return H.map((h) => (h in over ? over[h] : base[h]));
};

describe('validateManifest', () => {
  it('accepts a clean row with a país-de-origen warning', () => {
    const r = validateManifest(H, [row()], 'MAWB');
    expect(r.counts).toEqual({ total: 1, valid: 0, warning: 1, error: 0 });
    const sr = r.rows[0];
    expect(sr.status).toBe('warning');
    expect(sr.warnings.map((w) => w.code)).toContain('origin_undeclared');
    expect(sr.shipment.procedenceCountry).toBe('CN');
    expect(sr.shipment.currency).toBe('USD');
    expect(sr.shipment.weightKg).toBeCloseTo(0.245);
    expect(sr.idempotencyKey).toBe('MAWB|G1|1|6109100022');
  });
  it('errors on a non-numeric value', () => {
    const r = validateManifest(H, [row({ 'Valor total declarado': 'N/A' })], 'M');
    expect(r.rows[0].status).toBe('error');
    expect(r.rows[0].errors.map((e) => e.code)).toContain('value_not_a_number');
  });
  it('errors on locale-ambiguous value "1,000"', () => {
    const r = validateManifest(H, [row({ 'Valor total declarado': '1,000' })], 'M');
    expect(r.rows[0].errors.map((e) => e.code)).toContain('value_ambiguous');
  });
  it('errors on unknown currency and unknown country', () => {
    const r = validateManifest(H, [row({ 'Divisa': 'Quatloos', 'Código de país del remitente': 'ZZ' })], 'M');
    const codes = r.rows[0].errors.map((e) => e.code);
    expect(codes).toContain('currency_unknown');
    expect(codes).toContain('procedence_unknown');
  });
  it('errors on unknown weight unit', () => {
    const r = validateManifest(H, [row({ 'Unidad de peso': 'cubits' })], 'M');
    expect(r.rows[0].errors.map((e) => e.code)).toContain('weight_unit_unknown');
  });
  it('errors on blank required description', () => {
    const r = validateManifest(H, [row({ 'Descripción del Producto': '' })], 'M');
    expect(r.rows[0].errors.map((e) => e.code)).toContain('description_required');
  });
  it('warns (not errors) on a missing consignee identity', () => {
    const r = validateManifest(H, [row({ 'ID': '' })], 'M');
    expect(r.rows[0].warnings.map((w) => w.code)).toContain('identity_missing');
    expect(r.rows[0].status).not.toBe('error');
  });
  it('rejects the whole file on a duplicate mapped header', () => {
    const dupH = [...H, 'ID'];
    const r = validateManifest(dupH, [[...row(), 'PERJ800101AA8']], 'M');
    expect(r.fileRejected).toBe(true);
    expect(r.duplicateHeaders).toContain('ID');
  });
  it('assigns per-line lineSeq within the same guide', () => {
    const r = validateManifest(H, [row(), row()], 'M');
    expect(r.rows[0].idempotencyKey).toBe('M|G1|1|6109100022');
    expect(r.rows[1].idempotencyKey).toBe('M|G1|2|6109100022');
  });
});
