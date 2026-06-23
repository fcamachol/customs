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

/** sha256 of the canonicalized (sorted-key) ruleset — lets a stored score be reproduced/replayed. */
export function rulesetHash(resolved: object): string {
  return createHash('sha256').update(JSON.stringify(canonical(resolved))).digest('hex');
}
