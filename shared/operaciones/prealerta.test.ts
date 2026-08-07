import { describe, expect, it } from 'vitest';
import { PREALERTA_PARSER_VERSION, parsePrealerta } from './prealerta';

/**
 * The email bodies below are synthesized from the field set described in the 1-Aug-2026 meeting
 * (guía máster, ruta IATA, vuelo, ETD, ETA, cartones, piezas, peso) in several plausible layouts,
 * because the annotated real sample is still open as Q1. They therefore prove the parser is
 * label- and order-independent where it claims to be; they do NOT prove the label vocabulary matches
 * the client's actual robot. When the real sample lands, add it as a golden fixture.
 */

const codes = (r: ReturnType<typeof parsePrealerta>) => r.warnings.map((w) => w.code);

describe('parsePrealerta — tier 1 (shape, label-independent)', () => {
  it('extracts the MAWB whether or not it is hyphenated', () => {
    expect(parsePrealerta({ textBody: 'MAWB 160-12345678' }).fields.mawb).toBe('16012345678');
    expect(parsePrealerta({ textBody: 'awb: 16012345678' }).fields.mawb).toBe('16012345678');
    expect(parsePrealerta({ textBody: 'Guia 160 12345678 ready' }).fields.mawb).toBe('16012345678');
  });

  it('keeps the raw MAWB for display and the normalized form for keying', () => {
    const r = parsePrealerta({ textBody: 'Master: 160-12345678' });
    expect(r.fields.mawbRaw).toBe('160-12345678');
    expect(r.fields.mawb).toBe('16012345678');
  });

  it('reads the route from any "to"-style separator', () => {
    for (const body of ['HKG-NLU', 'HKG / NLU', 'HKG > NLU', 'HKG to NLU', 'HKG → NLU']) {
      const r = parsePrealerta({ textBody: body });
      expect([r.fields.origenIata, r.fields.destinoIata]).toEqual(['HKG', 'NLU']);
    }
  });

  it('does not invent a route from lowercase prose', () => {
    const r = parsePrealerta({ textBody: 'please send the box to you' });
    expect(r.fields.origenIata).toBeUndefined();
    expect(codes(r)).toContain('ruta_no_encontrada');
  });

  it('flags rather than silently picks when a thread quotes several MAWBs', () => {
    const r = parsePrealerta({ textBody: 'MAWB 160-11111111\n> earlier: 160-22222222' });
    expect(r.fields.mawb).toBe('16011111111');
    expect(codes(r)).toContain('mawb_multiple');
  });

  it('warns when there is no MAWB at all', () => {
    expect(codes(parsePrealerta({ textBody: 'hello' }))).toContain('mawb_no_encontrado');
  });
});

