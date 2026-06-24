/**
 * Declarative, versioned ruleset for the risk engine.
 *
 * D2 / D4 decision note: thresholds and the semáforo→bucket mapping are pending
 * client confirmation. This implements the **PRD-body** interpretation:
 *   - consignatario umbral: ≥3 (not >1 as in the spreadsheet)
 *   - importacionesMes umbral: ≥4, i.e. the Ficha 124 ">3 operaciones por
 *     consignatario al mes" trigger — the `bbdd` signal fires on the 4th monthly
 *     operation (prior manifests + current), not on the first repeat.
 *   - bucket mapping: aprobados=verde, noIdentificados=amarillo, validarEnPrevio=rojo
 *   - severity: prohibidos/pirateria hit forces rojo regardless of count
 *
 * If the client confirms the spreadsheet interpretation instead, change only
 * `thresholds.consignatario` to 2 and remove the severity-override block in
 * classify.ts — no other code changes needed.
 *
 * F14: fuzzy entity resolution (version 2026-07b).
 *   - fuzzyEntityResolution: admin-reversible flag (default true). Set to false to
 *     revert to exact-name matching (removes F14 typo clustering entirely).
 *   - fuzzyNameMaxDistance: maximum Damerau-Levenshtein distance for name merging.
 *     Default 2. Setting to 0 disables distance-based merging (phonetic blocking only).
 *     PREFER lower values — a missed typo is less harmful than over-flagging
 *     legitimate distinct people.
 */
export const RULESET = {
  version: '2026-07b',
  thresholds: {
    cantidad: 10,
    montoMin: 1,
    montoMax: 2500,
    consignatario: 3,
    direccion: 2,
    importacionesMes: 4,
    /** Distinct consignees per address (smurfing signal) */
    addressDistinctConsignees: 3,
    /**
     * F14: maximum Damerau-Levenshtein edit distance for fuzzy name clustering.
     * Default 2. Admin-tunable (lower = fewer false merges, higher = catches more typos).
     * PREFER lower values. Set to 0 for phonetic-blocking-only (no distance merge).
     */
    fuzzyNameMaxDistance: 2,
    /**
     * F14: enable/disable fuzzy entity resolution for ID-less consignees.
     * Default true. Set to false to revert to exact-name matching (F14 off).
     * Admin-reversible for audit traceability.
     */
    fuzzyEntityResolution: true as boolean,
  },
  /** Per-signal point weights; calibrated in Task 7 so the 501-row fixture lands rojo ~5-10%.
   * F13 adds `agregado` (weight 30) for cross-row entity aggregation. Weight is higher than
   * `monto` (20) because a genuine split-shipment pair (2×$2,499 → total $4,998, excess≈1.0)
   * must land in amarillo on its own — weight 20 produced a score of ~8.4 with maxPoints=238,
   * which fell below amarillo=10 and forced the cutoff down to 8 (sweeping ~40% of all rows).
   * Weight 30 → maxPoints=248 → split score = 30/248×100 ≈ 12.1, safely in amarillo [10,15).
   * F18 adds `denied_party` (weight 100) for OFAC/BIS/EU/UN sanctions screening. The weight
   * dominates so any match scores rojo even without forcesBand; forcesBand:'rojo' is also set
   * as a belt-and-suspenders guarantee. The golden 501-row fixture has NO sanctioned parties,
   * so adding this weight DOES change maxPoints (248 → 348) but does NOT change distribution. */
  weights: {
    id: 25,
    cantidad: 15,
    monto: 20,
    /** F13: split-shipment aggregate cap. Weight 30 ensures a 2×$2,499 split lands amarillo
     * (score ≈ 12.1) without forcing the amarillo band cutoff below 10. */
    agregado: 30,
    direcciones: 20,
    prohibidos: 60,
    pirateria: 60,
    bbdd: 18,
    /** F18: denied-party / sanctions screening (OFAC/BIS/EU/UN). Dominating weight (100) +
     * forcesBand:'rojo' guarantees any match is rojo regardless of other signals. */
    denied_party: 100,
  },
  /** Score bands: [0, amarillo) = verde, [amarillo, rojo) = amarillo, [rojo, 100] = rojo.
   * Calibrated in Task 7: with the 501-row golden fixture these thresholds produced
   * rojo ≈ 6.6% and verde ≈ 87% — inside the 3–12% / >40% targets.
   * F13 recalibration: adding agregado (weight 30) raises maxPoints 218 → 248, which
   * compresses all scores by ~12%. rojo lowered 17 → 15 (only change needed) to restore
   * the 3–12% rojo% target with the higher maxPoints. amarillo stays at 10 — agregado fires
   * on ZERO golden rows, so the cutoff does not need adjustment; the split score (≈12.1)
   * lands in amarillo naturally with the higher weight.
   * Post-F13 501-row distribution (bands {amarillo:10,rojo:15}): verde≈87%, amarillo≈6%,
   * rojo≈6.8% — within all targets (3–12% rojo, >40% verde).
   * F18 recalibration: adding denied_party (weight 100) raises maxPoints 248 → 348, which
   * compresses all scores by ~29%. Bands adjusted proportionally to restore the golden
   * distribution. denied_party fires on ZERO golden rows (no sanctioned parties in fixture),
   * so the band change is purely a proportional compression correction:
   *   amarillo: 10 → 7  (raw-pts threshold 24.8 → 24.8/348*100 ≈ 7.1, rounded to 7)
   *   rojo:     15 → 11 (raw-pts threshold 37.2 → 37.2/348*100 ≈ 10.7, rounded to 11)
   * Post-F18 501-row distribution (bands {amarillo:7,rojo:11}): expected rojo≈6-7%, verde>80%. */
  bands: { amarillo: 7, rojo: 11 },
} as const;

