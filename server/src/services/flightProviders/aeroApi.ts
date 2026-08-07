import type { EstadoVuelo, PositionObservation } from '../../../../shared/operaciones/vuelo';
import { fetchWithTimeout, type FlightProvider, type FlightQuery, type FlightSnapshot } from './types';

/**
 * FlightAware AeroAPI v4 — the primary flight source.
 *
 * WHY THIS ONE, decided against the alternatives on one technical fact: FlightAware feeds Aireon's
 * space-based ADS-B (66 Iridium NEXT satellites), which removes the oceanic coverage gap. Community
 * ADS-B was measured returning ZERO aircraft over the mid-Pacific while returning 23 near AIFA — and
 * the HKG→NLU freighters this business runs spend most of their flight in exactly that blind spot.
 * Cirium is the deeper dataset but quotes coverage for scheduled PASSENGER flights and is an
 * enterprise contract; these are freighters and the key was needed immediately.
 *
 * It answers everything a position feed structurally cannot: filed schedule, estimated and ACTUAL off
 * and on times, cancellations, diversions, aircraft and registration, gate/terminal, and progress —
 * plus historical replay, which is what lets a finding be re-justified to an auditor months later.
 *
 * Two calls per refresh, deliberately:
 *   1. /flights/{ident} bounded to the operating date — identifies the right daily leg and returns the
 *      schedule. Bounding matters: a flight number recurs every day, and picking the wrong instance
 *      would silently compare the cargo against yesterday's itinerary.
 *   2. /flights/{fa_flight_id}/position — live position, only while the leg is actually airborne, so
 *      we do not pay for a position query on a flight that has landed.
 */
const BASE = process.env.AEROAPI_BASE_URL ?? 'https://aeroapi.flightaware.com/aeroapi';

interface AeroFlight {
  fa_flight_id?: string;
  ident?: string;
  ident_iata?: string;
  operator?: string;
  operator_iata?: string;
  registration?: string | null;
  aircraft_type?: string | null;
  cancelled?: boolean;
  diverted?: boolean;
  progress_percent?: number | null;
  route?: string | null;
  route_distance?: number | null;
  filed_ete?: number | null;
  status?: string | null;
  origin?: { code_iata?: string | null; gate?: string | null; terminal?: string | null } | null;
  destination?: { code_iata?: string | null; gate?: string | null; terminal?: string | null } | null;
  actual_runway_off?: string | null;
  actual_runway_on?: string | null;
  scheduled_off?: string | null;
  estimated_off?: string | null;
  actual_off?: string | null;
  scheduled_in?: string | null;
  estimated_in?: string | null;
  actual_in?: string | null;
  actual_on?: string | null;
}

interface AeroPosition {
  last_position?: {
    latitude?: number | null;
    longitude?: number | null;
    altitude?: number | null; // hundreds of feet in AeroAPI
    groundspeed?: number | null;
    timestamp?: string | null;
  } | null;
}

/** Extra detail the richer `vuelos` columns hold. */
export interface AeroDetail {
  faFlightId: string | null;
  aeronaveTipo: string | null;
  matricula: string | null;
  progresoPct: number | null;
  rutaFiled: string | null;
  distanciaKm: number | null;
  terminalDestino: string | null;
  puertaDestino: string | null;
  pistaSalida: string | null;
  pistaLlegada: string | null;
  cancelado: boolean;
  desviado: boolean;
  destinoRealIata: string | null;
}

export interface AeroSnapshot extends FlightSnapshot {
  detalle: AeroDetail;
}

