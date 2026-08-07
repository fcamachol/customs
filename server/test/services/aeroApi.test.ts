import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { aeroApiProvider, isAeroSnapshot } from '../../src/services/flightProviders/aeroApi';
import { flightProviderChain } from '../../src/services/flightProviders';

/**
 * AeroAPI adapter. Tested against a mocked fetch because the interesting risks are all in the
 * translation layer, not the network: two UNIT CONVERSIONS that would be silently wrong by a factor of
 * 100 and 1.6 respectively, and the choice of WHICH daily leg a recurring flight number refers to.
 * Those are exactly the bugs that never announce themselves.
 */

const ORIGINAL_KEY = process.env.FLIGHT_API_KEY;
const ORIGINAL_PINNED = process.env.FLIGHT_API_PROVIDER;

const flightsBody = (over: Record<string, unknown> = {}) => ({
  flights: [
    {
      fa_flight_id: 'CPA3186-1754500000-airline-0001',
      ident: 'CPA3186',
      ident_iata: 'CX3186',
      operator_iata: 'CX',
      registration: 'B-LJA',
      aircraft_type: 'B77L',
      cancelled: false,
      diverted: false,
      progress_percent: 62.4,
      route: 'HKG DCT NLU',
      route_distance: 8000, // statute miles
      origin: { code_iata: 'HKG' },
      destination: { code_iata: 'NLU', terminal: 'C', gate: 'C4' },
      scheduled_off: '2026-08-07T06:00:00Z',
      estimated_off: '2026-08-07T06:00:00Z',
      actual_off: '2026-08-07T06:05:00Z',
      scheduled_in: '2026-08-07T09:45:00Z',
      estimated_in: '2026-08-07T09:50:00Z',
      actual_on: null,
      actual_in: null,
      actual_runway_off: '07R',
      ...over,
    },
  ],
});

const positionBody = {
  last_position: {
    latitude: 21.5,
    longitude: -140.25,
    altitude: 350, // hundreds of feet → 35 000 ft
    groundspeed: 480,
    timestamp: new Date(Date.now() - 30_000).toISOString(),
  },
};

const q = { iataFlight: 'CX3186', callsign: 'CPA3186', fechaOperacion: '2026-08-07' };

beforeEach(() => {
  process.env.FLIGHT_API_KEY = 'test-key';
  delete process.env.FLIGHT_API_PROVIDER;
  vi.restoreAllMocks();
});

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.FLIGHT_API_KEY;
  else process.env.FLIGHT_API_KEY = ORIGINAL_KEY;
  if (ORIGINAL_PINNED === undefined) delete process.env.FLIGHT_API_PROVIDER;
  else process.env.FLIGHT_API_PROVIDER = ORIGINAL_PINNED;
});

function mockFetch(handler: (url: string) => { status?: number; body: unknown }) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const r = handler(String(url));
    return {
      ok: (r.status ?? 200) < 400,
      status: r.status ?? 200,
      json: async () => r.body,
    } as unknown as Response;
  }));
}

describe('aeroApiProvider — the fields the cotejo needs', () => {
  it('returns the full itinerary and marks itself as having one', async () => {
    mockFetch((url) => (url.includes('/position') ? { body: positionBody } : { body: flightsBody() }));
    const s = await aeroApiProvider.lookup(q, 'desconocido');
    expect(s).toBeTruthy();
    if (!s) return;
    expect(s.tieneItinerario).toBe(true);
    expect(s.origenIata).toBe('HKG');
    expect(s.destinoIata).toBe('NLU');
    expect(s.etdProgramado).toBe('2026-08-07T06:00:00Z');
    expect(s.etaProgramado).toBe('2026-08-07T09:45:00Z');
    expect(s.etdReal).toBe('2026-08-07T06:05:00Z');
    expect(s.etaEstimado).toBe('2026-08-07T09:50:00Z');
    expect(s.estado).toBe('en_ruta');
  });

  it('bounds the query to the operating date so a recurring flight number resolves to the right leg', async () => {
    const urls: string[] = [];
    mockFetch((url) => {
      urls.push(url);
      return url.includes('/position') ? { body: positionBody } : { body: flightsBody() };
    });
    await aeroApiProvider.lookup(q, 'desconocido');
    expect(urls[0]).toContain('start=2026-08-06');
    expect(urls[0]).toContain('end=2026-08-09');
  });

  it('picks the leg departing on the declared date, not merely the first returned', async () => {
    mockFetch((url) =>
      url.includes('/position')
        ? { body: positionBody }
        : {
            body: {
              flights: [
                { ...flightsBody().flights[0], scheduled_off: '2026-08-06T06:00:00Z', route: 'AYER' },
                { ...flightsBody().flights[0], scheduled_off: '2026-08-07T06:00:00Z', route: 'HOY' },
              ],
            },
          },
    );
    const s = await aeroApiProvider.lookup(q, 'desconocido');
    expect(isAeroSnapshot(s) && s.detalle.rutaFiled).toBe('HOY');
  });
});