export type Thresholds = {
  cantidad: number;
  montoMin: number;
  montoMax: number;
  consignatario: number;
  direccion: number;
  importacionesMes: number;
  addressDistinctConsignees: number;
  /** F14: max Damerau-Levenshtein distance for fuzzy name clustering (default 2). */
  fuzzyNameMaxDistance: number;
  /** F14: enable/disable fuzzy entity resolution (default true). Admin-reversible. */
  fuzzyEntityResolution: boolean;
};

/**
 * Merge admin-configurable overrides (D4 / RF-24, from the `validation_params` config key)
 * over the built-in defaults. Only finite, non-negative numbers are accepted for numeric
 * fields; boolean fields accept true/false directly. Malformed values fall back to defaults
 * so a misconfigured catalog can never silently weaken the engine.
 *
 * F14: fuzzyEntityResolution (boolean) and fuzzyNameMaxDistance (number) are both included.
 * Set fuzzyEntityResolution=false to disable typo clustering entirely (admin-reversible).
 */
export function resolveThresholds(overrides?: Partial<Record<keyof Thresholds, unknown>>): Thresholds {
  const base: Thresholds = { ...RULESET.thresholds };
  if (!overrides) return base;
  for (const key of Object.keys(base) as (keyof Thresholds)[]) {
    const v = overrides[key];
    if (key === 'fuzzyEntityResolution') {
      if (typeof v === 'boolean') (base as Record<string, unknown>)[key] = v;
    } else {
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) (base as Record<string, unknown>)[key] = v;
    }
  }
  return base;
}

/**
 * Per-signal point weights.
 * Note: `consignatarios` is NOT in Weights — it is subsumed into the `bbdd` (Ficha-124)
 * recurrence signal in Task 5. `direcciones` is the smurfing signal (distinct consignees
 * per address). `agregado` (F13) is the cross-row split-shipment aggregate cap.
 * `denied_party` (F18) is the OFAC/BIS/EU/UN sanctions screening signal.
 */
export type Weights = Record<
  'id' | 'cantidad' | 'monto' | 'agregado' | 'direcciones' | 'prohibidos' | 'pirateria' | 'bbdd' | 'denied_party',
  number
>;

/** Score band cutoffs in the 0–100 range. */
export type Bands = { amarillo: number; rojo: number };

/**
 * Merge admin-configurable weight overrides over the built-in defaults.
 * Non-positive and non-finite values are rejected (config floors) so a misconfigured
 * catalog can never disable a signal; a weight of zero would silently drop the signal.
 */
export function resolveWeights(overrides?: Partial<Record<keyof Weights, unknown>>): Weights {
  const base: Weights = { ...RULESET.weights };
  if (!overrides) return base;
  for (const k of Object.keys(base) as (keyof Weights)[]) {
    const v = overrides[k];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) base[k] = v;
  }
  return base;
}

/**
 * Merge admin-configurable band overrides over the built-in defaults.
 * Values outside [0, 100] are rejected, and inverted bands (rojo <= amarillo)
 * cause a full fallback to the defaults.
 */
export function resolveBands(overrides?: Partial<Record<keyof Bands, unknown>>): Bands {
  const base: Bands = { ...RULESET.bands };
  if (!overrides) return base;
  const next: Bands = { ...base };
  for (const k of ['amarillo', 'rojo'] as (keyof Bands)[]) {
    const v = overrides[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100) next[k] = v;
  }
  if (next.rojo <= next.amarillo) return base; // inverted -> reject all
  return next;
}

/** Returns the maximum possible raw score for the given weights (sum of all values). */
export function maxPoints(w: Weights): number {
  return Object.values(w).reduce((a, b) => a + b, 0);
}