function mapEstado(f: AeroFlight, previous: EstadoVuelo): EstadoVuelo {
  if (f.cancelled) return 'cancelado';
  if (f.diverted) return 'desviado';
  // actual_on is wheels-down. That is the fact that starts the ~2-hour unload clock and the
  // tramitador's window, so it takes precedence over the gate-in time.
  if (f.actual_on || f.actual_in) return 'aterrizado';
  if (f.actual_off) return 'en_ruta';
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

/** AeroAPI reports altitude in hundreds of feet. Storing it raw would understate it 100-fold. */
function altitudeFt(a: number | null | undefined): number | null {
  return typeof a === 'number' ? a * 100 : null;
}

export const aeroApiProvider: FlightProvider = {
  name: 'flightaware.aeroapi',
  tieneItinerario: true,

  async lookup(q: FlightQuery, previous: EstadoVuelo): Promise<AeroSnapshot | null> {
    const key = process.env.FLIGHT_API_KEY;
    if (!key) return null;
    const headers = { 'x-apikey': key, Accept: 'application/json' };

    // Bound the window to the operating date so we get the right daily leg. A day either side absorbs
    // timezone skew between the client's declared local time and UTC.
    const day = new Date(`${q.fechaOperacion}T00:00:00Z`);
    const start = new Date(day.getTime() - 86_400_000).toISOString().slice(0, 10);
    const end = new Date(day.getTime() + 2 * 86_400_000).toISOString().slice(0, 10);

    const url =
      `${BASE}/flights/${encodeURIComponent(q.iataFlight)}` +
      `?start=${start}&end=${end}&max_pages=1`;
    const res = await fetchWithTimeout(url, { headers });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`AeroAPI /flights respondió ${res.status}`);
    const body = (await res.json()) as { flights?: AeroFlight[] };

    const flights = body.flights ?? [];
    if (!flights.length) return null;

    // Prefer the leg whose departure falls on the declared operating date; otherwise the closest one.
    const target =
      flights.find((f) =>
        (f.scheduled_off ?? f.estimated_off ?? f.actual_off ?? '').startsWith(q.fechaOperacion),
      ) ?? flights[0];

    const estado = mapEstado(target, previous);

    // Only spend a position query while the aircraft is actually flying.
    let posicion: PositionObservation | null = null;
    let positionRaw: unknown = null;
    if (estado === 'en_ruta' && target.fa_flight_id) {
      try {
        const pRes = await fetchWithTimeout(
          `${BASE}/flights/${encodeURIComponent(target.fa_flight_id)}/position`,
          { headers },
        );
        if (pRes.ok) {
          const pBody = (await pRes.json()) as AeroPosition;
          positionRaw = pBody;
          const lp = pBody.last_position;
          if (lp) {
            posicion = {
              callsign: target.ident ?? q.callsign ?? q.iataFlight,
              lat: typeof lp.latitude === 'number' ? lp.latitude : null,
              lon: typeof lp.longitude === 'number' ? lp.longitude : null,
              altitudeFt: altitudeFt(lp.altitude),
              onGround: false,
              groundSpeedKt: typeof lp.groundspeed === 'number' ? lp.groundspeed : null,
              seenSec: lp.timestamp
                ? Math.max(0, Math.round((Date.now() - Date.parse(lp.timestamp)) / 1000))
                : null,
            };
          }
        }
      } catch {
        // Position is enrichment, not the answer. A failure here must not discard the schedule data we
        // already have, which is the part the cotejo depends on.
      }
    }

    const filedIata = target.destination?.code_iata ?? null;

    return {
      fuente: this.name,
      tieneItinerario: true,
      aerolinea: target.operator_iata ?? target.operator ?? null,
      origenIata: target.origin?.code_iata ?? null,
      destinoIata: filedIata,
      etdProgramado: target.scheduled_off ?? null,
      etaProgramado: target.scheduled_in ?? null,
      etdReal: target.actual_off ?? null,
      etaEstimado: target.estimated_in ?? null,
      arriboReal: target.actual_on ?? target.actual_in ?? null,
      estado,
      posicion,
      raw: { flight: target, position: positionRaw },
      detalle: {
        faFlightId: target.fa_flight_id ?? null,
        aeronaveTipo: target.aircraft_type ?? null,
        matricula: target.registration ?? null,
        progresoPct:
          typeof target.progress_percent === 'number' ? Math.round(target.progress_percent) : null,
        rutaFiled: target.route ?? null,
        // AeroAPI returns route_distance in statute miles.
        distanciaKm:
          typeof target.route_distance === 'number' ? Math.round(target.route_distance * 1.609344) : null,
        terminalDestino: target.destination?.terminal ?? null,
        puertaDestino: target.destination?.gate ?? null,
        pistaSalida: target.actual_runway_off ?? null,
        pistaLlegada: target.actual_runway_on ?? null,
        cancelado: Boolean(target.cancelled),
        desviado: Boolean(target.diverted),
        destinoRealIata: target.diverted ? filedIata : null,
      },
    };
  },
};

/** Narrowing helper so callers can persist the extra columns only when the source supplied them. */
export function isAeroSnapshot(s: FlightSnapshot | null): s is AeroSnapshot {
  return Boolean(s && 'detalle' in s);
}
