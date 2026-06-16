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
// Core Shipment Entity — Individual package within a courier manifest
// ============================================================================

export type TransportMode = 'AIR' | 'LAND';

export type ShipmentStatus =
  | 'PENDING'
  | 'VALID'
  | 'EXCEEDS_THRESHOLD'
  | 'RRNA_BLOCKED'
  | 'FRACTIONAL_FLAG'
  | 'ZERO_VALUE_BLOCKED'
  | 'GENERIC_DESC_BLOCKED';

export interface T1Shipment {
  id: string;                    // Stable UUID
  guideId: string;               // Individual airway bill / tracking number
  mawbReference: string;         // Master airway bill
  consigneeName: string;
  consigneeRfc: string;          // Required in observation field at partida level
  consigneeAddress?: string;
  description: string;
  declaredValueUsd: number;      // Must be ≤ $2,500 per RGCE Rule 3.7.5
  quantity: number;
  unit: 'PCE' | 'KGM' | 'LTR' | 'SET' | string;
  weightKg: number;
  originCountry: string;         // ISO alpha-2 or alpha-3
  transportMode: TransportMode;
  status: ShipmentStatus;
  genericHsCode?: string;        // 9901.00.01 / 9901.00.02 / 9901.00.05
  rrnaFlags: RRNACategory[];
  taxBreakdown?: TaxBreakdown;
}

// ============================================================================
// Tax Calculation — Global Rate Model (Rule 3.7.35)
// ============================================================================

export type TaxRate = 0 | 0.19 | 0.335;

export interface TaxBreakdown {
  baseValueUsd: number;
  baseValueMxn: number;          // Using SAT daily exchange rate
  applicableRate: TaxRate;       // 0% = de minimis, 19% = USMCA, 33.5% = standard
  igi: number;                   // General Import Tax portion
  iva: number;                   // Value Added Tax portion
  dta: number;                   // Customs Processing Fee portion
  total: number;                 // Total liquidation in MXN
  originCountry: string;
  usmcaEligible: boolean;
}

// ============================================================================
// Pedimento Global T1 Structure
// ============================================================================

export interface T1Partida {
  secuencia: number;
  genericHsCode: string;         // Must start with 9901
  description: string;
  quantity: number;
  unit: string;
  valueUsd: number;
  consigneeName: string;
  consigneeRfc: string;
  observation: string;           // Format: "EM1|${consigneeName}|RFC:${consigneeRfc}"
}

export interface SAAIRecord500 {
  patent: string;                // Agente Aduanal patent
  pedimento: string;             // 15-digit pedimento number
  clave: 'T1';                   // Fixed
  aduanaSeccion: string;         // e.g., "47-0" for AICM
  regimen: 'IMD';                // Importación Definitiva
  destino: '9';                  // Interior del País
  genericRfc: string;            // EDM930614781
  fecha: string;                 // YYYYMMDD
  paisOrigen: string;
  transporte: string;
}

export interface SAAIRecord505 {
  secuencia: number;
  factura: number;
  valorUsd: number;
  moneda: 'USD' | 'MXN';
}

export interface T1PedimentoGlobal {
  clave: 'T1';
  emIdentifier: string;          // Courier company authorization key
  mjComplement: boolean;         // true = exempt from IGI/IVA (all partidas ≤$50)
  genericRfc: 'EDM930614781';    // Government-assigned generic RFC
  agenteAduanal: string;
  numeroPedimento: string;
  aduanaSeccion: string;
  fecha: string;
  record500: SAAIRecord500;
  partidas: T1Partida[];
}

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

export interface T1Violation {
  ruleId: string;
  shipmentId: string;
  message: string;
  severity: RuleSeverity;
}

export interface T1ComplianceResult {
  rules: T1ComplianceRule[];
  violations: T1Violation[];
  canProceed: boolean;           // false if any BLOCKING violation exists
  summary: {
    total: number;
    passed: number;
    failed: number;
    blocking: number;
    warning: number;
  };
}

// ============================================================================
// Prevalidador — SAAI M3 Validation
// ============================================================================

export interface PrevalidationResult {
  status: 'APPROVED' | 'REJECTED';
  errors: string[];
  warnings: string[];
  vistoBueno?: string;           // Digital approval seal
}

// ============================================================================
// Manifest State
// ============================================================================

export interface ManifestState {
  shipments: T1Shipment[];
  mawbReference: string;
  transportMode: TransportMode;
  fileName?: string;
  uploadDate?: string;
}

export interface PedimentoState {
  pedimento?: T1PedimentoGlobal;
  prevalidation?: PrevalidationResult;
  isGenerating: boolean;
}

export type RRNAMode = 'STRICT' | 'NORMAL' | 'RELAXED';

export interface TaxState {
  exchangeRate: number;          // SAT daily rate (e.g., 17.85)
  globalTotals: {
    totalBaseUsd: number;
    totalBaseMxn: number;
    totalIgi: number;
    totalIva: number;
    totalDta: number;
    totalLiquidacion: number;
  };
}

// ============================================================================
// App-level T1 Context State
// ============================================================================

export interface T1AppState {
  manifest: ManifestState;
  pedimento: PedimentoState;
  compliance: T1ComplianceResult | null;
  tax: TaxState;
  userRole: 'capturista' | 'admin' | 'autoridad';
  satOnline: boolean;
  satLatency: number;
  rrnaMode: RRNAMode;
}

export type T1Action =
  | { type: 'UPLOAD_MANIFEST'; payload: { shipments: T1Shipment[]; fileName: string; mawbReference: string } }
  | { type: 'CLEAR_MANIFEST' }
  | { type: 'RUN_COMPLIANCE' }
  | { type: 'GENERATE_PEDIMENTO'; payload: { emIdentifier: string; agenteAduanal: string; numeroPedimento: string; aduanaSeccion: string } }
  | { type: 'PREVALIDATE_PEDIMENTO' }
  | { type: 'SET_EXCHANGE_RATE'; payload: number }
  | { type: 'SET_USER_ROLE'; payload: 'capturista' | 'admin' | 'autoridad' }
  | { type: 'TOGGLE_SAT_ONLINE' }
  | { type: 'SET_SAT_LATENCY'; payload: number }
  | { type: 'UPDATE_SHIPMENT_STATUS'; payload: { id: string; status: ShipmentStatus } }
  | { type: 'REMOVE_SHIPMENT'; payload: string }
  | { type: 'SET_RRNA_MODE'; payload: RRNAMode }
  | { type: 'LOAD_DEMO_DATA'; payload: { shipments: T1Shipment[]; mawbReference: string } }
  | { type: 'HYDRATE_STATE'; payload: T1AppState };
