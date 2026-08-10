import { describe, expect, it } from 'vitest';
import {
  ETA_RULESET_VERSION,
  bandaDeTrafico,
  desviacionArriboMin,
  distanciaHaversineKm,
  estimarArribo,
  fechaLocalMexico,
  horaLocalMexico,
} from './eta';

/**
 * R36 / D14 — the calculated arrival.
 *
 * The estimator's job is NOT to be accurate; it is to be honest and reproducible. So what these
 * tests defend is:
 *
 *   - it REFUSES rather than guesses when a coordinate is missing. A fabricated ETA is worse than
 *     none, because the warehouse at the other end staffs a dock against it (discipline 6).
 *   - it is deterministic and version-stamped, so the same inputs always produce the same number and
 *     an old row can still explain how it was made.
 *   - it says out loud what it is: `metodo`, `confianza: 'baja'` and `supuestos`. Nothing downstream
 *     can present a geometry-and-assumption estimate as an observed ETA.
 *   - `desviacionArriboMin` answers null, never 0, when one side is missing — "on time" is not the
 *     answer to "we never estimated it" (D14 is the whole point of keeping the two apart).
 */

// AIFA (NLU) and a delivery warehouse in Cuautitlán — the live lane in the PRD.
const AIFA = { lat: 19.7411, lng: -99.0183 };
const CUAUTITLAN = { lat: 19.6697, lng: -99.1817 };

describe('distanciaHaversineKm', () => {
  it('is zero for a point against itself', () => {
    expect(distanciaHaversineKm(AIFA, AIFA)).toBe(0);
  });

  it('is symmetric', () => {
    expect(distanciaHaversineKm(AIFA, CUAUTITLAN)).toBeCloseTo(distanciaHaversineKm(CUAUTITLAN, AIFA), 9);
  });

  it('gives a plausible short-haul distance for the real lane', () => {
    const km = distanciaHaversineKm(AIFA, CUAUTITLAN);
    expect(km).toBeGreaterThan(15);
    expect(km).toBeLessThan(25);
  });
});

describe('bandas de tráfico — local time, not UTC', () => {
  it('reads the hour in Mexico City regardless of the server zone', () => {
    // 2026-08-14T18:00:00Z is noon in Mexico City (UTC-6, no DST since 2022).
    expect(horaLocalMexico(new Date('2026-08-14T18:00:00Z'))).toBe(12);
  });

  it('classifies the two commutes, the night and the valley', () => {
    expect(bandaDeTrafico(new Date('2026-08-14T14:00:00Z'))).toBe('pico_matutino'); // 08:00 local
    expect(bandaDeTrafico(new Date('2026-08-15T01:00:00Z'))).toBe('pico_vespertino'); // 19:00 local
    expect(bandaDeTrafico(new Date('2026-08-15T08:00:00Z'))).toBe('nocturno'); // 02:00 local
    expect(bandaDeTrafico(new Date('2026-08-14T18:00:00Z'))).toBe('valle'); // 12:00 local
  });
});

/**
 * The CDMX CALENDAR DAY — the operating day every daily plan is keyed by.
 *
 * `toISOString().slice(0,10)` answers with the UTC day, and CDMX is six hours behind it, so from
 * 18:00 local onwards the two disagree. Two real defects lived in that gap: the contingency engine
 * reprogrammed evening arrivals to the following day (`shared/operaciones/replan.ts`), and the
 * planning screen's default `fecha` rolled over at six in the evening (`routes/planeacion.ts`).
 * Pure by construction: the instant is an argument, never a clock read.
 */
describe('fechaLocalMexico — the operating day', () => {
  it('keeps an evening instant on its LOCAL day even when UTC has already turned over', () => {
    // 19:30 on the 10th in CDMX is 01:30Z on the 11th.
    const tarde = new Date('2026-08-11T01:30:00Z');
    expect(fechaLocalMexico(tarde)).toBe('2026-08-10');
    expect(tarde.toISOString().slice(0, 10)).toBe('2026-08-11'); // what it used to answer
  });

  it('turns the day over at local midnight, not at 18:00 local', () => {
    expect(fechaLocalMexico(new Date('2026-08-11T05:59:59Z'))).toBe('2026-08-10'); // 23:59:59 local
    expect(fechaLocalMexico(new Date('2026-08-11T06:00:00Z'))).toBe('2026-08-11'); // 00:00:00 local
  });

  it('pads to a sortable YYYY-MM-DD and survives a year boundary', () => {
    expect(fechaLocalMexico(new Date('2027-01-01T04:00:00Z'))).toBe('2026-12-31'); // 22:00 local
    expect(fechaLocalMexico(new Date('2026-03-05T18:00:00Z'))).toBe('2026-03-05');
  });

  it('returns null for an invalid instant instead of inventing a day', () => {
    expect(fechaLocalMexico(new Date('no es una fecha'))).toBeNull();
  });

  it('midnight local reads as hour 0, never as 24', () => {
    expect(horaLocalMexico(new Date('2026-08-11T06:00:00Z'))).toBe(0);
  });
});

