import { describe, expect, it } from 'vitest';
import { parsePrealerta, type LabelTarget } from './prealerta';

/**
 * Tests for the layout-, vocabulary- and label-independent behaviour.
 *
 * The parser was already order-independent by construction — shuffling lines changes nothing, because
 * the MAWB, route and flight are matched by shape. What these cover is the harder ground: a table
 * layout where values sit nowhere near their labels, a client whose wording we have never seen, and
 * the case where NO label matched and the fields have to be deduced from the quantities themselves.
 */

const codes = (r: ReturnType<typeof parsePrealerta>) => r.warnings.map((w) => w.code);

describe('layout independence — header row over value row', () => {
  it('reads a whitespace-aligned table', () => {
    const body = [
      'Master AWB: 160-94705516',
      'Cartons    Pieces    Gross Weight',
      '63         1910      52.64',
    ].join('\n');
    const { fields, provenance } = parsePrealerta({ textBody: body });
    expect(fields.cartones).toBe(63);
    expect(fields.piezas).toBe(1910);
    expect(fields.pesoKg).toBe(52.64);
    expect(provenance.piezas).toBe('etiqueta');
  });

  it('reads a pipe-delimited table, which is what an HTML table flattens to', () => {
    const body = [
      'AWB 160-94705516',
      'Cartons | Pieces | Weight',
      '63 | 1910 | 52.64',
    ].join('\n');
    const { fields } = parsePrealerta({ textBody: body });
    expect([fields.cartones, fields.piezas, fields.pesoKg]).toEqual([63, 1910, 52.64]);
  });

  it('reads a tab-delimited table', () => {
    const body = 'MAWB 160-94705516\nCartons\tPieces\tWeight\n63\t1910\t52.64';
    const { fields } = parsePrealerta({ textBody: body });
    expect([fields.cartones, fields.piezas, fields.pesoKg]).toEqual([63, 1910, 52.64]);
  });

  it('is column-order independent within the table', () => {
    const a = parsePrealerta({ textBody: 'MAWB 160-94705516\nPieces | Weight | Cartons\n1910 | 52.64 | 63' });
    const b = parsePrealerta({ textBody: 'MAWB 160-94705516\nCartons | Pieces | Weight\n63 | 1910 | 52.64' });
    expect(a.fields).toEqual(b.fields);
  });

  it('does not read ordinary prose as a table', () => {
    const body = 'MAWB 160-94705516\nplease confirm receipt of this shipment today\n63 1910 52.64';
    const { fields } = parsePrealerta({ textBody: body });
    // Two label matches are required before a line is treated as a header; prose has none.
    expect(provenanceOf(body, 'cartones')).not.toBe('etiqueta');
    expect(fields.mawb).toBe('16094705516');
  });
});

function provenanceOf(body: string, field: 'cartones' | 'piezas' | 'pesoKg') {
  return parsePrealerta({ textBody: body }).provenance[field];
}

describe('client vocabulary — taught, not hard-coded', () => {
  it('accepts per-client label overrides and marks them as such', () => {
    const extraMappings: Record<string, LabelTarget> = {
      'colli totali': 'cartones',
      'numero articoli': 'piezas',
      'massa lorda': 'pesoKg',
    };
    const body = [
      'MAWB 160-94705516',
      'Colli totali: 63',
      'Numero articoli: 1910',
      'Massa lorda: 52.64',
    ].join('\n');
    const { fields, provenance } = parsePrealerta({ textBody: body, extraMappings });
    expect([fields.cartones, fields.piezas, fields.pesoKg]).toEqual([63, 1910, 52.64]);
    expect(provenance.cartones).toBe('etiqueta_cliente');
  });

  it('lets a client override win over a built-in synonym', () => {
    // A client that uses "Peso" to mean piece count would otherwise be read as weight.
    const { fields, provenance } = parsePrealerta({
      textBody: 'MAWB 160-94705516\nPeso: 1910',
      extraMappings: { peso: 'piezas' },
    });
    expect(fields.piezas).toBe(1910);
    expect(fields.pesoKg).toBeUndefined();
    expect(provenance.piezas).toBe('etiqueta_cliente');
  });
});

