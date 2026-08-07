import { describe, expect, it } from 'vitest';
import {
  CODIGOS_MANIFIESTO,
  CODIGOS_VUELO,
  cotejarManifiesto,
  mergeDiscrepancias,
  tieneError,
  type Discrepancia,
} from './cotejo';

const declarado = { cartones: 63, piezas: 1910, pesoKg: 52.64 };
const manifiesto = { cartones: 63, piezas: 1910, pesoKg: 52.64, lineas: 40 };
const codes = (ds: Discrepancia[]) => ds.map((d) => d.codigo);
const bySeverity = (ds: Discrepancia[], s: string) => ds.filter((d) => d.severidad === s);

describe('cotejarManifiesto — agreement is silent', () => {
  it('raises nothing when the email matches the manifest', () => {
    expect(cotejarManifiesto(declarado, manifiesto)).toEqual([]);
  });
});

describe('PA-01 / PA-02 — counts compare exactly', () => {
  it('fires an error on a carton mismatch, even by one', () => {
    const ds = cotejarManifiesto(declarado, { ...manifiesto, cartones: 62 });
    expect(codes(ds)).toContain('PA-01');
    expect(tieneError(ds)).toBe(true);
    expect(ds[0].detalle).toMatchObject({ declarado: 63, manifiesto: 62, diferencia: -1 });
  });

  it('fires an error on a piece mismatch', () => {
    const ds = cotejarManifiesto(declarado, { ...manifiesto, piezas: 1900 });
    expect(codes(ds)).toContain('PA-02');
    expect(bySeverity(ds, 'error')).toHaveLength(1);
  });

  it('can fire on both counts at once', () => {
    const ds = cotejarManifiesto(declarado, { ...manifiesto, cartones: 1, piezas: 2 });
    expect(codes(ds)).toEqual(['PA-01', 'PA-02']);
  });
});

describe('PA-03 — weight gets a proportional tolerance', () => {
  it('accepts drift inside the tolerance, because kilos legitimately round', () => {
    // 52.64 vs 52.70 is ~0.11 %, under the 0.5 % default.
    expect(codes(cotejarManifiesto(declarado, { ...manifiesto, pesoKg: 52.7 }))).not.toContain('PA-03');
  });

  it('fires an error outside the tolerance', () => {
    const ds = cotejarManifiesto(declarado, { ...manifiesto, pesoKg: 57 });
    const pa03 = ds.find((d) => d.codigo === 'PA-03');
    expect(pa03?.severidad).toBe('error');
    expect(pa03?.detalle).toMatchObject({ declarado: 52.64, manifiesto: 57 });
  });

  it('honours a caller-supplied tolerance', () => {
    const m = { ...manifiesto, pesoKg: 53.0 }; // ~0.68 %
    expect(codes(cotejarManifiesto(declarado, m, { pesoToleranciaPct: 0.001 }))).toContain('PA-03');
    expect(codes(cotejarManifiesto(declarado, m, { pesoToleranciaPct: 0.02 }))).not.toContain('PA-03');
  });

  it('measures against the larger side so a tiny declared weight cannot game the tolerance', () => {
    // Declaring 1 kg against a real 570 kg must be a hard error, not 0.5 % of 1 kg.
    const ds = cotejarManifiesto({ ...declarado, pesoKg: 1 }, { ...manifiesto, pesoKg: 570 });
    expect(ds.find((d) => d.codigo === 'PA-03')?.severidad).toBe('error');
  });
});

describe('not-evaluable is reported, never silently passed', () => {
  it('says so when the email declared no piezas', () => {
    const ds = cotejarManifiesto({ ...declarado, piezas: null }, manifiesto);
    const pa02 = ds.find((d) => d.codigo === 'PA-02');
    expect(pa02?.severidad).toBe('informativa');
    expect(pa02?.mensaje).toMatch(/No evaluable/);
    expect(tieneError(ds)).toBe(false);
  });

  it('says so when the manifest offers no carton basis', () => {
    // This is the real case: `bulto` unpopulated means no carton count can be derived, and inventing
    // one from the line count would produce a false red flag.
    const ds = cotejarManifiesto(declarado, { ...manifiesto, cartones: null });
    const pa01 = ds.find((d) => d.codigo === 'PA-01');
    expect(pa01?.severidad).toBe('informativa');
    expect(tieneError(ds)).toBe(false);
  });

  it('says so when there is no manifest at all', () => {
    const ds = cotejarManifiesto(declarado, null);
    expect(codes(ds)).toEqual(['PA-01']);
    expect(ds[0].severidad).toBe('advertencia');
    expect(ds[0].mensaje).toMatch(/no hay manifiesto/);
  });

  it('says so when the manifest carries no weight', () => {
    const ds = cotejarManifiesto(declarado, { ...manifiesto, pesoKg: 0 });
    expect(ds.find((d) => d.codigo === 'PA-03')?.severidad).toBe('informativa');
  });
});

describe('mergeDiscrepancias — rule families compose without clobbering each other', () => {
  const flight: Discrepancia[] = [{ codigo: 'PA-04', severidad: 'error', mensaje: 'ruta' }];
  const manifest: Discrepancia[] = [{ codigo: 'PA-02', severidad: 'error', mensaje: 'piezas' }];

  it('a flight refresh preserves the manifest findings', () => {
    const merged = mergeDiscrepancias([...manifest, ...flight], flight, CODIGOS_VUELO);
    expect(codes(merged).sort()).toEqual(['PA-02', 'PA-04']);
  });

  it('a manifest re-cotejo preserves the flight findings', () => {
    const merged = mergeDiscrepancias([...manifest, ...flight], manifest, CODIGOS_MANIFIESTO);
    expect(codes(merged).sort()).toEqual(['PA-02', 'PA-04']);
  });

  it('replaces rather than accumulates its own codes across repeated runs', () => {
    let set: Discrepancia[] = [];
    for (let i = 0; i < 4; i++) set = mergeDiscrepancias(set, manifest, CODIGOS_MANIFIESTO);
    expect(set.filter((d) => d.codigo === 'PA-02')).toHaveLength(1);
  });

  it('clears a family’s findings when a later run is clean', () => {
    const merged = mergeDiscrepancias([...manifest, ...flight], [], CODIGOS_MANIFIESTO);
    expect(codes(merged)).toEqual(['PA-04']);
  });

  it('tolerates a null starting set', () => {
    expect(codes(mergeDiscrepancias(null, manifest, CODIGOS_MANIFIESTO))).toEqual(['PA-02']);
  });
});
