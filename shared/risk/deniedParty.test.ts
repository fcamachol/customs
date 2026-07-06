// shared/risk/deniedParty.test.ts — F18: denied-party signal tests
import { describe, expect, it } from 'vitest';
import { matchesDeniedParty, type DeniedPartyEntry } from './lists';
import { gradeSignals } from './signals';
import { scoreManifest } from './classify';
import { RULESET } from './ruleset';
import type { Shipment } from '../types/shipment';

// ─── Test helpers ─────────────────────────────────────────────────────────────

function ship(over: Partial<Shipment> = {}): Shipment {
  return {
    id: Math.random().toString(), mawbReference: 'M', description: 'camisa',
    hsCode: '9901000100', quantity: 1, unit: 'PCE', customsValueUsd: 100, currency: 'USD',
    originCountry: 'CN', guideId: 'g',
    consignee: { name: 'Ana Garcia', rfc: 'PERJ800101AA8', address: 'Calle 1' },
    sender: { name: 'Sender Co' },
    platform: { commercialName: 'P' },
    ...over,
  } as Shipment;
}

const ctx = (over = {}) => ({
  thresholds: RULESET.thresholds,
  weights: RULESET.weights,
  addressDistinctConsignees: {},
  monthlyNameCount: {},
  ...over,
});

const OFAC_LIST: DeniedPartyEntry[] = [
  { name: 'Ivan Petrov', source: 'OFAC', program: 'UKRAINE-EO13685' },
  { name: 'Drug Cartel Exports SA de CV', ids: ['DREX800101AB5'], source: 'OFAC', program: 'SDNTK' },
  { name: 'Comercial Fantasma', source: 'OFAC', ids: ['CFAN920501XY3'] },
];

// ─── matchesDeniedParty unit tests ───────────────────────────────────────────

describe('matchesDeniedParty', () => {
  it('returns null for empty list', () => {
    expect(matchesDeniedParty({ names: ['Ivan Petrov'], ids: [] }, [])).toBeNull();
  });

  it('returns null for undefined list', () => {
    expect(matchesDeniedParty({ names: ['Ivan Petrov'], ids: [] }, undefined)).toBeNull();
  });

  it('matches on consignee name (normalized, token-based)', () => {
    const result = matchesDeniedParty({ names: ['Ivan Petrov'], ids: [] }, OFAC_LIST);
    expect(result).not.toBeNull();
    expect(result?.matched).toBe('Ivan Petrov');
    expect(result?.source).toBe('OFAC');
    expect(result?.program).toBe('UKRAINE-EO13685');
  });

  it('matches name case-insensitively', () => {
    const result = matchesDeniedParty({ names: ['IVAN PETROV'], ids: [] }, OFAC_LIST);
    expect(result).not.toBeNull();
    expect(result?.matched).toBe('Ivan Petrov');
  });

  it('matches name ignoring diacritics (NFD normalization)', () => {
    // Entry: "Ivan Petrov" — query with accented variant
    const listWithAccent: DeniedPartyEntry[] = [
      { name: 'Iván Pétrov', source: 'OFAC' },
    ];
    const result = matchesDeniedParty({ names: ['ivan petrov'], ids: [] }, listWithAccent);
    expect(result).not.toBeNull();
  });

  it('matches exact ID (RFC/CURP) regardless of case/spaces', () => {
    const result = matchesDeniedParty(
      { names: ['Completely Different Name'], ids: ['DREX800101AB5'] },
      OFAC_LIST,
    );
    expect(result).not.toBeNull();
    expect(result?.matched).toBe('Drug Cartel Exports SA de CV');
  });

  it('matches exact ID case-insensitively', () => {
    const result = matchesDeniedParty(
      { names: [], ids: ['drex800101ab5'] },
      OFAC_LIST,
    );
    expect(result).not.toBeNull();
  });

  it('returns null for a clean shipment with no match', () => {
    const result = matchesDeniedParty(
      { names: ['Ana Garcia', 'Sender Co'], ids: ['PERJ800101AA8'] },
      OFAC_LIST,
    );
    expect(result).toBeNull();
  });

  it('does NOT match very short name tokens (length < 3) to prevent false positives', () => {
    // Entry with single-char name — should not match
    const list: DeniedPartyEntry[] = [{ name: 'AB', source: 'OFAC' }];
    const result = matchesDeniedParty({ names: ['AB anything'], ids: [] }, list);
    expect(result).toBeNull();
  });

  it('matches sender name as well as consignee name', () => {
    const result = matchesDeniedParty(
      { names: ['Clean Consignee', 'Ivan Petrov'], ids: [] },
      OFAC_LIST,
    );
    expect(result).not.toBeNull();
    expect(result?.matched).toBe('Ivan Petrov');
  });

  it('ID match wins over name non-match (returns match on ID even when name differs)', () => {
    const result = matchesDeniedParty(
      { names: ['Totally Clean Name'], ids: ['CFAN920501XY3'] },
      OFAC_LIST,
    );
    expect(result).not.toBeNull();
    expect(result?.matched).toBe('Comercial Fantasma');
  });

  it('matches homoglyph-obfuscated candidate (Cyrillic а) against a Latin entry', () => {
    // 'Ivаn' = "Ivаn" with Cyrillic а (U+0430), visually identical to Latin a
    const result = matchesDeniedParty({ names: ['Ivаn Petrov'], ids: [] }, OFAC_LIST);
    expect(result).not.toBeNull();
    expect(result?.matched).toBe('Ivan Petrov');
  });

  it('matches a Latin candidate against a homoglyph-obfuscated entry name', () => {
    // Entry uses Cyrillic а (U+0430) and Cyrillic о (U+043E)
    const list: DeniedPartyEntry[] = [{ name: 'Ivаn Petrоv', source: 'OFAC' }];
    expect(matchesDeniedParty({ names: ['ivan petrov'], ids: [] }, list)).not.toBeNull();
  });
});

