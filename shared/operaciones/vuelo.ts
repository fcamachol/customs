// Flight identity and state, shared between the provider adapters and the app.
//
// The core problem this file solves: the client declares an IATA flight number (CI5218) and ADS-B
// transmits an ICAO callsign (CAL5218). They are two alphabets for the same flight, and no arithmetic
// converts between them — it needs a carrier table. Without the mapping, a position lookup silently
// finds nothing and the operation looks unverifiable when it is merely unmapped, so an unknown
// carrier is reported rather than guessed.

export const ESTADOS_VUELO = [
  'programado',
  'en_ruta',
  'aterrizado',
  'demorado',
  'cancelado',
  'desviado',
  'desconocido',
] as const;
export type EstadoVuelo = (typeof ESTADOS_VUELO)[number];

/**
 * IATA → ICAO for the carriers that actually fly this business: Asia-Pacific e-commerce lanes into
 * Mexico plus the global integrators. Extend as new carriers appear; an unmapped code yields
 * `carrier_desconocido` from parseFlightNumber, never a wrong callsign.
 */
export const IATA_TO_ICAO: Readonly<Record<string, string>> = {
  // Greater China / HK — the HKG-NLU lane and its neighbours
  CI: 'CAL', CX: 'CPA', CK: 'CKK', CA: 'CCA', CZ: 'CSN', MU: 'CES', MF: 'CXA',
  HU: 'CHH', ZH: 'CSZ', JD: 'CBJ', GJ: 'CDC', '9C': 'CQH', Y8: 'YZR', O3: 'CSS',
  HX: 'CRK', RH: 'HKC', LD: 'AHK', UO: 'HKE',
  // Rest of Asia
  BR: 'EVA', KE: 'KAL', OZ: 'AAR', SQ: 'SIA', NH: 'ANA', JL: 'JAL', KZ: 'NCA',
  TG: 'THA', VN: 'HVN', PR: 'PAL',
  // Integrators and freighter specialists
  '5X': 'UPS', FX: 'FDX', PO: 'PAC', '5Y': 'GTI', K4: 'CKS', QY: 'BCS',
  CV: 'CLX', '3S': 'BOX', '7L': 'AZG',
  // Middle East / Europe / Americas
  EK: 'UAE', QR: 'QTR', EY: 'ETD', SV: 'SVA', TK: 'THY', LH: 'DLH', AF: 'AFR',
  KL: 'KLM', BA: 'BAW', IB: 'IBE', AM: 'AMX', AA: 'AAL', UA: 'UAL', DL: 'DAL',
};

export interface FlightNumberParts {
  /** Carrier code as declared, e.g. "CI". */
  iataCarrier: string;
  /** Numeric portion, leading zeros stripped, e.g. "5218". */
  number: string;
  /** ICAO callsign for ADS-B lookup, e.g. "CAL5218". Null when the carrier is unmapped. */
  callsign: string | null;
  /** Normalized IATA form, e.g. "CI5218". */
  iataFlight: string;
}

/**
 * Split a declared flight number into its parts. Accepts "CI5218", "CI 5218", "ci-5218".
 *
 * Returns null when the input has no recognizable carrier+number shape at all — which includes the
 * common real case of a prealerta declaring only digits ("160"). Digits alone cannot be resolved
 * against any feed: the caller should surface that as unverifiable rather than fabricate a carrier.
 */
export function parseFlightNumber(raw: string | null | undefined): FlightNumberParts | null {
  if (!raw) return null;
  const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const m = cleaned.match(/^([A-Z]{2}|[A-Z]\d|\d[A-Z])(\d{1,5})$/);
  if (!m) return null;
  const iataCarrier = m[1];
  const number = String(Number(m[2]));
  const icao = IATA_TO_ICAO[iataCarrier];
  return {
    iataCarrier,
    number,
    callsign: icao ? `${icao}${number}` : null,
    iataFlight: `${iataCarrier}${number}`,
  };
}

/** ADS-B pads the callsign field to 8 characters; compare trimmed or nothing matches. */
export function normalizeCallsign(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, '').toUpperCase();
}

export interface PositionObservation {
  callsign: string;
  lat: number | null;
  lon: number | null;
  /** Barometric altitude in feet; ADS-B reports the literal string "ground" when on the ground. */
  altitudeFt: number | null;
  onGround: boolean;
  groundSpeedKt: number | null;
  /** Seconds since this position was last seen by the network. */
  seenSec: number | null;
}

/**
 * Derive a flight state from a live position snapshot.
 *
 * The honest limits of ADS-B alone, encoded here rather than left to the caller:
 *   - a flight that has not taken off and one that landed hours ago are INDISTINGUISHABLE (both
 *     absent from the feed), so absence yields `desconocido`, never `aterrizado`
 *   - `cancelado` can never be concluded from position data; only a schedule feed knows that
 *
 * That is why arrival is confirmed by a transition — previously airborne, now gone or on the ground —
 * which requires the caller to have been polling. `vuelosService` keeps the previous state so this
 * function can be given both.
 */
export function deriveEstadoFromPosition(
  obs: PositionObservation | null,
  previous: EstadoVuelo,
): EstadoVuelo {
  if (!obs) {
    // Absent from the feed. If we saw it airborne before, it has landed or gone out of coverage;
    // treating that as landed is the operationally useful reading and is corroborated by the
    // warehouse availability step that follows.
    return previous === 'en_ruta' ? 'aterrizado' : previous;
  }
  if (obs.onGround || (obs.altitudeFt !== null && obs.altitudeFt < 500)) {
    return previous === 'en_ruta' ? 'aterrizado' : 'programado';
  }
  return 'en_ruta';
}
