import type { EstadoVuelo } from '../../../../shared/operaciones/vuelo';
import { adsbLolProvider } from './adsbLol';
import { aeroApiProvider } from './aeroApi';
import type { FlightProvider, FlightQuery, FlightSnapshot } from './types';

export type { FlightProvider, FlightQuery, FlightSnapshot } from './types';
export { adsbLolProvider } from './adsbLol';
export { aeroApiProvider, isAeroSnapshot, type AeroDetail, type AeroSnapshot } from './aeroApi';

/**
 * Provider chain, best-first.
 *
 * AeroAPI leads when a key is present because it answers the question the cotejo actually needs
 * (itinerary), then ADS-B corroborates position. With no key the chain degrades to ADS-B alone, which
 * still delivers the operationally critical facts — took off, landed — and PA-05 honestly reports
 * itself as uncheckable rather than passing silently.
 *
 * Set FLIGHT_API_PROVIDER=adsb to pin ADS-B even when a key exists (useful for cost control or to
 * reproduce a finding).
 */
export function flightProviderChain(): FlightProvider[] {
  const pinned = (process.env.FLIGHT_API_PROVIDER ?? '').toLowerCase();
  if (pinned === 'adsb' || pinned === 'adsb.lol') return [adsbLolProvider];
  if (pinned === 'aeroapi' || pinned === 'flightaware') return [aeroApiProvider];
  // AeroAPI leads whenever a key exists: it answers the itinerary questions the cotejo needs AND, via
  // Aireon space-based ADS-B, sees the oceanic legs community receivers cannot. ADS-B stays behind it
  // as a free corroborating fallback, and is the whole chain when no key is configured.
  return process.env.FLIGHT_API_KEY ? [aeroApiProvider, adsbLolProvider] : [adsbLolProvider];
}

export interface ChainResult {
  snapshot: FlightSnapshot | null;
  /** Providers that threw, so a partial outage is visible instead of looking like "flight unknown". */
  errors: Array<{ provider: string; message: string }>;
}

/**
 * Ask each provider in turn and take the first usable answer.
 *
 * A provider that THROWS is an outage and must not be mistaken for "this flight does not exist" —
 * the errors are collected and returned so the caller can record a transient failure and retry,
 * rather than writing a false PA-10 into the caso.
 */
export async function lookupFlight(q: FlightQuery, previous: EstadoVuelo): Promise<ChainResult> {
  const errors: ChainResult['errors'] = [];
  for (const provider of flightProviderChain()) {
    try {
      const snapshot = await provider.lookup(q, previous);
      if (snapshot) return { snapshot, errors };
    } catch (err) {
      errors.push({ provider: provider.name, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return { snapshot: null, errors };
}
