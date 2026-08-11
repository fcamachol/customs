import { createHash } from 'node:crypto';

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    return Object.keys(v as Record<string, unknown>).sort().reduce<Record<string, unknown>>((o, k) => {
      o[k] = canonical((v as Record<string, unknown>)[k]);
      return o;
    }, {});
  }
  return v;
}

/**
 * sha256 over the canonicalized (sorted-key) value.
 *
 * Exported because this file is the ONLY place in `shared/risk` allowed to import Node's `crypto`
 * (everything else takes hashing/tokenizing functions by injection — see `EntityContext.nameToken`).
 * `efectivo.ts` needs the very same serialization for the `hallazgo_hash`: two hashes that must both
 * survive an auditor's replay cannot be canonicalized two different ways.
 */
export function canonicalHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

/** sha256 of the canonicalized (sorted-key) ruleset — lets a stored score be reproduced/replayed. */
export function rulesetHash(resolved: object): string {
  return canonicalHash(resolved);
}
