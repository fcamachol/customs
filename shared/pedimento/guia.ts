// Guía identity for cross-source comparison.
//
// Guía strings reach us from two independent sources — the manifest Excel (shipments.data.guideId)
// and the pedimento PDF text (pedimentos.covered_guias) — and the same guía is routinely written
// with different punctuation, spacing or casing on each side ("369-94268462" vs "36994268462",
// "g-1" vs "G1"). Comparing them with raw string equality reports false mismatches that block
// prevalidation. Normalize both sides before matching, exactly as normMasterGuide already does for
// master guides: strip everything that is not a letter or digit and uppercase.
//
// Normalization is COMPARE-TIME ONLY. Never persist or display the normalized form — the raw value
// is what the manifest and the pedimento actually declared and is what a human must reconcile.

export function normGuia(s: string): string {
  return (s ?? '').replace(/[^a-z0-9]/gi, '').toUpperCase();
}

/**
 * Build a Set of normalized guías for membership tests. Empty/blank inputs (which normalize to '')
 * are dropped so they never spuriously match another blank guía.
 */
export function normGuiaSet(guias: Iterable<string>): Set<string> {
  const set = new Set<string>();
  for (const g of guias) {
    const n = normGuia(g);
    if (n) set.add(n);
  }
  return set;
}

/**
 * Index raw values by their normalized guía, keeping the FIRST raw value seen for each normalized
 * key. Lets a matcher compare normalized while still reporting/keying by the raw manifest value
 * (e.g. coverage's per-guía count, whose output lists raw manifest guías).
 */
export function indexByNormGuia(values: Iterable<string>): Map<string, string> {
  const m = new Map<string, string>();
  for (const v of values) {
    const n = normGuia(v);
    if (n && !m.has(n)) m.set(n, v);
  }
  return m;
}
