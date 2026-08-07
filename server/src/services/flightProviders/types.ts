import type { EstadoVuelo, PositionObservation } from '../../../../shared/operaciones/vuelo';

/**
 * Flight data provider contract.
 *
 * Two CAPABILITIES, kept explicit because they are not interchangeable and conflating them would
 * make the cotejo lie:
 *
 *   position  — live ADS-B. Free, no key, excellent for "did it take off / land / where is it".
 *               Cannot answer scheduled times, cancellations, or anything about a flight that is not
 *               transmitting right now.
 *   itinerary — commercial schedule feed. Knows published/estimated/actual times and cancellations,
 *               which is what PA-05 needs.
 *
 * `tieneItinerario` travels with every snapshot so `cotejarVuelo` can distinguish "the ETA checks
 * out" from "nobody could check the ETA". That distinction is the entire value of the exercise.
 */
export interface FlightQuery {
  /** Normalized IATA form, e.g. "CI5218". */
  iataFlight: string;
  /** ICAO callsign for ADS-B, e.g. "CAL5218". Null when the carrier is unmapped. */
  callsign: string | null;
  /** YYYY-MM-DD, the operating date of the flight leg. */
  fechaOperacion: string;
}

export interface FlightSnapshot {
  fuente: string;
  tieneItinerario: boolean;
  aerolinea: string | null;
  origenIata: string | null;
  destinoIata: string | null;
  etdProgramado: string | null;
  etaProgramado: string | null;
  etdReal: string | null;
  etaEstimado: string | null;
  arriboReal: string | null;
  estado: EstadoVuelo;
  posicion: PositionObservation | null;
  /** Verbatim provider response, persisted so a replanning decision can always be re-justified. */
  raw: unknown;
}

export interface FlightProvider {
  readonly name: string;
  readonly tieneItinerario: boolean;
  /**
   * Returns null when this provider simply cannot identify the flight — distinct from throwing,
   * which means the provider itself failed and the caller should retry later.
   */
  lookup(q: FlightQuery, previous: EstadoVuelo): Promise<FlightSnapshot | null>;
}

export const FLIGHT_HTTP_TIMEOUT_MS = Number(process.env.FLIGHT_HTTP_TIMEOUT_MS ?? 15_000);

export async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FLIGHT_HTTP_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}
