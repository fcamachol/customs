import type { EstadoVuelo } from '../../../../shared/operaciones/vuelo';
import { fetchWithTimeout, type FlightProvider, type FlightQuery, type FlightSnapshot } from './types';

/**
 * FlightAware AeroAPI v3 — the itinerary provider, and the recommended primary source for this
 * business.
 *
 * Why this one over the alternatives, for CARGO specifically: AeroAPI and Cirium are the two feeds
 * with real freighter coverage plus scheduled/estimated/actual times, and AeroAPI is pay-per-query
 * rather than an enterprise contract, so it fits a business that is still ramping volume. Cirium is
 * the deeper dataset but is priced and negotiated as an enterprise deal. AviationStack is cheaper and
 * simpler but its freight coverage is the weakest of the three, which is the wrong trade when the
 * whole point is verifying cargo flights on Asia-Pacific lanes.
 *
 * Requires FLIGHT_API_KEY. When it is absent the resolver silently uses ADS-B instead, so the system
 * works today with zero configuration and upgrades to full itinerary verification the moment a key is
 * added — no code change, and PA-05 goes from "informativa" to a real comparison.
 */
const BASE = process.env.AEROAPI_BASE_URL ?? 'https://aeroapi.flightaware.com/aeroapi';

interface AeroFlight {
  ident?: string;
  ident_iata?: string;
  operator?: string;
  operator_iata?: string;
  cancelled?: boolean;
  diverted?: boolean;
  origin?: { code_iata?: string | null };
  destination?: { code_iata?: string | null };
  scheduled_off?: string | null;
  estimated_off?: string | null;
  actual_off?: string | null;
  scheduled_in?: string | null;
  estimated_in?: string | null;
  actual_in?: string | null;
  actual_on?: string | null;
}

function mapEstado(f: AeroFlight, previous: EstadoVuelo): EstadoVuelo {
  if (f.cancelled) return 'cancelado';
  if (f.diverted) return 'desviado';
  // actual_on is wheels-down, which is the fact that matters for the 2-hour unload clock.
  if (f.actual_on || f.actual_in) return 'aterrizado';
  if (f.actual_off) return 'en_ruta';
  // Departed later than published, and not yet airborne per the feed.
  if (f.scheduled_off && f.estimated_off) {
    const sched = Date.parse(f.scheduled_off);
    const est = Date.parse(f.estimated_off);
    if (Number.isFinite(sched) && Number.isFinite(est) && est - sched > 30 * 60 * 1000) {
      return 'demorado';
    }
  }
  if (f.scheduled_off) return 'programado';
  return previous;
}

export const aeroApiProvider: FlightProvider = {
  name: 'flightaware.aeroapi',
  tieneItinerario: true,

  async lookup(q: FlightQuery, previous: EstadoVuelo): Promise<FlightSnapshot | null> {
    const key = process.env.FLIGHT_API_KEY;
    if (!key) return null;

    // AeroAPI accepts the IATA ident directly, which is convenient because it is exactly what the
    // client declares — no ICAO mapping needed on this path.
    const url = `${BASE}/flights/${encodeURIComponent(q.iataFlight)}`;
    const res = await fetchWithTimeout(url, {
      headers: { 'x-apikey': key, Accept: 'application/json' },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`AeroAPI respondió ${res.status}`);
    const body = (await res.json()) as { flights?: AeroFlight[] };

    const flights = body.flights ?? [];
    if (!flights.length) return null;

    // A flight number recurs daily, so pick the leg whose departure falls on the operating date.
    const target =
      flights.find((f) => (f.scheduled_off ?? f.estimated_off ?? '').startsWith(q.fechaOperacion)) ??
      flights[0];

    return {
      fuente: this.name,
      tieneItinerario: true,
      aerolinea: target.operator_iata ?? target.operator ?? null,
      origenIata: target.origin?.code_iata ?? null,
      destinoIata: target.destination?.code_iata ?? null,
      etdProgramado: target.scheduled_off ?? null,
      etaProgramado: target.scheduled_in ?? null,
      etdReal: target.actual_off ?? null,
      etaEstimado: target.estimated_in ?? null,
      arriboReal: target.actual_on ?? target.actual_in ?? null,
      estado: mapEstado(target, previous),
      posicion: null,
      raw: body,
    };
  },
};
