// shared/risk/hash.test.ts
import { describe, expect, it } from 'vitest';
import { rulesetHash } from './hash';
import { scoreManifest } from './classify';
import type { DeniedPartyEntry } from './lists';
import type { Shipment } from '../types/shipment';

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

// F18: rulesetHash must change when the denied_parties list changes (replay integrity)
describe('rulesetHash — denied_parties replay integrity (F18)', () => {
  function makeShip(): Shipment {
    return {
      id: 'test', mawbReference: 'M', description: 'camisa',
      hsCode: '9901000100', quantity: 1, unit: 'PCE', customsValueUsd: 100, currency: 'USD',
      originCountry: 'CN', guideId: 'g',
      consignee: { name: 'Ana Garcia', rfc: 'PERJ800101AA8', address: 'Calle 1' },
      sender: { name: 'Sender Co' }, platform: { commercialName: 'P' },
    } as Shipment;
  }

  const sampleList: DeniedPartyEntry[] = [
    { name: 'Ivan Petrov', source: 'OFAC', program: 'UKRAINE-EO13685' },
  ];

  it('hash is stable when denied_parties list is unchanged', () => {
    const [a] = scoreManifest([makeShip()], {}, { deniedParties: sampleList });
    const [b] = scoreManifest([makeShip()], {}, { deniedParties: sampleList });
    expect(a.ruleset_hash).toBe(b.ruleset_hash);
  });

  it('hash changes when denied_parties list changes (list update invalidates stored score)', () => {
    const [withList] = scoreManifest([makeShip()], {}, { deniedParties: sampleList });
    const [withoutList] = scoreManifest([makeShip()], {}, { deniedParties: undefined });
    expect(withList.ruleset_hash).not.toBe(withoutList.ruleset_hash);
  });

  it('hash changes when an entry is added to the denied_parties list', () => {
    const list1: DeniedPartyEntry[] = [{ name: 'Ivan Petrov', source: 'OFAC' }];
    const list2: DeniedPartyEntry[] = [
      { name: 'Ivan Petrov', source: 'OFAC' },
      { name: 'New Sanctioned Entity', source: 'BIS' },
    ];
    const [s1] = scoreManifest([makeShip()], {}, { deniedParties: list1 });
    const [s2] = scoreManifest([makeShip()], {}, { deniedParties: list2 });
    expect(s1.ruleset_hash).not.toBe(s2.ruleset_hash);
  });
});