describe('Tier 3 — semantic inference when no label matched', () => {
  it('infers ETD and ETA from time order, because departure precedes arrival', () => {
    // Deliberately unlabelled and listed arrival-first, so appearance order contradicts time order.
    const body = 'MAWB 160-94705516\nHKG-NLU\n2026-08-18\n2026-08-16';
    const { fields, provenance } = parsePrealerta({ textBody: body });
    expect(fields.etdOrigen?.slice(0, 10)).toBe('2026-08-16');
    expect(fields.etaPais?.slice(0, 10)).toBe('2026-08-18');
    expect(provenance.etdOrigen).toBe('inferido_orden');
    expect(provenance.etaPais).toBe('inferido_orden');
  });

  it('does not infer dates when only one is present', () => {
    const r = parsePrealerta({ textBody: 'MAWB 160-94705516\n2026-08-18' });
    expect(codes(r)).toContain('etd_no_encontrado');
  });

  it('never overrides a labelled date with an inference', () => {
    const body = 'MAWB 160-94705516\nDeparture: 2026-08-16\n2026-08-01\n2026-08-18';
    const { fields, provenance } = parsePrealerta({ textBody: body });
    expect(fields.etdOrigen?.slice(0, 10)).toBe('2026-08-16');
    expect(provenance.etdOrigen).toBe('etiqueta');
  });

  it('infers weight from an adjacent mass unit', () => {
    const { fields, provenance } = parsePrealerta({ textBody: 'MAWB 160-94705516\n63 / 1910 / 52.64 KG' });
    expect(fields.pesoKg).toBe(52.64);
    expect(provenance.pesoKg).toBe('inferido_propiedad');
  });

  it('converts pounds to kilograms rather than storing the wrong unit', () => {
    const { fields } = parsePrealerta({ textBody: 'MAWB 160-94705516\nGross Weight: 1000 lbs' });
    expect(fields.pesoKg).toBeCloseTo(453.592, 2);
  });

  it('assigns pieces and cartons by magnitude, because a carton holds pieces', () => {
    const { fields, provenance } = parsePrealerta({ textBody: 'MAWB 160-94705516\n63 1910 52.64 KG' });
    expect(fields.cartones).toBe(63);
    expect(fields.piezas).toBe(1910);
    expect(provenance.piezas).toBe('inferido_propiedad');
  });

  it('refuses to guess when two integers are too close to distinguish', () => {
    // 63 vs 64 carries no signal about which is which; a coin flip here would be worse than a gap.
    const r = parsePrealerta({ textBody: 'MAWB 160-94705516\n63 64' });
    expect(r.fields.cartones).toBeUndefined();
    expect(r.fields.piezas).toBeUndefined();
    expect(codes(r)).toContain('piezas_no_encontrado');
  });

  it('never overrides a labelled count with an inference', () => {
    const { fields, provenance } = parsePrealerta({
      textBody: 'MAWB 160-94705516\nPieces: 1910\n63 99999 52.64 KG',
    });
    expect(fields.piezas).toBe(1910);
    expect(provenance.piezas).toBe('etiqueta');
  });
});

describe('provenance is always recorded', () => {
  it('marks shape-derived fields as such', () => {
    const { provenance } = parsePrealerta({ textBody: 'MAWB 160-94705516 HKG-NLU CI5218' });
    expect(provenance.mawb).toBe('forma');
    expect(provenance.origenIata).toBe('forma');
    expect(provenance.numeroVuelo).toBe('forma');
  });

  it('lets a caller tell a declared value from a deduced one', () => {
    // The cotejo's authority depends on this distinction staying visible: an inferred piece count must
    // not be presented to an auditor as something the client stated.
    const declared = parsePrealerta({ textBody: 'MAWB 160-94705516\nPieces: 1910' });
    const deduced = parsePrealerta({ textBody: 'MAWB 160-94705516\n63 1910 52.64 KG' });
    expect(declared.provenance.piezas).toBe('etiqueta');
    expect(deduced.provenance.piezas).toBe('inferido_propiedad');
  });
});

describe('regression — the guarantees that already held still hold', () => {
  it('remains fully order-independent', () => {
    const lines = [
      'Master AWB: 160-94705516',
      'Origin/Destination: HKG-NLU',
      'Flight: CI5218',
      'Cartons: 63',
      'Pieces: 1910',
      'Gross Weight: 52.64 KG',
      'Estimated Time of Departure: 2026-08-16',
      'Estimated Time of Arrival: 2026-08-18',
    ];
    const forward = parsePrealerta({ textBody: lines.join('\n') });
    const reversed = parsePrealerta({ textBody: [...lines].reverse().join('\n') });
    expect(reversed.fields).toEqual(forward.fields);
  });

  it('stays deterministic', () => {
    const body = 'MAWB 160-94705516\n63 1910 52.64 KG\n2026-08-16\n2026-08-18';
    expect(JSON.stringify(parsePrealerta({ textBody: body }))).toBe(
      JSON.stringify(parsePrealerta({ textBody: body })),
    );
  });
});
