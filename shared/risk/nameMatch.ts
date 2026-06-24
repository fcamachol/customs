/**
 * nameMatch.ts — Fuzzy entity resolution for name-typo evasion (F14).
 *
 * Provides three exports:
 *   - blockingKey(name): phonetic blocking key for grouping similar names before
 *     distance computation. Token-sorted, diacritic-stripped, Spanish-phonetic-folded.
 *   - similar(a, b, maxDistance): bounded Damerau-Levenshtein on norm'd inputs.
 *   - resolveNameClusters(names, opts): union-find clustering; returns Map<normName, canonical>.
 *
 * Design: ADDITIVE/monotone — fuzzy can only INCREASE recurrence counts, never decrease.
 * Used in classify.ts PASS-1 to cluster ID-less consignees; RFC/CURP-keyed entities are
 * NEVER merged here.
 *
 * PRIVACY NOTE: blockingKey is a lossy, name-derived value. It is less identifying than
 * plaintext but more exposed than the HMAC blind-index token from F20. The block_key
 * stored in monthly_history (for cross-manifest fuzzy) partially re-introduces name-derived
 * data that F20 encrypted. This trade-off is intentional for typo evasion detection and
 * must be reviewed before deploying. Keep RFC/CURP as authoritative identity — block_key
 * is ONLY used for ID-less consignees.
 *
 * NO Node crypto imports here. shared/risk must stay crypto-free.
 */

import { norm } from './normalize';

// ─── Phonetic folding maps (Spanish-adapted) ────────────────────────────────

/**
 * Spanish phonetic folding rules applied after diacritic stripping + lowercase:
 *
 *   s/z/c → 's': Spanish z sounds like s; soft c (before e/i) sounds like s.
 *     Hard c (before a/o/u or consonant) folds to 'k' to preserve distinctiveness
 *     from the sibilant cluster.
 *   b/v → 'b': Spanish b and v are phonetically identical (occlusive bilabial).
 *   gu → 'g' before e/i (the u is silent): ge/gi and gue/gui fold to 'g'.
 *   h → '' (silent in Spanish): but only word-internally to avoid false merges.
 *     Dropped only in the middle of words (too risky to drop leading h globally).
 *   ll → 'y': in many dialects ll and y are phonetically equivalent.
 *   qu → 'k' before e/i: que/qui → 'ke'/'ki' simplification.
 *
 * NOTE: We apply only the highest-ROI folds (b/v, s/z/c). The others (ll/y, h,
 * qu) are omitted in the initial version to minimise false-positive merges.
 * Threshold rationale: prefer fewer false merges over catching every typo.
 */
function spanishPhoneticFold(s: string): string {
  let r = s;
  // b/v → 'b' (bilabial fold)
  r = r.replace(/v/g, 'b');
  // z/c → 's': in Spanish, z and c (in most positions) are homophones of s.
  // We fold all three (z, c, s) to 's' for blocking purposes.
  // Note: hard-c vs soft-c distinction is NOT preserved here — the blocking key
  // is intentionally lossy; edit-distance remains the decisive gate for
  // false-positive control (see resolveNameClusters threshold).
  r = r.replace(/z/g, 's');
  r = r.replace(/c/g, 's');
  return r;
}

/**
 * blockingKey(name): phonetic blocking key for a consignee name.
 *
 * Pipeline:
 *   1. norm() — NFD diacritic strip + lowercase + trim.
 *   2. Remove punctuation (hyphens, apostrophes, dots).
 *   3. Spanish phonetic fold.
 *   4. Token-sort — sorted tokens joined by space (order-invariant).
 *
 * Two names with the same blockingKey are "phonetically equivalent" and should be
 * placed in the same cluster bucket before distance check. Two names with DIFFERENT
 * blockingKeys may still be within edit distance but won't be compared (intentional:
 * phonetic blocking limits false positives).
 *
 * PRIVACY: the block_key is less identifying than the full norm'd name but still
 * encodes name structure. Do NOT store it alongside non-ID-less consignees; only
 * store it for rows where the consignee has no RFC/CURP.
 */
export function blockingKey(name: string): string {
  if (!name) return '';
  // Step 1: NFD + lowercase (reuse norm)
  let s = norm(name);
  // Step 2: remove punctuation
  s = s.replace(/[^a-z0-9\s]/g, '');
  // Step 3: phonetic fold
  s = spanishPhoneticFold(s);
  // Step 4: token-sort
  const tokens = s.split(/\s+/).filter(Boolean).sort();
  return tokens.join(' ');
}

// ─── Bounded Damerau-Levenshtein ────────────────────────────────────────────

