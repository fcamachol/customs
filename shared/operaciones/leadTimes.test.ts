import { describe, expect, it } from 'vitest';
import {
  LEAD_TIME_RULESET_VERSION,
  calcularLeadTimes,
  minutosEntre,
  resumirLeadTimes,
  resumirMetrica,
  type LeadTimeEntrada,
} from './leadTimes';

const vacio: LeadTimeEntrada = {
  arriboVueloAt: null,
  disponibleAt: null,
  modulacionAt: null,
  salidaRojoAt: null,
  citaAt: null,
  ingresoPatioAt: null,
  ingresoAduanaAt: null,
  inicioCargaAt: null,
  finCargaAt: null,
  salidaAt: null,
  etaCalculado: null,
  arriboReal: null,
  podFirmadoAt: null,
};

/** A realistic day: lands 08:00, released 15:00 (the 7h the meeting measured), signed 22:10. */
const dia: LeadTimeEntrada = {
  ...vacio,
  arriboVueloAt: '2026-08-14T08:00:00Z',
  disponibleAt: '2026-08-14T15:00:00Z',
  citaAt: '2026-08-14T16:00:00Z',
  ingresoPatioAt: '2026-08-14T16:05:00Z',
  ingresoAduanaAt: '2026-08-14T16:35:00Z',
  inicioCargaAt: '2026-08-14T17:00:00Z',
  finCargaAt: '2026-08-14T18:00:00Z',
  modulacionAt: '2026-08-14T18:20:00Z',
  salidaRojoAt: '2026-08-14T20:20:00Z',
  salidaAt: '2026-08-14T20:30:00Z',
  etaCalculado: '2026-08-14T21:30:00Z',
  arriboReal: '2026-08-14T21:50:00Z',
  podFirmadoAt: '2026-08-14T22:10:00Z',
};

describe('calcularLeadTimes', () => {
  const lt = calcularLeadTimes(dia);

  it('computes the four legs the dashboard asks for', () => {
    expect(lt.almacenMin).toBe(420); // landing → warehouse release
    expect(lt.despachoMin).toBe(330); // release → left the aduana
    expect(lt.transitoMin).toBe(80);
    expect(lt.entregaMin).toBe(20);
  });

  it('computes LM and LT end to end', () => {
    expect(lt.ultimaMillaMin).toBe(100);
    expect(lt.leadTimeMin).toBe(850);
  });

  it('keeps the sub-metrics the field capture already earned', () => {
    expect(lt.demoraCitaMin).toBe(5); // R30 — cité 16:00, entró 16:05
    expect(lt.cargaMin).toBe(60);
    expect(lt.tiempoEnRojoMin).toBe(120); // R35
    expect(lt.desviacionArriboMin).toBe(20); // D14 — late by 20
  });

  it('stamps the ruleset so a stored report can be re-derived', () => {
    expect(lt.rulesetVersion).toBe(LEAD_TIME_RULESET_VERSION);
  });

  it('answers null — never zero — when an endpoint was never captured', () => {
    const parcial = calcularLeadTimes({ ...dia, podFirmadoAt: null });
    expect(parcial.leadTimeMin).toBeNull();
    expect(parcial.entregaMin).toBeNull();
    // The legs that ARE known stay known.
    expect(parcial.transitoMin).toBe(80);
  });

  it('reports the last mile even when the arrival button was never pressed', () => {
    const sinArribo = calcularLeadTimes({ ...dia, arriboReal: null });
    expect(sinArribo.transitoMin).toBeNull();
    expect(sinArribo.ultimaMillaMin).toBe(100);
  });

  it('returns a negative interval instead of clamping it — disagreeing clocks are a finding', () => {
    const invertido = calcularLeadTimes({ ...dia, arriboReal: '2026-08-14T20:00:00Z' });
    expect(invertido.transitoMin).toBe(-30);
  });

  it('is all nulls for a caso that has not started', () => {
    expect(calcularLeadTimes(vacio).leadTimeMin).toBeNull();
    expect(calcularLeadTimes(vacio).almacenMin).toBeNull();
  });
});

describe('minutosEntre', () => {
  it('accepts Date and string alike', () => {
    expect(minutosEntre(new Date('2026-08-14T08:00:00Z'), '2026-08-14T09:30:00Z')).toBe(90);
  });

  it('is null for an unparseable instant rather than NaN', () => {
    expect(minutosEntre('no es una fecha', '2026-08-14T09:30:00Z')).toBeNull();
  });
});

describe('resumirMetrica', () => {
  it('states the denominator beside the average', () => {
    expect(resumirMetrica([10, null, 20, null, 60])).toEqual({
      muestras: 3,
      promedioMin: 30,
      medianaMin: 20,
      minimoMin: 10,
      maximoMin: 60,
    });
  });

  it('excludes what it cannot answer from the denominator — never counts it as zero', () => {
    expect(resumirMetrica([null, null]).muestras).toBe(0);
    expect(resumirMetrica([null, null]).promedioMin).toBeNull();
  });

  it('averages the two middles for an even sample', () => {
    expect(resumirMetrica([10, 20, 30, 50]).medianaMin).toBe(25);
  });
});

describe('resumirLeadTimes', () => {
  it('summarises every metric over the same rows', () => {
    const r = resumirLeadTimes([calcularLeadTimes(dia), calcularLeadTimes({ ...dia, podFirmadoAt: null })]);
    expect(r.leadTimeMin.muestras).toBe(1);
    expect(r.transitoMin.muestras).toBe(2);
    expect(r.transitoMin.promedioMin).toBe(80);
  });
});
