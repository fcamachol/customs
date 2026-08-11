import type { Shipment } from '../types/shipment';
import { gradeSignals, entityKey, norm, type ReasonCode, type EntityContext } from './signals';
import { scoreRow, type Band } from './scorecard';
import { RULESET, resolveThresholds, resolveWeights, resolveBands, type Thresholds, type Weights, type Bands } from './ruleset';
import { rulesetHash } from './hash';
import type { DeniedPartyEntry } from './lists';
import { resolveNameClusters } from './nameMatch';
import { cleanId } from '../parsing/taxId';

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
  /**
   * Whether the row lacked description, customs value or RFC/CURP — the input that made `scoreRow`
   * answer `gris`. It was computed here and thrown away; it is surfaced (and, by the server,
   * persisted as `shipments.risk_insufficient_data`) because the effective-colour layer has to
   * re-run `scoreRow` later, when suppressing a forced-rojo finding. Without it, removing the flag
   * from an incomplete row would answer `verde` ("all in order") instead of `gris` ("could not be
   * evaluated") — turning missing data into an approval.
   */
  insufficientData: boolean;
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
  /**
   * F20b: Optional name-dedup tokenizer. Receives `norm(name)` (already normalized)
   * and returns an opaque dedup token (e.g. HMAC blind index from blindIndex.ts).
   *
   * When absent, defaults to identity — all existing behavior is EXACTLY preserved.
   * The server injects `rawBlindIndex` so PII normalized names are never stored
   * as plain keys; shared/risk code stays crypto-free (Node `crypto` not imported here).
   *
   * Collision structure is preserved: norm(a) === norm(b) → tokenFn(norm(a)) === tokenFn(norm(b)).
   */
  nameTokenFn?: (normalizedName: string) => string;
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

  // F20b/F20c: name-dedup tokenizer (injected; defaults to identity when absent).
  // The server passes rawBlindIndex here so dedup keys are HMAC tokens, not plaintext.
  // shared/risk stays crypto-free: we receive the fn, never import Node crypto.
  const nameTokenFn = options?.nameTokenFn;

  // F14: fuzzy entity resolution — build name cluster map for ID-less consignees.
  //
  // ONLY names from consignees with NO valid RFC/CURP are included in the fuzzy cluster.
  // RFC/CURP holders use their ID as the authoritative entityKey and are NOT fuzzily merged.
  //
  // cluster: Map<norm(name), canonical_norm_name> — canonical is lex-minimum in cluster.
  // ADDITIVE/monotone: fuzzy only INCREASES recurrence counts, never decreases.
  //
  // fuzzyEntityResolution flag (from RULESET.thresholds, admin-reversible) controls
  // whether clustering is applied. Default: true (on). Set to false to revert to exact
  // matching (useful if false-positive rate is too high in production).
  const fuzzyEnabled = thresholds.fuzzyEntityResolution !== false;
  const idLessNames: string[] = [];
  if (fuzzyEnabled) {
    for (const s of shipments) {
      const idRaw = cleanId(s.consignee.curp ?? s.consignee.rfc ?? '');
      if (!idRaw) {
        idLessNames.push(norm(s.consignee.name));
      }
    }
  }
  const nameCluster: Map<string, string> = fuzzyEnabled
    ? resolveNameClusters(idLessNames, {
        maxDistance: typeof thresholds.fuzzyNameMaxDistance === 'number'
          ? thresholds.fuzzyNameMaxDistance
          : undefined,
      })
    : new Map();
  // nameCanonical: resolve to cluster canonical for ID-less names.
  const nameCanonical = (normName: string): string => nameCluster.get(normName) ?? normName;

  // PASS 1: per-name monthly count (history + current), distinct-entities-per-address,
  // and per-entity aggregate customs value (F13: split-shipment cap).
  //
  // monthlyNameCount is keyed by nameToken(norm(name)) — defaults to norm(name) when
  // no tokenizer is injected (back-compat). The same tokenizer is used for the DB
  // history keys so the key-space is always consistent.
  // Avoid entityKey here: RFC/CURP keys would never match name-keyed history rows.
  //
  // F14: for ID-less consignees, use the cluster canonical as the name key so that
  // typo variants ("Juan Peres", "Juan Perez") are counted as the same entity.
  // RFC/CURP-keyed consignees bypass the fuzzy canonical entirely (RFC/CURP is authoritative).
  const monthlyNameCount: Record<string, number> = { ...monthlyHistoryCounts };
  const addressEntities: Record<string, Set<string>> = {};
  // F13/F20b: aggregate customs value per entity key across manifest rows.
  // entityKey uses the same nameTokenFn for the name-fallback so all keying is consistent.
  const entityValueTotal: Record<string, number> = {};
  for (const s of shipments) {
    const rawNorm = norm(s.consignee.name);
    const idRaw = cleanId(s.consignee.curp ?? s.consignee.rfc ?? '');
    // F14: resolve the cluster canonical for ID-less names so typo variants accumulate
    // to the same counter. ID-keyed consignees use their raw norm directly (unchanged).
    const effectiveNorm = idRaw ? rawNorm : nameCanonical(rawNorm);
    const nameKey = nameTokenFn ? nameTokenFn(effectiveNorm) : effectiveNorm;
    monthlyNameCount[nameKey] = (monthlyNameCount[nameKey] ?? 0) + 1;
    // addressEntities tracks DISTINCT entity identities per address (smurfing check).
    // F14: for ID-less consignees, use the cluster canonical via nameCanonical so that
    // typo variants at the same address are counted as ONE distinct entity.
    // entityKey uses nameTokenFn for name-fallback; RFC/CURP path is unchanged.
    const ek = idRaw
      ? entityKey(s.consignee, nameTokenFn)
      : `name:${nameTokenFn ? nameTokenFn(nameCanonical(rawNorm)) : nameCanonical(rawNorm)}`;
    const a = norm(s.consignee.address ?? '');
    if (a) (addressEntities[a] ??= new Set()).add(ek);
    // F13: accumulate per-entity total value (skip non-finite to avoid NaN pollution)
    entityValueTotal[ek] = (entityValueTotal[ek] ?? 0) + (Number.isFinite(s.customsValueUsd) ? s.customsValueUsd : 0);
  }
  const addressDistinctConsignees: Record<string, number> = {};
  for (const [a, set] of Object.entries(addressEntities)) addressDistinctConsignees[a] = set.size;

  // F14: the EntityContext needs to know the canonical for bbdd key lookup.
  // We pass nameCanonical via a wrapped nameToken: for ID-less consignees the bbdd signal
  // should look up the CANONICAL name key, not the raw normalized name.
  // We wrap nameTokenFn to first apply the fuzzy canonical, then optionally tokenize.
  // This ensures gradeSignals → bbdd uses the same cluster-merged keys as PASS-1 counts.
  //
  // IMPORTANT: RFC/CURP path in gradeSignals is unchanged (uses idRaw directly).
  // The wrapped token fn is ONLY invoked for the bbdd signal's name-key lookup.
  const fuzzyNameToken = (normalizedName: string): string => {
    const canonical = nameCanonical(normalizedName);
    return nameTokenFn ? nameTokenFn(canonical) : canonical;
  };

  const ctx: EntityContext = {
    thresholds,
    weights,
    addressDistinctConsignees,
    monthlyNameCount,
    entityValueTotal,
    piracyBrands: options?.piracyBrands,
    prohibitedKeywords: options?.prohibitedKeywords,
    deniedParties: options?.deniedParties,
    // F14: nameToken = fuzzy-canonical + base tokenizer (for ID-less consignees only).
    // nameTokenBase = base tokenizer only (for ID-keyed consignees — no fuzzy canonical).
    //
    // gradeSignals selects the correct key function per-row:
    //   - ID-keyed rows use nameTokenBase → bbdd key matches their PASS-1 counter exactly.
    //   - ID-less rows use nameToken → bbdd key maps to the cluster-canonical bucket.
    //
    // This guarantees: (a) fuzzy clustering NEVER alters ID-keyed consignees' bbdd counts;
    // (b) typo variants of ID-less consignees DO accumulate to the same bucket.
    nameToken: fuzzyNameToken,
    nameTokenBase: nameTokenFn ?? undefined,
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
      insufficientData,
    };
  });
}
