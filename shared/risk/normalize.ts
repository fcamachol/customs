/**
 * normalize.ts — Evasion-resistant text canonicalization for the risk engine.
 *
 * Provides two forms of canonical text for matching:
 *   - `loose`: NFD diacritic strip + Unicode confusable/homoglyph fold + lowercase.
 *              Preserves whitespace/token boundaries. Used for standard substring matching.
 *   - `tight`: loose + leetspeak substitution + removal of ALL non-alphanumeric chars
 *              (including whitespace). Collapses token-split evasion (e.g. "Guc ci" → "gucci").
 *
 * False-positive guard: the `tight` path is only used for needles whose tight form
 * is >= 4 characters. Short keywords (e.g. "id", "ok") would produce too many collisions
 * after collapsing all non-alphanumeric characters.
 *
 * Usage:
 *   canonicalize(s) → { loose, tight }
 *   norm(s) → loose form only (NFD+lowercase, preserves boundaries) — same semantics as
 *              the prior inline norm() in signals.ts and lists.ts. Use for entity keying.
 */

/**
 * CONFUSABLES TABLE — Cyrillic and Greek homoglyphs mapped to their Latin equivalents.
 * Only visually indistinguishable or nearly-indistinguishable characters are included.
 * Source: Unicode confusables.txt (https://www.unicode.org/reports/tr39/#Confusable_Detection)
 * Each entry is documented with its Unicode code point for auditability.
 *
 * AUDITED entries only — do NOT add characters without reviewing the Unicode confusables data.
 */
const CONFUSABLES: Record<string, string> = {
  // ── Cyrillic → Latin ────────────────────────────────────────────────────────
  'а': 'a', // Cyrillic а (U+0430) → Latin a
  'е': 'e', // Cyrillic е (U+0435) → Latin e
  'о': 'o', // Cyrillic о (U+043E) → Latin o
  'р': 'p', // Cyrillic р (U+0440) → Latin p
  'с': 'c', // Cyrillic с (U+0441) → Latin c
  'х': 'x', // Cyrillic х (U+0445) → Latin x
  'і': 'i', // Cyrillic і (U+0456) → Latin i  [most common brand-evasion glyph]
  'ѕ': 's', // Cyrillic ѕ (U+0455) → Latin s
  'у': 'y', // Cyrillic у (U+0443) → Latin y
  // ── Greek → Latin ───────────────────────────────────────────────────────────
  'ν': 'v', // Greek ν nu        (U+03BD) → Latin v
  'ο': 'o', // Greek ο omicron   (U+03BF) → Latin o
  'α': 'a', // Greek α alpha     (U+03B1) → Latin a
  'ε': 'e', // Greek ε epsilon   (U+03B5) → Latin e
  'ρ': 'p', // Greek ρ rho       (U+03C1) → Latin p
};

/**
 * LEET TABLE — common leet substitutions.
 * Applied only in the `tight` form (after loose-form confusable folding).
 * Choices for ambiguous mappings (e.g. 1 could be i or l) are documented.
 */
const LEET: Record<string, string> = {
  '0': 'o', // 0 → o  (most common; rarely confused with 'l')
  '1': 'i', // 1 → i  (chosen over 'l' — far more common in brand evasion: N1ke)
  '3': 'e', // 3 → e
  '4': 'a', // 4 → a
  '5': 's', // 5 → s
  '7': 't', // 7 → t
  '@': 'a', // @ → a  (common in social-media style evasion)
  '$': 's', // $ → s
};

/** Precomputed regex for confusables replacement (built once at module load). */
const CONFUSABLES_RE = new RegExp(
  Object.keys(CONFUSABLES)
    .map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|'),
  'g',
);

/** Precomputed regex for leet replacement (built once at module load). */
const LEET_RE = new RegExp(
  Object.keys(LEET)
    .map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|'),
  'g',
);

/**
 * Strip NFD diacritic combining marks (U+0300–U+036F range).
 * Regex covers the full Combining Diacritical Marks block.
 */
const DIACRITICS_RE = /[̀-ͯ]/g;

/** Remove all non-alphanumeric characters (including whitespace). Used for tight form. */
const NON_ALNUM_RE = /[^a-z0-9]/g;

/**
 * Canonicalize a string into two forms for evasion-resistant matching.
 *
 * @param s - Input string (e.g. a shipment description or a brand keyword).
 * @returns `{ loose, tight }`:
 *   - `loose`: NFD strip + confusable fold + lowercase. Spaces preserved.
 *   - `tight`: loose + leet substitution + remove all non-alphanumeric (incl. spaces).
 *
 * @example
 * canonicalize('N1ke')     → { loose: 'n1ke',  tight: 'nike' }
 * canonicalize('Guc ci')   → { loose: 'guc ci', tight: 'gucci' }
 * canonicalize('Nіke')     → { loose: 'nike',   tight: 'nike' }  // Cyrillic і→i in loose
 */
export function canonicalize(s: string): { loose: string; tight: string } {
  if (!s) return { loose: '', tight: '' };

  // Step 1: NFD decompose → strip combining diacritics → fold confusables → lowercase
  const loose = s
    .normalize('NFD')
    .replace(DIACRITICS_RE, '')
    .replace(CONFUSABLES_RE, (ch) => CONFUSABLES[ch] ?? ch)
    .toLowerCase();

  // Step 2: apply leet map → collapse all non-alphanumeric (space removal is the token-split fix)
  const tight = loose.replace(LEET_RE, (ch) => LEET[ch] ?? ch).replace(NON_ALNUM_RE, '');

  return { loose, tight };
}

/**
 * Loose-form normalization: NFD diacritic strip + lowercase. Preserves whitespace.
 *
 * Semantics are IDENTICAL to the prior inline `norm()` in signals.ts and lists.ts:
 *   (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase()
 *
 * This is intentionally NOT applying the confusable fold so that existing entity keys
 * (bbdd, smurfing, address counts) remain stable across all stored data. Confusable
 * folding is only applied in `canonicalize` for evasion-resistant brand/keyword matching,
 * not for entity identity keying.
 *
 * Re-exported from here so signals.ts can import it without circular deps and without
 * pulling in the canonicalize machinery.
 */
export const norm = (s: string): string =>
  (s ?? '').normalize('NFD').replace(DIACRITICS_RE, '').trim().toLowerCase();
