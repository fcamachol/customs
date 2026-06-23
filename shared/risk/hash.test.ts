// shared/risk/hash.test.ts
import { describe, expect, it } from 'vitest';
import { rulesetHash } from './hash';

describe('rulesetHash', () => {
  it('is stable across key ordering', () => {
    expect(rulesetHash({ a: 1, b: 2 })).toBe(rulesetHash({ b: 2, a: 1 }));
  });
  it('changes when any value changes', () => {
    expect(rulesetHash({ a: 1 })).not.toBe(rulesetHash({ a: 2 }));
  });
  it('returns a 64-char hex sha256', () => {
    expect(rulesetHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});