describe('estimarArribo', () => {
  const salida = new Date('2026-08-14T18:00:00Z'); // 12:00 local, valle

  it('produces a stamped, self-describing estimate', () => {
    const e = estimarArribo({ salida, origen: AIFA, destino: CUAUTITLAN })!;
    expect(e).not.toBeNull();
    expect(e.rulesetVersion).toBe(ETA_RULESET_VERSION);
    expect(e.metodo).toBe('estimacion_deterministica');
    // It never claims more than it knows.
    expect(e.confianza).toBe('baja');
    expect(e.supuestos.join(' ')).toContain('no se consultó un proveedor de ruteo');
    expect(e.supuestos.join(' ')).toContain('no un arribo observado');
  });

  it('is deterministic: same inputs, same answer', () => {
    const a = estimarArribo({ salida, origen: AIFA, destino: CUAUTITLAN })!;
    const b = estimarArribo({ salida, origen: AIFA, destino: CUAUTITLAN })!;
    expect(a).toEqual(b);
  });

  it('adds the driving time plus the fixed departure overhead to the departure instant', () => {
    const e = estimarArribo({ salida, origen: AIFA, destino: CUAUTITLAN })!;
    expect(e.minutosEstimados).toBe(e.minutosManejo + e.minutosFijos);
    expect(new Date(e.etaCalculado).getTime() - salida.getTime()).toBe(e.minutosEstimados * 60_000);
  });

  it('routes the truck further than the straight line', () => {
    const e = estimarArribo({ salida, origen: AIFA, destino: CUAUTITLAN })!;
    expect(e.distanciaRutaKm).toBeGreaterThan(e.distanciaLineaKm);
  });

  it('takes longer in rush hour than at midday over the same distance', () => {
    const valle = estimarArribo({ salida, origen: AIFA, destino: CUAUTITLAN })!;
    const pico = estimarArribo({
      salida: new Date('2026-08-15T01:00:00Z'), // 19:00 local
      origen: AIFA,
      destino: CUAUTITLAN,
    })!;
    expect(pico.minutosEstimados).toBeGreaterThan(valle.minutosEstimados);
    expect(pico.banda).toBe('pico_vespertino');
  });

  it('returns null — never a fallback number — when a coordinate is missing', () => {
    expect(estimarArribo({ salida, origen: null, destino: CUAUTITLAN })).toBeNull();
    expect(estimarArribo({ salida, origen: AIFA, destino: undefined })).toBeNull();
  });

  it('treats (0,0) as missing rather than as a point in the Gulf of Guinea', () => {
    expect(estimarArribo({ salida, origen: { lat: 0, lng: 0 }, destino: CUAUTITLAN })).toBeNull();
  });

  it('rejects out-of-range coordinates and an unparseable departure', () => {
    expect(estimarArribo({ salida, origen: { lat: 120, lng: -99 }, destino: CUAUTITLAN })).toBeNull();
    expect(estimarArribo({ salida: new Date('nope'), origen: AIFA, destino: CUAUTITLAN })).toBeNull();
  });
});

describe('desviacionArriboMin — the D14 comparison', () => {
  it('is positive when the unit arrived late', () => {
    expect(
      desviacionArriboMin('2026-08-14T20:00:00Z', '2026-08-14T20:35:00Z'),
    ).toBe(35);
  });

  it('is negative when it arrived early', () => {
    expect(
      desviacionArriboMin('2026-08-14T20:00:00Z', '2026-08-14T19:40:00Z'),
    ).toBe(-20);
  });

  it('is null, NOT zero, when there was no estimate — "on time" is not the answer to "we never estimated it"', () => {
    expect(desviacionArriboMin(null, '2026-08-14T20:00:00Z')).toBeNull();
    expect(desviacionArriboMin('2026-08-14T20:00:00Z', null)).toBeNull();
    expect(desviacionArriboMin(undefined, undefined)).toBeNull();
  });

  it('is null for an unparseable instant rather than NaN leaking into a KPI', () => {
    expect(desviacionArriboMin('no-es-fecha', '2026-08-14T20:00:00Z')).toBeNull();
  });

  it('accepts Date objects as well as ISO strings, since one side comes from the database', () => {
    expect(
      desviacionArriboMin(new Date('2026-08-14T20:00:00Z'), new Date('2026-08-14T20:10:00Z')),
    ).toBe(10);
  });
});