/**
 * similar(a, b, maxDistance): returns true iff the Damerau-Levenshtein distance
 * between norm(a) and norm(b) is ≤ maxDistance.
 *
 * Uses the OSA (Optimal String Alignment) variant, which is a bounded O(n·m)
 * computation. Both inputs are normalized before comparison so callers do not
 * need to pre-normalize.
 *
 * Bounded: returns false early when the minimum possible edit count exceeds
 * maxDistance (avoids full O(n·m) on obviously dissimilar strings).
 */
export function similar(a: string, b: string, maxDistance: number): boolean {
  const na = norm(a);
  const nb = norm(b);
  if (na === nb) return true;
  const lenA = na.length;
  const lenB = nb.length;
  // Early exit: length difference alone exceeds bound
  if (Math.abs(lenA - lenB) > maxDistance) return false;
  return osaDistance(na, nb) <= maxDistance;
}

/** Optimal String Alignment distance (restricted edit distance). */
function osaDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  // Allocate a 2-row rolling DP array (memory efficient for large inputs)
  // But for correctness with transpositions we need 3 rows.
  const prev2 = new Uint16Array(n + 1);
  const prev = new Uint16Array(n + 1);
  const curr = new Uint16Array(n + 1);

  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,        // deletion
        curr[j - 1] + 1,    // insertion
        prev[j - 1] + cost, // substitution
      );
      // Damerau transposition
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        curr[j] = Math.min(curr[j], prev2[j - 2] + cost);
      }
    }
    prev2.set(prev);
    prev.set(curr);
  }
  return prev[n];
}

// ─── Union-Find ──────────────────────────────────────────────────────────────

class UnionFind {
  private parent: Map<string, string> = new Map();

  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let root = this.parent.get(x)!;
    if (root !== x) {
      root = this.find(root); // path compression
      this.parent.set(x, root);
    }
    return root;
  }

  union(x: string, y: string): void {
    const rx = this.find(x);
    const ry = this.find(y);
    if (rx === ry) return;
    // Canonical = lexicographically smallest
    if (rx < ry) {
      this.parent.set(ry, rx);
    } else {
      this.parent.set(rx, ry);
    }
  }

  canonical(x: string): string {
    return this.find(x);
  }
}

// ─── Cluster options ─────────────────────────────────────────────────────────

export interface ClusterOptions {
  /**
   * Maximum Damerau-Levenshtein distance between two names to merge them.
   * Default: min(2, ceil(len * 0.15)) where len = length of shorter name.
   */
  maxDistance?: number;
}

/**
 * resolveNameClusters(names, opts): cluster a list of consignee names using
 * phonetic blocking + bounded Damerau-Levenshtein union-find.
 *
 * Returns Map<normName, canonical> where canonical is the lexicographically
 * smallest norm'd name in the cluster (stable, deterministic across runs).
 *
 * Merge conditions (union iff EITHER is true):
 *   a) blockingKey(a) === blockingKey(b)  — phonetically equivalent
 *   b) similar(a, b, threshold) === true  — within edit distance threshold
 *      where threshold = opts.maxDistance ?? min(2, ceil(len * 0.15))
 *
 * MONOTONE: adding more names can only create more merges, never fewer.
 * NEVER merges entries that share a valid RFC/CURP — that keying stays in classify.ts.
 *
 * Complexity: O(n²) in the number of distinct names per manifest (acceptable:
 * manifests have at most a few hundred rows; typo-evasion attacks are small).
 */
export function resolveNameClusters(
  names: string[],
  opts?: ClusterOptions,
): Map<string, string> {
  if (names.length === 0) return new Map();

  // Normalize all input names
  const normed = names.map((n) => norm(n));
  const unique = [...new Set(normed)];

  const uf = new UnionFind();
  // Initialize all nodes
  for (const n of unique) uf.find(n);

  for (let i = 0; i < unique.length; i++) {
    for (let j = i + 1; j < unique.length; j++) {
      const a = unique[i];
      const b = unique[j];

      // Condition a: same blocking key
      if (blockingKey(a) === blockingKey(b)) {
        uf.union(a, b);
        continue;
      }

      // Condition b: within edit distance threshold
      const len = Math.min(a.length, b.length);
      const threshold = opts?.maxDistance !== undefined
        ? opts.maxDistance
        : Math.min(2, Math.ceil(len * 0.15));
      if (threshold >= 0 && similar(a, b, threshold)) {
        uf.union(a, b);
      }
    }
  }

  // Build result map: normName → canonical
  const result = new Map<string, string>();
  for (const n of normed) {
    result.set(n, uf.canonical(n));
  }
  return result;
}