describe('parsePrealerta — tier 2 (labels)', () => {
  const colonBody = [
    'Master AWB: 160-94705516',
    'Origin/Destination: HKG-NLU',
    'Flight: CI5218',
    'Estimated Time of Departure: 2026-08-16',
    'Estimated Time of Arrival: 2026-08-18',
    'Cartons: 63',
    'Pieces: 1910',
    'Gross Weight: 52.64 KG',
  ].join('\n');

  it('reads a colon-delimited English body end to end', () => {
    const { fields } = parsePrealerta({ textBody: colonBody });
    expect(fields.mawb).toBe('16094705516');
    expect(fields.origenIata).toBe('HKG');
    expect(fields.destinoIata).toBe('NLU');
    expect(fields.numeroVuelo).toBe('CI5218');
    expect(fields.cartones).toBe(63);
    expect(fields.piezas).toBe(1910);
    expect(fields.pesoKg).toBe(52.64);
    expect(fields.etdOrigen?.slice(0, 10)).toBe('2026-08-16');
    expect(fields.etaPais?.slice(0, 10)).toBe('2026-08-18');
  });

  it('reads the same data from a whitespace-aligned pseudo-table', () => {
    const spaced = [
      'Master AWB        160-94705516',
      'Cartones          63',
      'Piezas            1910',
      'Peso              52.64 kg',
    ].join('\n');
    const { fields } = parsePrealerta({ textBody: spaced });
    expect(fields.cartones).toBe(63);
    expect(fields.piezas).toBe(1910);
    expect(fields.pesoKg).toBe(52.64);
  });

  it('is order-independent — shuffling the lines changes nothing', () => {
    const lines = colonBody.split('\n');
    const shuffled = [...lines].reverse().join('\n');
    expect(parsePrealerta({ textBody: shuffled }).fields).toEqual(
      parsePrealerta({ textBody: colonBody }).fields,
    );
  });

  it('reads Spanish labels and labels wrapped in noise', () => {
    const body = [
      'Guia Master: 160-94705516',
      'Total Cartones (aprox)   63',
      'No. de piezas            1910',
      'Peso bruto               52.64 KG',
      'Fecha estimada de arribo: 2026-08-18',
    ].join('\n');
    const { fields } = parsePrealerta({ textBody: body });
    expect(fields.cartones).toBe(63);
    expect(fields.piezas).toBe(1910);
    expect(fields.pesoKg).toBe(52.64);
    expect(fields.etaPais?.slice(0, 10)).toBe('2026-08-18');
  });

  it('prefers the longest matching synonym so "gross weight" beats "weight"', () => {
    const r = parsePrealerta({ textBody: 'Gross Weight: 570\nWeight note: ignored' });
    expect(r.fields.pesoKg).toBe(570);
  });

  it('distinguishes ETD from ETA rather than taking whichever date came first', () => {
    const r = parsePrealerta({ textBody: 'Arrival: 2026-08-18\nDeparture: 2026-08-16' });
    expect(r.fields.etdOrigen?.slice(0, 10)).toBe('2026-08-16');
    expect(r.fields.etaPais?.slice(0, 10)).toBe('2026-08-18');
  });

  it('trusts a labelled digits-only flight field', () => {
    expect(parsePrealerta({ textBody: 'Flight: 160' }).fields.numeroVuelo).toBe('160');
  });

  it('does not mistake "AWB 160-94705516" for the flight AWB160', () => {
    // The shape of a carrier code and of the token "AWB" are identical, so the unlabelled fallback
    // has to strip the MAWB and know the air-cargo vocabulary. Getting this wrong would silently
    // feed a garbage flight number into the PA-04 route/flight cotejo.
    const r = parsePrealerta({ textBody: 'AWB 160-94705516\nHKG-NLU' });
    expect(r.fields.numeroVuelo).toBeUndefined();
    expect(codes(r)).toContain('vuelo_no_encontrado');
  });

  it('skips other air-cargo tokens that share the carrier-code shape', () => {
    for (const body of ['PCS 1910', 'KGS 570', 'ETA 2026', 'CTNS 63']) {
      expect(parsePrealerta({ textBody: body }).fields.numeroVuelo).toBeUndefined();
    }
  });

  it('still finds a genuine unlabelled flight next to a MAWB', () => {
    const r = parsePrealerta({ textBody: 'MAWB 160-94705516 CI5218 HKG-NLU' });
    expect(r.fields.numeroVuelo).toBe('CI5218');
  });

  it('reports an ambiguous date instead of guessing the month', () => {
    const r = parsePrealerta({ textBody: 'ETA: 03/04/2026' });
    expect(codes(r)).toContain('fecha_ambigua');
  });

  it('refuses a locale-ambiguous number rather than misreading it', () => {
    const r = parsePrealerta({ textBody: 'Pieces: 1,910' });
    expect(r.fields.piezas).toBeUndefined();
    expect(codes(r)).toContain('valor_no_numerico');
  });

  it('reports every field it could not fill', () => {
    const c = codes(parsePrealerta({ textBody: 'MAWB 160-12345678' }));
    expect(c).toContain('cartones_no_encontrado');
    expect(c).toContain('piezas_no_encontrado');
    expect(c).toContain('peso_no_encontrado');
    expect(c).toContain('etd_no_encontrado');
    expect(c).toContain('eta_no_encontrado');
  });

  it('falls back to the subject when the body carries nothing', () => {
    const r = parsePrealerta({ subject: 'Prealert 160-94705516 HKG-NLU', textBody: '' });
    expect(r.fields.mawb).toBe('16094705516');
    expect(r.fields.destinoIata).toBe('NLU');
  });

  it('stamps the parser version on every result, for reproducible findings', () => {
    expect(parsePrealerta({ textBody: 'x' }).parserVersion).toBe(PREALERTA_PARSER_VERSION);
  });

  it('is deterministic — the same input yields byte-identical output', () => {
    const a = parsePrealerta({ textBody: colonBody });
    const b = parsePrealerta({ textBody: colonBody });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
