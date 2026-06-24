import type { Shipment } from '../types/shipment';
import { gradeSignals, entityKey, norm, type ReasonCode, type EntityContext } from './signals';
import { scoreRow, type Band } from './scorecard';
import { RULESET, resolveThresholds, resolveWeights, resolveBands, type Thresholds, type Weights, type Bands } from './ruleset';
import { rulesetHash } from './hash';
import type { DeniedPartyEntry } from './lists';

export type RiskColor = 'verde' | 'amarillo' | 'rojo' | 'gris';

/**
 * Legacy helper kept for consumers that need the old count-based band mapping.
 * Maps a 0–100 score to a RiskColor using the current RULESET bands.
 */
export function classifyScore(score: number): RiskColor {
  if (score < 2) return 'verde';
  if (score <= 3) return 'amarillo';
  return 'rojo';
}

export interface ScoredShipment {
  shipment: Shipment;
  score: number;           // 0–100 weighted
  band: Band;              // 'verde' | 'amarillo' | 'rojo' | 'gris'
  color: RiskColor;        // = band (back-compat alias)
  reasons: ReasonCode[];   // fired signals with points/weight/detail
  incidences: string[];    // derived from reasons (back-compat: reasons.map(r => r.detail))
  ruleset_version: string;
  ruleset_hash: string;
}

export interface ScoreOptions {
  /** Optional override list for piracy brands (falls back to built-in list when omitted) */
  piracyBrands?: string[];
  /** Optional override list for prohibited keywords (falls back to built-in list when omitted) */
  prohibitedKeywords?: string[];
  /**
   * F18: denied-party / sanctions screening list (OFAC/BIS/EU/UN).
   * Loaded from the `denied_parties` config key (see server/src/routes/risk.ts).
   * Included in `resolved.lists` so `rulesetHash` changes when the screening list changes,
   * preserving replay integrity: a stored score can be re-derived from the same list snapshot.
   */
  deniedParties?: DeniedPartyEntry[];
  /** Optional threshold overrides (D4 / RF-24, from the `validation_params` config key) */
  thresholds?: Partial<Record<keyof Thresholds, unknown>>;
  /** Optional weight overrides */
  weights?: Partial<Record<keyof Weights, unknown>>;
  /** Optional band cutoff overrides */
  bands?: Partial<Record<keyof Bands, unknown>>;
}

/**
 * The ruleset version stamped on each scored row. When admin threshold overrides are active,
 * the version is suffixed with `+cfg` so an audited run records that configured (not default)
 * rules applied — keeps O2/O3 traceability intact.
 */
export function rulesetVersionFor(options?: ScoreOptions): string {
  return options?.thresholds || options?.weights ? `${RULESET.version}+cfg` : RULESET.version;
}

export function scoreManifest(
  shipments: Shipment[],
  monthlyHistoryCounts: Record<string, number>,
  options?: ScoreOptions,
): ScoredShipment[] {
  const thresholds = resolveThresholds(options?.thresholds);
  const weights = resolveWeights(options?.weights);
  const bands = resolveBands(options?.bands);

  // PASS 1: per-name monthly count (history + current), distinct-entities-per-address,
  // and per-entity aggregate customs value (F13: split-shipment cap).
  //
  // monthlyNameCount is keyed by norm(consignee.name) to match the name-keyed rows
  // stored in monthly_history (server/src/services/monthlyHistory.ts). Using entityKey
  // here would cause a key-space mismatch: the DB history would be seeded under
  // "juan perez" but the lookup in gradeSignals would use "PERJ800101AA8", so cross-
  // manifest bbdd recurrence would never fire for RFC/CURP-bearing consignees.
  const monthlyNameCount: Record<string, number> = { ...monthlyHistoryCounts };
  const addressEntities: Record<string, Set<string>> = {};
  // F13: aggregate customs value per entity key across manifest rows.
  // TODO(F20): must key on the same tokenized identity when F20 blind-index lands.
  const entityValueTotal: Record<string, number> = {};
  for (const s of shipments) {
    const nameKey = norm(s.consignee.name);
    monthlyNameCount[nameKey] = (monthlyNameCount[nameKey] ?? 0) + 1;
    // addressEntities tracks DISTINCT entity identities per address (smurfing check).
    // entityKey remains correct here: RFC/CURP distinguishes real distinct individuals.
    const ek = entityKey(s.consignee);
    const a = norm(s.consignee.address ?? '');
    if (a) (addressEntities[a] ??= new Set()).add(ek);
    // F13: accumulate per-entity total value (skip non-finite to avoid NaN pollution)
    entityValueTotal[ek] = (entityValueTotal[ek] ?? 0) + (Number.isFinite(s.customsValueUsd) ? s.customsValueUsd : 0);
  }
  const addressDistinctConsignees: Record<string, number> = {};
  for (const [a, set] of Object.entries(addressEntities)) addressDistinctConsignees[a] = set.size;

  const ctx: EntityContext = {
    thresholds,
    weights,
    addressDistinctConsignees,
    monthlyNameCount,
    entityValueTotal,
    piracyBrands: options?.piracyBrands,
    prohibitedKeywords: options?.prohibitedKeywords,
    deniedParties: options?.deniedParties,
  };

  const resolved = {
    version: RULESET.version,
    thresholds,
    weights,
    bands,
    lists: {
      piracyBrands: options?.piracyBrands ?? null,
      prohibitedKeywords: options?.prohibitedKeywords ?? null,
      // F18: denied-party list is included so rulesetHash changes when screening list changes.
      // This ensures replay integrity: a stored hash uniquely identifies the list snapshot used.
      deniedParties: options?.deniedParties ?? null,
    },
  };
  const version = rulesetVersionFor(options);
  const hash = rulesetHash(resolved);

  return shipments.map((s) => {
    const reasons = gradeSignals(s, ctx);
    const insufficientData =
      !s.description?.trim() ||
      !Number.isFinite(s.customsValueUsd) ||
      !(s.consignee.curp ?? s.consignee.rfc ?? '').trim();
    const { score, band } = scoreRow(reasons, { weights, bands, insufficientData });
    return {
      shipment: s,
      score,
      band,
      color: band as RiskColor,
      reasons,
      incidences: reasons.map((r) => r.detail),
      ruleset_version: version,
      ruleset_hash: hash,
    };
  });
}
