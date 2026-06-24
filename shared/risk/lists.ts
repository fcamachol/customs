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

function norm(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
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

/** Returns the matched brand name or null. Accepts an optional override list; falls back to PIRACY_BRANDS. */
export function matchesBrand(description: string, brands?: string[]): string | null {
  const list = brands && brands.length > 0 ? brands : PIRACY_BRANDS;
  const d = norm(description);
  return list.find((b) => d.includes(norm(b))) ?? null;
}

/** Returns the matched keyword or null. Accepts an optional override list; falls back to PROHIBITED_KEYWORDS. */
export function matchesProhibited(description: string, keywords?: string[]): string | null {
  const list = keywords && keywords.length > 0 ? keywords : PROHIBITED_KEYWORDS;
  const d = norm(description);
  return list.find((k) => d.includes(norm(k))) ?? null;
}
