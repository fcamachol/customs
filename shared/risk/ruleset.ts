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
 */
export const RULESET = {
  version: '2026-06',
  thresholds: {
    cantidad: 10,
    montoMin: 1,
    montoMax: 2500,
    consignatario: 3,
    direccion: 2,
    importacionesMes: 4,
    /** Distinct consignees per address (smurfing signal) */
    addressDistinctConsignees: 3,
  },
  /** Per-signal point weights; calibrated in Task 7 so the 501-row fixture lands rojo ~5-10% */
  weights: {
    id: 25,
    cantidad: 15,
    monto: 20,
    direcciones: 20,
    prohibidos: 60,
    pirateria: 60,
    bbdd: 18,
  },
  /** Score bands: [0, amarillo) = verde, [amarillo, rojo) = amarillo, [rojo, 100] = rojo */
  bands: { amarillo: 15, rojo: 45 },
} as const;

export type Thresholds = {
  cantidad: number;
  montoMin: number;
  montoMax: number;
  consignatario: number;
  direccion: number;
  importacionesMes: number;
  addressDistinctConsignees: number;
};

/**
 * Merge admin-configurable overrides (D4 / RF-24, from the `validation_params` config key)
 * over the built-in defaults. Only finite, non-negative numbers are accepted; anything else
 * falls back to the default so a malformed catalog can never weaken the engine silently.
 */
export function resolveThresholds(overrides?: Partial<Record<keyof Thresholds, unknown>>): Thresholds {
  const base: Thresholds = { ...RULESET.thresholds };
  if (!overrides) return base;
  for (const key of Object.keys(base) as (keyof Thresholds)[]) {
    const v = overrides[key];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) base[key] = v;
  }
  return base;
}

/**
 * Per-signal point weights.
 * Note: `consignatarios` is NOT in Weights — it is subsumed into the `bbdd` (Ficha-124)
 * recurrence signal in Task 5. `direcciones` is the smurfing signal (distinct consignees
 * per address).
 */
export type Weights = Record<
  'id' | 'cantidad' | 'monto' | 'direcciones' | 'prohibidos' | 'pirateria' | 'bbdd',
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
