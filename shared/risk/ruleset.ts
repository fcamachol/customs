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
  },
} as const;

export type Thresholds = {
  cantidad: number;
  montoMin: number;
  montoMax: number;
  consignatario: number;
  direccion: number;
  importacionesMes: number;
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
