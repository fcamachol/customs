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

// La unión vive junto al catálogo que la usa (`shared/rrna/catalogo.ts`). Declararla aquí otra vez
// dejaba dos listas de categorías regulatorias que nadie garantizaba iguales.
export type { RRNACategory } from '../../shared/rrna/catalogo';

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
