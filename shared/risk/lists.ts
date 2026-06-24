import { canonicalize, norm } from './normalize';

// From Risk analysis 17 feb '25.xlsx — piracy brands (col BL) + prohibited keywords (col BA).
export const PIRACY_BRANDS = [
  'Adidas', 'Nike', 'Bimba y Lola', 'Gucci', 'Samsung',
  'Apple', 'Louis Vuitton', 'Dolce and Gabbana', 'Ray Ban',
];

export const PROHIBITED_KEYWORDS = [
  'maquillaje', 'liquido', 'pastilla', 'capsula', 'cápsula', 'globo',
  'pegamento', 'autoparte', 'pistola', 'droga', 'mariguana',
  'suplemento', 'vitamina', 'medicamento',
];

/**
 * Pre-computed canonical forms for the default lists.
 * Memoized at module scope to avoid re-canonicalizing on every call (hot path).
 * Only default-list entries are memoized; injected override lists are smaller
 * and less frequent so they are canonicalized on the fly.
 */
const BRAND_CANONICALS = PIRACY_BRANDS.map((b) => canonicalize(b));
const PROHIBITED_CANONICALS = PROHIBITED_KEYWORDS.map((k) => canonicalize(k));

/**
 * False-positive guard threshold for the tight path.
 * Only use tight matching when the needle's tight form is >= 4 characters.
 * Short collapsed forms (e.g. "id", "ok", "s4") would match too broadly after
 * all whitespace and punctuation are removed.
 */
const TIGHT_MIN_LENGTH = 4;

/**
 * Core matching function used by matchesBrand and matchesProhibited.
 *
 * Matching strategy (evasion-resistant, two-path):
 *   1. Loose path (always): checks if the loose-form needle appears in the
 *      loose-form haystack. Catches: diacritic evasion, Cyrillic/Greek homoglyphs.
 *   2. Tight path (needle tight form >= 4 chars only): checks if the tight-form
 *      needle appears in the tight-form haystack. Catches: leetspeak evasion
 *      (N1ke → nike) and token-split evasion (Guc ci → gucci).
 *
 * @param description - Raw shipment description (haystack).
 * @param entries     - List of brand/keyword strings (needles).
 * @param canonicals  - Pre-computed canonical forms for `entries` (1:1 correspondence).
 * @returns The first matching entry string, or null if no match.
 */
function matchAgainst(
  description: string,
  entries: string[],
  canonicals: ReturnType<typeof canonicalize>[],
): string | null {
  const d = canonicalize(description);
  for (let i = 0; i < entries.length; i++) {
    const ec = canonicals[i];
    // Loose path: always on — catches diacritics and confusable/homoglyph evasion
    if (d.loose.includes(ec.loose)) return entries[i];
    // Tight path: catches leetspeak and token-split evasion.
    // Guard: only apply when the needle's tight form is >= TIGHT_MIN_LENGTH chars
    // to prevent short collapsed forms from matching too broadly.
    if (ec.tight.length >= TIGHT_MIN_LENGTH && d.tight.includes(ec.tight)) return entries[i];
  }
  return null;
}

/**
 * A single entry in the denied-party / sanctions screening list.
 * Source lists: OFAC SDN, BIS Entity List, EU CFSP Consolidated, UN Consolidated.
 *
 * TODO(F20): when blind-index tokenization lands, `ids` keying should align with
 * F20's tokenized identity so that encrypted RFC/CURP/foreignTaxId can be screened
 * without decrypting the full shipment payload here. Coordinate key derivation.
 */
export interface DeniedPartyEntry {
  name: string;
  ids?: string[];
  source?: 'OFAC' | 'BIS' | 'EU' | 'UN';
  program?: string;
}

/**
 * Screens a set of names and IDs against the denied-party list.
 * - IDs (RFC/CURP/foreignTaxId/sender.taxId): exact match after cleaning (uppercase + remove spaces/hyphens)
 * - Names (consignee.name, sender.name): normalized substring/token match
 *
 * Returns a { matched, source, program } object describing the first match, or null if no match.
 * Returns null when the list is empty or undefined (no screening → no false positives).
 */
export function matchesDeniedParty(
  fields: { names: string[]; ids: string[] },
  list?: DeniedPartyEntry[],
): { matched: string; source?: string; program?: string } | null {
  if (!list || list.length === 0) return null;

  const cleanId = (s: string) => s.toUpperCase().replace(/[\s\-]/g, '');
  const cleanedIds = fields.ids.map((id) => cleanId(id)).filter(Boolean);
  const normNames = fields.names.map((n) => norm(n)).filter(Boolean);

  for (const entry of list) {
    // Exact ID match (preferred — fewer false positives)
    if (entry.ids && entry.ids.length > 0) {
      const entryIds = entry.ids.map((id) => cleanId(id));
      for (const eid of entryIds) {
        if (eid && cleanedIds.includes(eid)) {
          return { matched: entry.name, source: entry.source, program: entry.program };
        }
      }
    }

    // Normalized name match: entry name tokens must appear (in order) in the consignee/sender name.
    // Token-based check reduces false positives from very common short names.
    const entryNorm = norm(entry.name);
    const entryTokens = entryNorm.split(/\s+/).filter((t) => t.length >= 3);
    if (entryTokens.length === 0) continue;

    for (const candidate of normNames) {
      const allTokensMatch = entryTokens.every((token) => candidate.includes(token));
      if (allTokensMatch) {
        return { matched: entry.name, source: entry.source, program: entry.program };
      }
    }
  }

  return null;
}

/**
 * Returns the matched brand name or null.
 * Accepts an optional override list; falls back to PIRACY_BRANDS.
 *
 * Uses evasion-resistant two-path canonicalization (see matchAgainst).
 */
export function matchesBrand(description: string, brands?: string[]): string | null {
  if (brands && brands.length > 0) {
    // Override list: canonicalize on the fly (less frequent, smaller list)
    return matchAgainst(description, brands, brands.map((b) => canonicalize(b)));
  }
  // Default list: use pre-computed module-scope canonicals
  return matchAgainst(description, PIRACY_BRANDS, BRAND_CANONICALS);
}

/**
 * Returns the matched prohibited keyword or null.
 * Accepts an optional override list; falls back to PROHIBITED_KEYWORDS.
 *
 * Uses evasion-resistant two-path canonicalization (see matchAgainst).
 */
export function matchesProhibited(description: string, keywords?: string[]): string | null {
  if (keywords && keywords.length > 0) {
    // Override list: canonicalize on the fly (less frequent, smaller list)
    return matchAgainst(description, keywords, keywords.map((k) => canonicalize(k)));
  }
  // Default list: use pre-computed module-scope canonicals
  return matchAgainst(description, PROHIBITED_KEYWORDS, PROHIBITED_CANONICALS);
}
