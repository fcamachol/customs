import { describe, expect, it } from 'vitest';
import {
  IATA_TO_ICAO,
  deriveEstadoFromPosition,
  normalizeCallsign,
  parseFlightNumber,
} from './vuelo';

describe('parseFlightNumber', () => {
  it('maps an IATA flight number to its ICAO callsign', () => {
    const p = parseFlightNumber('CI5218');
    expect(p).toEqual({ iataCarrier: 'CI', number: '5218', callsign: 'CAL5218', iataFlight: 'CI5218' });
  });

  it('tolerates spacing, punctuation and casing', () => {
    for (const raw of ['ci 5218', 'CI-5218', ' Ci5218 ']) {
      expect(parseFlightNumber(raw)?.callsign).toBe('CAL5218');
    }
  });

  it('handles alphanumeric carrier codes like 5X and 9C', () => {
    expect(parseFlightNumber('5X118')?.callsign).toBe('UPS118');
    expect(parseFlightNumber('9C8912')?.callsign).toBe('CQH8912');
  });

  it('strips leading zeros from the numeric part', () => {
    // The feed transmits CAL18, not CAL018; keeping the zeros would silently never match.
    expect(parseFlightNumber('CI018')?.callsign).toBe('CAL18');
  });

  it('returns a null callsign, not a guess, for an unmapped carrier', () => {
    const p = parseFlightNumber('ZZ1234');
    expect(p?.iataFlight).toBe('ZZ1234');
    expect(p?.callsign).toBeNull();
  });

  it('returns null for digits alone — the real "Flight: 160" case', () => {
    // No feed can resolve a bare number, and inventing a carrier would be worse than admitting it.
    expect(parseFlightNumber('160')).toBeNull();
  });

  it('returns null for empty or nonsense input', () => {
    for (const raw of [null, undefined, '', '   ', 'NOTAFLIGHT']) {
      expect(parseFlightNumber(raw as string)).toBeNull();
    }
  });

  it('covers the cargo carriers this business actually flies', () => {
    for (const iata of ['CI', 'CX', 'CK', 'O3', 'Y8', '5X', 'FX', 'CV', 'AM']) {
      expect(IATA_TO_ICAO[iata]).toBeTruthy();
    }
  });
});

describe('normalizeCallsign', () => {
  it('trims the ADS-B space padding that would otherwise break every comparison', () => {
    expect(normalizeCallsign('CAL5218 ')).toBe('CAL5218');
    expect(normalizeCallsign('XCHDF   ')).toBe('XCHDF');
    expect(normalizeCallsign(null)).toBe('');
  });
});

describe('deriveEstadoFromPosition', () => {
  const airborne = {
    callsign: 'CAL5218', lat: 20, lon: -99, altitudeFt: 35000,
    onGround: false, groundSpeedKt: 480, seenSec: 3,
  };

  it('reports en_ruta while airborne', () => {
    expect(deriveEstadoFromPosition(airborne, 'programado')).toBe('en_ruta');
  });

  it('treats disappearing after being airborne as landed', () => {
    expect(deriveEstadoFromPosition(null, 'en_ruta')).toBe('aterrizado');
  });

  it('does NOT claim landed for a flight that was never seen airborne', () => {
    // Pre-departure and long-since-landed are indistinguishable in ADS-B; guessing either way would
    // fabricate an arrival and start the tramitador's clock for nothing.
    expect(deriveEstadoFromPosition(null, 'programado')).toBe('programado');
    expect(deriveEstadoFromPosition(null, 'desconocido')).toBe('desconocido');
  });

  it('reads the literal "ground" altitude as on-ground', () => {
    const onGround = { ...airborne, onGround: true, altitudeFt: null };
    expect(deriveEstadoFromPosition(onGround, 'en_ruta')).toBe('aterrizado');
    expect(deriveEstadoFromPosition(onGround, 'programado')).toBe('programado');
  });

  it('treats a very low altitude as on the ground', () => {
    expect(deriveEstadoFromPosition({ ...airborne, altitudeFt: 200 }, 'en_ruta')).toBe('aterrizado');
  });
});
