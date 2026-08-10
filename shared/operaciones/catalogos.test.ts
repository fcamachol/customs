import { describe, expect, it } from 'vitest';
import {
  ADUANAS_ORIGEN,
  ESTADOS_DESPACHO,
  ORDEN_ESTADO_DESPACHO,
  TIPOS_UNIDAD,
  TIPOS_UNIDAD_IDS,
  aduanaOrigen,
  canAdvanceEstadoDespacho,
  esEstadoDespachoAbierto,
  etiquetaTipoUnidad,
} from './catalogos';

/**
 * The despacho FSM (R21) is what replaced the Excel status formula, so these tests are about the
 * decisions it encodes rather than about graph mechanics:
 *
 *   - it only moves forward, because a trip that could rewind would let a truck "un-load";
 *   - `cancelado` is reachable from anywhere and terminal, because a cancelled trip that could be
 *     resurrected would revive a charge nobody re-approved;
 *   - `en_espera` is only reachable BEFORE loading starts. Once cargo is going onto the unit the
 *     flete is owed whether the load finishes or not, so a pause there would be a fiction hiding
 *     a cost — the contingency is a cancellation (somebody pays) or it runs to `cargado`;
 *   - resuming from `en_espera` is checked against the PAUSE POINT, not against `en_espera` itself,
 *     which is what keeps a paused trip from silently rewinding.
 */
describe('TIPOS_UNIDAD — R23 / D8', () => {
  it('carries the whole glossary Alfonso asked for, not just the tracto', () => {
    expect(TIPOS_UNIDAD_IDS).toEqual([
      'tracto',
      'torton',
      'rabon',
      't3_5',
      'silverado',
      'cargo_van',
    ]);
  });

  it('labels are what an operator says out loud', () => {
    expect(etiquetaTipoUnidad('t3_5')).toBe('3.5 toneladas');
    expect(etiquetaTipoUnidad('torton')).toBe('Tortón');
  });

  it('an unknown id degrades to itself instead of throwing on a screen', () => {
    expect(etiquetaTipoUnidad('trailer')).toBe('trailer');
  });

  it('ids are unique', () => {
    expect(new Set(TIPOS_UNIDAD.map((t) => t.id)).size).toBe(TIPOS_UNIDAD.length);
  });
});

