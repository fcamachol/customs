import { describe, expect, it } from 'vitest';
import { normalizeInbound, parsePrealerta, parsePrealertaDate } from './prealerta';

/**
 * GOLDEN TESTS — verbatim subject lines from live client prealertas.
 *
 * These are the real thing, captured by the running system from lgutierrez@capitalc.com.mx, not
 * anything I invented. They are pinned here because every one of them broke the parser I had written
 * against assumptions, and the failure modes were invisible: the fields came back empty with warnings
 * rather than wrong, so nothing looked broken until someone read the flight column.
 *
 * What the real format taught us:
 *   - the whole record lives in the SUBJECT, `//`-delimited — the body carries the flight number
 *   - the colon after ETD/ETA is FULL-WIDTH `：` (U+FF1A), a CJK-keyboard artifact, not a colon
 *   - counts come as value-then-unit: `64 CTNS/ 2914 PCS/ 542.86 KGS`
 *   - dates are Spanish, abbreviated, and carry NO YEAR: `07 Ago 06:00`, sometimes `07Ago 09:45`
 *   - there is NO origin/destination anywhere, so PA-04 is simply not evaluable from this format
 */

const REAL_1 =
  'iMile// 160-05930216 //ETD：07 Ago 06:00//ETA：07Ago 09:45 ETA//64 CTNS/ 2914 PCS/ 542.86 KGS';
const REAL_2 =
  'iMile// 160-05930257//ETD：07 Ago 06:00//ETA：07 Ago 09:45 ETA//60 CTNS/ 2500 PCS/ 646.86 KGS';

const NOW = new Date('2026-08-07T12:00:00.000Z');

describe('normalizeInbound', () => {
  it('converts the full-width colon that defeats ASCII matching', () => {
    expect(normalizeInbound('ETD：07 Ago')).toContain('ETD:');
  });

  it('turns // into line breaks so each field can be read separately', () => {
    expect(normalizeInbound('a//b//c').split('\n')).toEqual(['a', 'b', 'c']);
  });

  it('leaves a single slash alone, because it is also a route separator', () => {
    // Splitting on `/` would break "HKG / NLU" to fix something unitSuffixPairs handles by regex.
    expect(normalizeInbound('HKG / NLU')).toContain('/');
  });

  it('strips ideographic spaces and zero-width joiners', () => {
    expect(normalizeInbound('a　b‍')).toBe('a b');
  });
});

describe('parsePrealertaDate', () => {
  it('reads a Spanish abbreviated month with no year', () => {
    const d = parsePrealertaDate('07 Ago 06:00', NOW);
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.iso).toBe('2026-08-07T06:00:00.000Z');
    expect(d.yearInferred).toBe(true);
  });

  it('reads the no-space variant the client also sends', () => {
    const d = parsePrealertaDate('07Ago 09:45', NOW);
    expect(d.ok && d.iso).toBe('2026-08-07T09:45:00.000Z');
  });

  it('rolls the year forward when the bare date would otherwise be months in the past', () => {
    // A prealerta describes a flight about to happen, never one from ten months ago.
    const d = parsePrealertaDate('15 Ene 08:00', NOW);
    expect(d.ok && d.iso.slice(0, 4)).toBe('2027');
  });

  it('accepts English months too', () => {
    expect(parsePrealertaDate('07 Aug 06:00', NOW).ok).toBe(true);
  });

  it('still handles ISO dates through the existing parser', () => {
    const d = parsePrealertaDate('2026-08-18', NOW);
    expect(d.ok && d.iso.slice(0, 10)).toBe('2026-08-18');
  });

  it('reports failure rather than inventing a date', () => {
    expect(parsePrealertaDate('sin fecha', NOW).ok).toBe(false);
  });
});

describe('golden — real client subject lines', () => {
  for (const [name, subject, expected] of [
    ['REAL_1', REAL_1, { mawb: '16005930216', cartones: 64, piezas: 2914, pesoKg: 542.86 }],
    ['REAL_2', REAL_2, { mawb: '16005930257', cartones: 60, piezas: 2500, pesoKg: 646.86 }],
  ] as const) {
    it(`${name}: extracts guía, counts and both dates`, () => {
      const { fields, provenance, warnings } = parsePrealerta({ subject });

      expect(fields.mawb).toBe(expected.mawb);
      expect(fields.cartones).toBe(expected.cartones);
      expect(fields.piezas).toBe(expected.piezas);
      expect(fields.pesoKg).toBe(expected.pesoKg);

      // Counts are DECLARED, not inferred: the unit word states what each number is, so the cotejo can
      // hold the client to them.
      expect(provenance.cartones).toBe('etiqueta');
      expect(provenance.piezas).toBe('etiqueta');
      expect(provenance.pesoKg).toBe('etiqueta');

      expect(fields.etdOrigen).toBeTruthy();
      expect(fields.etaPais).toBeTruthy();
      expect(new Date(fields.etdOrigen!).getTime()).toBeLessThan(
        new Date(fields.etaPais!).getTime(),
      );

      // None of the count or date fields may be reported missing any more.
      const codes = warnings.map((w) => w.code);
      for (const c of [
        'cartones_no_encontrado',
        'piezas_no_encontrado',
        'peso_no_encontrado',
        'etd_no_encontrado',
        'eta_no_encontrado',
      ]) {
        expect(codes).not.toContain(c);
      }
    });
  }

  it('still reports the absent route honestly instead of inventing one', () => {
    // There is no origin/destination in this format at all. PA-04 is therefore not evaluable, and that
    // must read as a gap rather than as a passed check.
    const { fields, warnings } = parsePrealerta({ subject: REAL_1 });
    expect(fields.origenIata).toBeUndefined();
    expect(fields.destinoIata).toBeUndefined();
    expect(warnings.map((w) => w.code)).toContain('ruta_no_encontrada');
  });

  it('picks up the flight number from the body, where the client actually puts it', () => {
    const { fields } = parsePrealerta({ subject: REAL_1, textBody: 'Vuelo VB9521 confirmado' });
    expect(fields.numeroVuelo).toBe('VB9521');
  });

  it('is deterministic on the real input', () => {
    expect(JSON.stringify(parsePrealerta({ subject: REAL_1 }))).toBe(
      JSON.stringify(parsePrealerta({ subject: REAL_1 })),
    );
  });
});