describe('aeroApiProvider — unit conversions', () => {
  it('multiplies altitude by 100, because AeroAPI reports hundreds of feet', async () => {
    // Storing 350 raw would report a 777 cruising at 350 ft.
    mockFetch((url) => (url.includes('/position') ? { body: positionBody } : { body: flightsBody() }));
    const s = await aeroApiProvider.lookup(q, 'desconocido');
    expect(s?.posicion?.altitudeFt).toBe(35_000);
  });

  it('converts route distance from statute miles to kilometres', async () => {
    mockFetch((url) => (url.includes('/position') ? { body: positionBody } : { body: flightsBody() }));
    const s = await aeroApiProvider.lookup(q, 'desconocido');
    expect(isAeroSnapshot(s) && s.detalle.distanciaKm).toBe(12_875);
  });

  it('rounds progress to a whole percent', async () => {
    mockFetch((url) => (url.includes('/position') ? { body: positionBody } : { body: flightsBody() }));
    const s = await aeroApiProvider.lookup(q, 'desconocido');
    expect(isAeroSnapshot(s) && s.detalle.progresoPct).toBe(62);
  });
});

describe('aeroApiProvider — state mapping', () => {
  it('treats wheels-down as landed, which is what starts the unload clock', async () => {
    mockFetch(() => ({ body: flightsBody({ actual_on: '2026-08-07T09:42:00Z' }) }));
    const s = await aeroApiProvider.lookup(q, 'en_ruta');
    expect(s?.estado).toBe('aterrizado');
    expect(s?.arriboReal).toBe('2026-08-07T09:42:00Z');
  });

  it('reports a cancellation, which no position feed can ever know', async () => {
    mockFetch(() => ({ body: flightsBody({ cancelled: true }) }));
    const s = await aeroApiProvider.lookup(q, 'programado');
    expect(s?.estado).toBe('cancelado');
    expect(isAeroSnapshot(s) && s.detalle.cancelado).toBe(true);
  });

  it('reports a diversion and keeps the filed destination for comparison', async () => {
    mockFetch(() => ({ body: flightsBody({ diverted: true }) }));
    const s = await aeroApiProvider.lookup(q, 'en_ruta');
    expect(s?.estado).toBe('desviado');
    expect(isAeroSnapshot(s) && s.detalle.destinoRealIata).toBe('NLU');
  });

  it('flags a delay when the estimate slips more than half an hour past schedule', async () => {
    mockFetch(() => ({
      body: flightsBody({ actual_off: null, estimated_off: '2026-08-07T07:30:00Z' }),
    }));
    const s = await aeroApiProvider.lookup(q, 'programado');
    expect(s?.estado).toBe('demorado');
  });
});

describe('aeroApiProvider — failure behaviour', () => {
  it('skips the position call when the flight is not airborne, to avoid paying for it', async () => {
    const urls: string[] = [];
    mockFetch((url) => {
      urls.push(url);
      return { body: flightsBody({ actual_off: null, actual_on: null }) };
    });
    await aeroApiProvider.lookup(q, 'programado');
    expect(urls.some((u) => u.includes('/position'))).toBe(false);
  });

  it('keeps the schedule when the position call fails', async () => {
    // Position is enrichment; losing it must not discard the data the cotejo actually depends on.
    mockFetch((url) => (url.includes('/position') ? { status: 500, body: {} } : { body: flightsBody() }));
    const s = await aeroApiProvider.lookup(q, 'desconocido');
    expect(s?.etaProgramado).toBe('2026-08-07T09:45:00Z');
    expect(s?.posicion).toBeNull();
  });

  it('returns null — not an error — when the flight simply is not known', async () => {
    mockFetch(() => ({ status: 404, body: {} }));
    expect(await aeroApiProvider.lookup(q, 'desconocido')).toBeNull();
  });

  it('throws on a server error so the caller records an outage rather than "flight unknown"', async () => {
    mockFetch(() => ({ status: 502, body: {} }));
    await expect(aeroApiProvider.lookup(q, 'desconocido')).rejects.toThrow(/502/);
  });

  it('returns null without calling out when no key is configured', async () => {
    delete process.env.FLIGHT_API_KEY;
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    expect(await aeroApiProvider.lookup(q, 'desconocido')).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('provider chain', () => {
  it('leads with AeroAPI once a key exists, keeping ADS-B as corroboration', () => {
    const chain = flightProviderChain().map((p) => p.name);
    expect(chain[0]).toBe('flightaware.aeroapi');
    expect(chain).toContain('adsb.lol');
  });

  it('falls back to ADS-B alone when no key is configured', () => {
    delete process.env.FLIGHT_API_KEY;
    expect(flightProviderChain().map((p) => p.name)).toEqual(['adsb.lol']);
  });

  it('honours an explicit pin for cost control or to reproduce a finding', () => {
    process.env.FLIGHT_API_PROVIDER = 'adsb';
    expect(flightProviderChain().map((p) => p.name)).toEqual(['adsb.lol']);
  });
});
