/**
 * Generic Tariff Codes for T1 Pedimento (Anexo 22)
 * RGCE Rule 3.7.5 — Simplified courier classification by unit of measure
 */

export const GENERIC_HS_CODES = {
  /** Pieces (piezas) — 9901.00.01 */
  PCE: '9901.00.01',
  /** Kilograms — 9901.00.02 */
  KGM: '9901.00.02',
  /** Liters — 9901.00.05 */
  LTR: '9901.00.05',
} as const;

export type GenericHsCode = typeof GENERIC_HS_CODES[keyof typeof GENERIC_HS_CODES];

/** Export-only generic code */
export const GENERIC_HS_EXPORT = '9902.00.01' as const;

/** Map of unit synonyms → canonical generic HS code */
export const UNIT_SYNONYMS: Record<string, string> = {
  // Pieces
  PCE: GENERIC_HS_CODES.PCE,
  PCS: GENERIC_HS_CODES.PCE,
  PIEZA: GENERIC_HS_CODES.PCE,
  PIEZAS: GENERIC_HS_CODES.PCE,
  UNIT: GENERIC_HS_CODES.PCE,
  UNITS: GENERIC_HS_CODES.PCE,
  UND: GENERIC_HS_CODES.PCE,
  UNIDAD: GENERIC_HS_CODES.PCE,
  UNIDADES: GENERIC_HS_CODES.PCE,
  BULTO: GENERIC_HS_CODES.PCE,
  BULTOS: GENERIC_HS_CODES.PCE,
  CAJA: GENERIC_HS_CODES.PCE,
  CAJAS: GENERIC_HS_CODES.PCE,
  SET: GENERIC_HS_CODES.PCE,
  // Kilograms
  KGM: GENERIC_HS_CODES.KGM,
  KG: GENERIC_HS_CODES.KGM,
  KGS: GENERIC_HS_CODES.KGM,
  KILO: GENERIC_HS_CODES.KGM,
  KILOS: GENERIC_HS_CODES.KGM,
  KILOGRAMO: GENERIC_HS_CODES.KGM,
  KILOGRAMOS: GENERIC_HS_CODES.KGM,
  // Liters
  LTR: GENERIC_HS_CODES.LTR,
  LT: GENERIC_HS_CODES.LTR,
  LTS: GENERIC_HS_CODES.LTR,
  LITRO: GENERIC_HS_CODES.LTR,
  LITROS: GENERIC_HS_CODES.LTR,
  LITER: GENERIC_HS_CODES.LTR,
  LITERS: GENERIC_HS_CODES.LTR,
  GAL: GENERIC_HS_CODES.LTR,
  GALON: GENERIC_HS_CODES.LTR,
};

/**
 * Assign a generic HS code based on the unit of measure.
 * Falls back to 9901.00.01 (pieces) for unknown units.
 */
export function assignGenericHsCode(unit: string): string {
  const normalized = unit.toUpperCase().trim();
  return UNIT_SYNONYMS[normalized] || GENERIC_HS_CODES.PCE;
}

/**
 * Get a human-readable label for a generic HS code.
 */
export function getGenericHsLabel(code: string): string {
  switch (code) {
    case GENERIC_HS_CODES.PCE:
      return 'Piezas (9901.00.01)';
    case GENERIC_HS_CODES.KGM:
      return 'Kilogramos (9901.00.02)';
    case GENERIC_HS_CODES.LTR:
      return 'Litros (9901.00.05)';
    case GENERIC_HS_EXPORT:
      return 'Exportación (9902.00.01)';
    default:
      return code;
  }
}
