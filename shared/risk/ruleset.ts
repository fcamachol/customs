/**
 * Declarative, versioned ruleset for the risk engine.
 *
 * D2 / D4 decision note: thresholds and the semáforo→bucket mapping are pending
 * client confirmation. This implements the **PRD-body** interpretation:
 *   - consignatario umbral: ≥3 (not >1 as in the spreadsheet)
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
    importacionesMes: 1,
  },
} as const;
