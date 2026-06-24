/**
 * deniedParties.ts — F18: Denied-party / sanctions screening service.
 *
 * loadDeniedParties() is an optional helper for callers that want to load the list
 * outside the request cycle (e.g. background workers, ingestion scripts).
 * In the hot path, risk.ts calls loadConfig<DeniedPartyEntry[]>('denied_parties') directly.
 *
 * Normalization note: the matcher in shared/risk/lists.ts normalizes names (NFD, lowercase)
 * and cleans IDs (uppercase, strip spaces/hyphens) at match time, so raw entries can be stored
 * as-is from the source list. No normalization is needed here before persisting to config.
 */

import type { DeniedPartyEntry } from '../../../shared/risk/lists';

export type { DeniedPartyEntry };

/**
 * Normalizes a raw denied-party entry for storage/comparison.
 * - Trims whitespace from name and IDs
 * - Ensures source is one of the known values or undefined
 */
export function normalizeDeniedPartyEntry(raw: Partial<DeniedPartyEntry>): DeniedPartyEntry | null {
  const name = raw.name?.trim();
  if (!name) return null;

  const ids = (raw.ids ?? []).map((id) => id.trim()).filter(Boolean);
  const source = raw.source && ['OFAC', 'BIS', 'EU', 'UN'].includes(raw.source) ? raw.source : undefined;
  const program = raw.program?.trim() || undefined;

  return { name, ...(ids.length > 0 && { ids }), ...(source && { source }), ...(program && { program }) };
}