// ─── gradeSignals — denied_party signal ──────────────────────────────────────

describe('gradeSignals denied_party signal', () => {
  it('fires denied_party with forcesBand=rojo when consignee name matches OFAC list', () => {
    const s = ship({ consignee: { name: 'Ivan Petrov', rfc: 'PERJ800101AA8', address: 'x' } });
    const codes = gradeSignals(s, ctx({ deniedParties: OFAC_LIST }));
    const dp = codes.find((c) => c.signalId === 'denied_party');
    expect(dp).toBeDefined();
    expect(dp!.forcesBand).toBe('rojo');
    expect(dp!.points).toBe(RULESET.weights.denied_party);
    expect(dp!.evidence).toMatchObject({ matched: 'Ivan Petrov', source: 'OFAC' });
  });

  it('fires denied_party when RFC matches OFAC list', () => {
    const s = ship({ consignee: { name: 'Completely Clean Name', rfc: 'DREX800101AB5', address: 'x' } });
    const codes = gradeSignals(s, ctx({ deniedParties: OFAC_LIST }));
    const dp = codes.find((c) => c.signalId === 'denied_party');
    expect(dp).toBeDefined();
    expect(dp!.forcesBand).toBe('rojo');
  });

  it('does NOT fire denied_party for clean consignee when list is populated', () => {
    const s = ship({ consignee: { name: 'Ana Garcia', rfc: 'PERJ800101AA8', address: 'Calle 1' } });
    const codes = gradeSignals(s, ctx({ deniedParties: OFAC_LIST }));
    expect(codes.find((c) => c.signalId === 'denied_party')).toBeUndefined();
  });

  it('does NOT fire denied_party when no list is provided (undefined)', () => {
    const s = ship({ consignee: { name: 'Ivan Petrov', rfc: 'PERJ800101AA8', address: 'x' } });
    const codes = gradeSignals(s, ctx({ deniedParties: undefined }));
    expect(codes.find((c) => c.signalId === 'denied_party')).toBeUndefined();
  });

  it('does NOT fire denied_party when list is empty', () => {
    const s = ship({ consignee: { name: 'Ivan Petrov', rfc: 'PERJ800101AA8', address: 'x' } });
    const codes = gradeSignals(s, ctx({ deniedParties: [] }));
    expect(codes.find((c) => c.signalId === 'denied_party')).toBeUndefined();
  });
});

// ─── scoreManifest — end-to-end test ─────────────────────────────────────────

describe('scoreManifest denied_party → rojo', () => {
  it('sanctioned party forces rojo even with all other signals clean', () => {
    const s = ship({ consignee: { name: 'Ivan Petrov', rfc: 'PERJ800101AA8', address: 'Calle 1' } });
    const out = scoreManifest([s], {}, { deniedParties: OFAC_LIST });
    expect(out[0].band).toBe('rojo');
    expect(out[0].color).toBe('rojo');
    // The detail message should reference the sanctions list
    expect(out[0].incidences.some((i) => i.includes('sancionados'))).toBe(true);
  });

  it('clean shipment stays verde even when sanctions list is populated', () => {
    const s = ship({ consignee: { name: 'Ana Garcia', rfc: 'PERJ800101AA8', address: 'Calle 1' } });
    const out = scoreManifest([s], {}, { deniedParties: OFAC_LIST });
    expect(out[0].band).toBe('verde');
    expect(out[0].reasons.find((r) => r.signalId === 'denied_party')).toBeUndefined();
  });

  it('denied_party fires alongside other signals (stacking)', () => {
    // Sanctioned + prohibited keyword — both signals fire, denied_party forces rojo
    const s = ship({
      consignee: { name: 'Ivan Petrov', rfc: 'PERJ800101AA8', address: 'Calle 1' },
      description: 'pastilla de droga',
    });
    const out = scoreManifest([s], {}, { deniedParties: OFAC_LIST });
    expect(out[0].band).toBe('rojo');
    const signalIds = out[0].reasons.map((r) => r.signalId);
    expect(signalIds).toContain('denied_party');
    expect(signalIds).toContain('prohibidos');
  });
  it('sanctioned consignee WITHOUT RFC/CURP still forces rojo (not gris)', () => {
    const s = ship({ consignee: { name: 'Ivan Petrov', address: 'Calle 1' } });
    const out = scoreManifest([s], {}, { deniedParties: OFAC_LIST });
    expect(out[0].band).toBe('rojo');
    expect(out[0].color).toBe('rojo');
  });
});