describe('canAdvanceEstadoDespacho — the R21 state machine', () => {
  it('walks the whole happy path one step at a time', () => {
    for (let i = 0; i < ORDEN_ESTADO_DESPACHO.length - 1; i++) {
      expect(canAdvanceEstadoDespacho(ORDEN_ESTADO_DESPACHO[i], ORDEN_ESTADO_DESPACHO[i + 1])).toBe(true);
    }
  });

  it('allows skipping ahead — facts arrive out of order and the later one wins', () => {
    expect(canAdvanceEstadoDespacho('planeado', 'en_aduana')).toBe(true);
    expect(canAdvanceEstadoDespacho('confirmado', 'cargado')).toBe(true);
  });

  it('never goes backwards', () => {
    expect(canAdvanceEstadoDespacho('cargado', 'cargando')).toBe(false);
    expect(canAdvanceEstadoDespacho('en_transito', 'planeado')).toBe(false);
  });

  it('treats a repeat as a non-transition, so the caller skips it instead of writing a second event', () => {
    expect(canAdvanceEstadoDespacho('cargando', 'cargando')).toBe(false);
  });

  it('reaches cancelado from anywhere, and nothing leaves it', () => {
    for (const e of ORDEN_ESTADO_DESPACHO) {
      if (e === 'entregado') continue;
      expect(canAdvanceEstadoDespacho(e, 'cancelado')).toBe(true);
    }
    expect(canAdvanceEstadoDespacho('en_espera', 'cancelado')).toBe(true);
    expect(canAdvanceEstadoDespacho('cancelado', 'planeado')).toBe(false);
    expect(canAdvanceEstadoDespacho('cancelado', 'cancelado')).toBe(false);
  });

  it('entregado is terminal — a delivered trip has nothing left to do', () => {
    expect(canAdvanceEstadoDespacho('entregado', 'cancelado')).toBe(false);
    expect(canAdvanceEstadoDespacho('entregado', 'en_transito')).toBe(false);
  });

  it('allows en_espera only before loading starts', () => {
    expect(canAdvanceEstadoDespacho('planeado', 'en_espera')).toBe(true);
    expect(canAdvanceEstadoDespacho('en_aduana', 'en_espera')).toBe(true);
    // The unit is on the clock from here on: a pause would hide a cost that is already owed.
    expect(canAdvanceEstadoDespacho('cargando', 'en_espera')).toBe(false);
    expect(canAdvanceEstadoDespacho('cargado', 'en_espera')).toBe(false);
    expect(canAdvanceEstadoDespacho('en_espera', 'en_espera')).toBe(false);
  });

  it('resumes against the pause point, and cannot rewind through the pause', () => {
    // Paused at en_aduana: carrying on, or un-pausing back to exactly where it stopped, are both fine.
    expect(canAdvanceEstadoDespacho('en_aduana', 'cargando', { reanudandoDesdeEspera: true })).toBe(true);
    expect(canAdvanceEstadoDespacho('en_aduana', 'en_aduana', { reanudandoDesdeEspera: true })).toBe(true);
    // Rewinding to before the pause is exactly what the flag exists to prevent.
    expect(canAdvanceEstadoDespacho('en_aduana', 'solicitado', { reanudandoDesdeEspera: true })).toBe(false);
  });

  it('refuses to guess when the caller passes en_espera as the origin (documented precondition)', () => {
    expect(canAdvanceEstadoDespacho('en_espera', 'cargando')).toBe(false);
  });

  it('the two off-line states are exactly cancelado and en_espera', () => {
    const fueraDeLinea = ESTADOS_DESPACHO.filter(
      (e) => !ORDEN_ESTADO_DESPACHO.includes(e as (typeof ORDEN_ESTADO_DESPACHO)[number]),
    );
    expect(fueraDeLinea).toEqual(['cancelado', 'en_espera']);
  });

  it('esEstadoDespachoAbierto counts everything that is still in play', () => {
    expect(esEstadoDespachoAbierto('en_espera')).toBe(true);
    expect(esEstadoDespachoAbierto('planeado')).toBe(true);
    expect(esEstadoDespachoAbierto('entregado')).toBe(false);
    expect(esEstadoDespachoAbierto('cancelado')).toBe(false);
  });
});

describe('ADUANAS_ORIGEN — the fixed points the R36 estimate starts from', () => {
  it('resolves case-insensitively and tolerates whitespace', () => {
    expect(aduanaOrigen('nlu')?.iata).toBe('NLU');
    expect(aduanaOrigen(' MEX ')?.iata).toBe('MEX');
  });

  it('returns null for anything it does not know — no fallback point, so no fabricated distance', () => {
    expect(aduanaOrigen('HKG')).toBeNull();
    expect(aduanaOrigen(null)).toBeNull();
    expect(aduanaOrigen(undefined)).toBeNull();
    expect(aduanaOrigen('')).toBeNull();
  });

  it('every entry carries usable coordinates', () => {
    // Widened off the `as const` literal types: the estimator receives plain numbers, and the
    // null-island check below is meaningless against a literal union tsc already knows is non-zero.
    const puntos: Array<{ lat: number; lng: number }> = ADUANAS_ORIGEN.map((a) => ({
      lat: a.lat,
      lng: a.lng,
    }));
    for (const p of puntos) {
      expect(Math.abs(p.lat)).toBeLessThanOrEqual(90);
      expect(Math.abs(p.lng)).toBeLessThanOrEqual(180);
      // (0,0) is what the estimator treats as "no coordinates" — no catalog entry may look absent.
      expect(p.lat === 0 && p.lng === 0).toBe(false);
    }
  });
});
