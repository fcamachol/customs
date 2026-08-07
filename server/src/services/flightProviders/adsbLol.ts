import { deriveEstadoFromPosition, normalizeCallsign, type EstadoVuelo, type PositionObservation } from '../../../../shared/operaciones/vuelo';
import { fetchWithTimeout, type FlightProvider, type FlightQuery, type FlightSnapshot } from './types';

/**
 * adsb.lol — live ADS-B, community-fed, no API key.
 *
 * Verified live against the running service: `GET /v2/callsign/{callsign}` returns
 * `{ac: [...], msg, now, total}` and each aircraft carries `hex, flight, lat, lon, alt_baro, gs,
 * track, seen`. Two field quirks matter and are handled below:
 *   - `flight` is space-padded to 8 chars ("XCHDF   "), so it must be trimmed before comparing
 *   - `alt_baro` is the literal string "ground" when the aircraft is on the ground, not a number
 *
 * Position only. It cannot see a flight that has not departed or that landed a while ago, which is
 * why `tieneItinerario` is false and why absence is reported as null rather than as "landed" —
 * `deriveEstadoFromPosition` decides that from the previous state, not from silence.
 */
const BASE = process.env.ADSB_BASE_URL ?? 'https://api.adsb.lol';

interface AdsbAircraft {
  hex?: string;
  flight?: string;
  lat?: number;
  lon?: number;
  alt_baro?: number | 'ground';
  gs?: number;
  seen?: number;
  seen_pos?: number;
}

export const adsbLolProvider: FlightProvider = {
  name: 'adsb.lol',
  tieneItinerario: false,

  async lookup(q: FlightQuery, previous: EstadoVuelo): Promise<FlightSnapshot | null> {
    // Without an ICAO callsign there is nothing to ask for: the IATA number is not what aircraft
    // transmit. Reporting null lets the cotejo raise PA-10 instead of pretending we checked.
    if (!q.callsign) return null;

    const res = await fetchWithTimeout(`${BASE}/v2/callsign/${encodeURIComponent(q.callsign)}`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`adsb.lol respondió ${res.status}`);
    const body = (await res.json()) as { ac?: AdsbAircraft[]; total?: number };

    const wanted = normalizeCallsign(q.callsign);
    const ac = (body.ac ?? []).find((a) => normalizeCallsign(a.flight) === wanted) ?? (body.ac ?? [])[0];

    if (!ac) {
      // Not transmitting. Genuinely ambiguous — pre-departure or already landed — so hand the
      // previous state to the deriver and record that we looked.
      return {
        fuente: this.name,
        tieneItinerario: false,
        aerolinea: null,
        origenIata: null,
        destinoIata: null,
        etdProgramado: null,
        etaProgramado: null,
        etdReal: null,
        etaEstimado: null,
        arriboReal: null,
        estado: deriveEstadoFromPosition(null, previous),
        posicion: null,
        raw: body,
      };
    }

    const onGround = ac.alt_baro === 'ground';
    const altitudeFt = typeof ac.alt_baro === 'number' ? ac.alt_baro : null;
    const posicion: PositionObservation = {
      callsign: normalizeCallsign(ac.flight) || wanted,
      lat: typeof ac.lat === 'number' ? ac.lat : null,
      lon: typeof ac.lon === 'number' ? ac.lon : null,
      altitudeFt,
      onGround,
      groundSpeedKt: typeof ac.gs === 'number' ? ac.gs : null,
      seenSec: typeof ac.seen === 'number' ? ac.seen : null,
    };

    return {
      fuente: this.name,
      tieneItinerario: false,
      aerolinea: null,
      origenIata: null,
      destinoIata: null,
      etdProgramado: null,
      etaProgramado: null,
      etdReal: null,
      etaEstimado: null,
      arriboReal: null,
      estado: deriveEstadoFromPosition(posicion, previous),
      posicion,
      raw: body,
    };
  },
};
