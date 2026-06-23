/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * T1 Pedimento Type System — Empresas de Mensajería y Paquetería
 * Aligned with RGCE Rules 3.7.3, 3.7.5, 3.7.35 and Anexo 22
 */

// ============================================================================
// RRNA — Regulaciones y Restricciones No Arancelarias
// ============================================================================

export type RRNACategory =
  | 'COFEPRIS_FOOD'              // Food, supplements, vitamins
  | 'COFEPRIS_COSMETICS'         // Cosmetics, perfumes, lotions
  | 'COFEPRIS_MEDICAL'           // Medical devices, orthopedic
  | 'SENASICA_AGRICULTURAL'      // Raw agricultural products
  | 'SEMARNAT_ENVIRONMENTAL'     // Timber, hazardous waste
  | 'CITES_WILDLIFE'             // Endangered species flora/fauna
  | 'SEDENA_WEAPONS'             // Arms, ammunition, explosives, dual-use
  | 'DIFFICULT_IDENTIFICATION'   // Powders, liquids, pills, granules
  | 'ZERO_VALUE'                 // Declared value = 0 (Rule 3.7.3)
  | 'GENERIC_DESCRIPTION';       // "artículos diversos", "regalo", "cortesía"

// ============================================================================
// Compliance Rules — Real RGCE Rules
// ============================================================================

export type RuleSeverity = 'BLOCKING' | 'WARNING' | 'INFO';
export type RuleStatus = 'PENDING' | 'PASSED' | 'FAILED';

export interface T1ComplianceRule {
  id: string;                    // e.g., 'RGCE-3.7.3-A'
  rgceReference: string;         // '3.7.3', '3.7.5', '3.7.35'
  title: string;
  description: string;
  severity: RuleSeverity;
  status: RuleStatus;
  detail?: string;
  affectedShipmentIds?: string[];
}

// Canonical model now lives in shared/. Re-export for existing imports.
export * from '../../shared/types/shipment';
