import type { Shipment } from '../types/shipment';

/**
 * Generic T1 fraction (8-char) for pedimento model.
 * Under T1 simplified clearance, the declared fraction must be 9901 (general goods)
 * or 9902 (for specific seams), NOT the real product HS code.
 */
export const GENERIC_T1_FRACTION = '99010001';

/**
 * Generic T1 fraction (10-char padded) for SAT layout export column.
 * The layout export expects 10-character fractions.
 */
export const GENERIC_T1_FRACTION_LAYOUT = '9901000100';

/**
 * Regex to validate that a fraction is a generic T1 fraction (9901 or 9902 with 2 trailing digits).
 */
export const GENERIC_FRACTION_RE = /^990[12]00\d{2}$/;

/**
 * Returns the generic T1 fraction to use for a shipment.
 * Currently always returns 9901; this is a seam for future 9902 logic.
 */
export function genericFractionFor(shipment?: Shipment): string {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  (shipment);
  // Default to 9901. In future, could check shipment type and return 9902 if needed.
  return GENERIC_T1_FRACTION;
}
