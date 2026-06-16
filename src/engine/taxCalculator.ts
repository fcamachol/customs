/**
 * Tax Calculator — Global Rate Engine for T1 Pedimento
 * RGCE Rule 3.7.35: Simplified taxation model (Tasa Global)
 *
 * Post-2025 rates:
 *   - 33.5% standard (Rest of World)
 *   - 19.0% USMCA preferential (USA/Canada, >$117)
 *   - 0% de minimis exemption (≤$50 under treaties)
 */

import { T1Shipment, TaxBreakdown, TaxRate } from '../types/t1';

/** Default SAT exchange rate (can be overridden via configuration) */
export const DEFAULT_EXCHANGE_RATE = 17.85;

/** De minimis threshold (USD) — treaty-dependent, typically $50 */
export const DE_MINIMIS_THRESHOLD = 50;

/** USMCA preferential rate minimum threshold (USD) */
export const USMCA_MINIMUM_THRESHOLD = 117;

/** T1 maximum value threshold (USD) per consignee */
export const T1_MAX_VALUE_USD = 2500;

/** USMCA country codes */
const USMCA_CODES = new Set(['US', 'USA', 'CA', 'CAN', 'UNITED STATES', 'CANADA', 'ESTADOS UNIDOS']);

/**
 * Determine the applicable tax rate based on origin country and declared value.
 */
export function getApplicableRate(
  originCountry: string,
  declaredValueUsd: number
): { rate: TaxRate; usmcaEligible: boolean; reason: string } {
  const normalizedOrigin = originCountry.toUpperCase().trim();

  // De minimis: ≤$50 USD — exempt under treaty
  if (declaredValueUsd <= DE_MINIMIS_THRESHOLD) {
    return {
      rate: 0,
      usmcaEligible: false,
      reason: `De minimis: valor $${declaredValueUsd.toFixed(2)} ≤ $${DE_MINIMIS_THRESHOLD} USD — exento por tratado`,
    };
  }

  // USMCA preferential: USA/Canada origin, >$117 USD
  if (USMCA_CODES.has(normalizedOrigin) && declaredValueUsd > USMCA_MINIMUM_THRESHOLD) {
    return {
      rate: 0.19,
      usmcaEligible: true,
      reason: `USMCA/T-MEC: origen ${normalizedOrigin}, valor $${declaredValueUsd.toFixed(2)} > $${USMCA_MINIMUM_THRESHOLD} USD — tasa preferencial 19%`,
    };
  }

  // USMCA but ≤$117: still de minimis (no preferential rate, but may be exempt)
  if (USMCA_CODES.has(normalizedOrigin) && declaredValueUsd <= USMCA_MINIMUM_THRESHOLD) {
    return {
      rate: 0,
      usmcaEligible: false,
      reason: `USMCA de minimis: origen ${normalizedOrigin}, valor $${declaredValueUsd.toFixed(2)} ≤ $${USMCA_MINIMUM_THRESHOLD} USD — exento`,
    };
  }

  // Standard global rate (Rest of World)
  return {
    rate: 0.335,
    usmcaEligible: false,
    reason: `Tasa global estándar: origen ${normalizedOrigin} — 33.5%`,
  };
}

/**
 * Calculate the full tax breakdown for a single shipment.
 *
 * The 33.5% rate is a composite covering IGI + IVA + DTA.
 * For accounting transparency, we approximate the split:
 *   - IGI: ~55% of total
 *   - IVA: ~35% of total
 *   - DTA: ~10% of total
 */
export function calculateGlobalTax(
  shipment: T1Shipment,
  exchangeRate: number = DEFAULT_EXCHANGE_RATE
): TaxBreakdown {
  const baseMxn = shipment.declaredValueUsd * exchangeRate;
  const { rate, usmcaEligible, reason } = getApplicableRate(
    shipment.originCountry,
    shipment.declaredValueUsd
  );

  const totalTax = baseMxn * rate;

  // Approximate breakdown of the composite rate
  let igi: number, iva: number, dta: number;

  if (rate === 0) {
    igi = 0;
    iva = 0;
    dta = 0;
  } else if (rate === 0.19) {
    // USMCA preferential: different internal split
    igi = totalTax * 0.50;
    iva = totalTax * 0.40;
    dta = totalTax * 0.10;
  } else {
    // Standard 33.5%
    igi = totalTax * 0.55;
    iva = totalTax * 0.35;
    dta = totalTax * 0.10;
  }

  return {
    baseValueUsd: shipment.declaredValueUsd,
    baseValueMxn: baseMxn,
    applicableRate: rate,
    igi: Math.round(igi * 100) / 100,
    iva: Math.round(iva * 100) / 100,
    dta: Math.round(dta * 100) / 100,
    total: Math.round(totalTax * 100) / 100,
    originCountry: shipment.originCountry,
    usmcaEligible,
  };
}

/**
 * Calculate aggregate tax totals for a batch of shipments.
 */
export function calculateBatchTax(
  shipments: T1Shipment[],
  exchangeRate: number = DEFAULT_EXCHANGE_RATE
): {
  totalBaseUsd: number;
  totalBaseMxn: number;
  totalIgi: number;
  totalIva: number;
  totalDta: number;
  totalLiquidacion: number;
  exemptCount: number;
  usmcaCount: number;
  standardCount: number;
} {
  let totalBaseUsd = 0;
  let totalBaseMxn = 0;
  let totalIgi = 0;
  let totalIva = 0;
  let totalDta = 0;
  let totalLiquidacion = 0;
  let exemptCount = 0;
  let usmcaCount = 0;
  let standardCount = 0;

  for (const shipment of shipments) {
    const tax = calculateGlobalTax(shipment, exchangeRate);
    shipment.taxBreakdown = tax;

    totalBaseUsd += tax.baseValueUsd;
    totalBaseMxn += tax.baseValueMxn;
    totalIgi += tax.igi;
    totalIva += tax.iva;
    totalDta += tax.dta;
    totalLiquidacion += tax.total;

    if (tax.applicableRate === 0) exemptCount++;
    else if (tax.usmcaEligible) usmcaCount++;
    else standardCount++;
  }

  return {
    totalBaseUsd: Math.round(totalBaseUsd * 100) / 100,
    totalBaseMxn: Math.round(totalBaseMxn * 100) / 100,
    totalIgi: Math.round(totalIgi * 100) / 100,
    totalIva: Math.round(totalIva * 100) / 100,
    totalDta: Math.round(totalDta * 100) / 100,
    totalLiquidacion: Math.round(totalLiquidacion * 100) / 100,
    exemptCount,
    usmcaCount,
    standardCount,
  };
}
