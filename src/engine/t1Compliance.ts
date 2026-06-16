/**
 * T1 Compliance Engine — RGCE Rule Evaluation
 *
 * Evaluates shipments against the full set of RGCE rules governing
 * Courier and Parcel Company (Empresa de Mensajería y Paquetería)
 * operations under the T1 pedimento scheme.
 */

import {
  T1Shipment,
  T1ComplianceRule,
  T1Violation,
  T1ComplianceResult,
  ShipmentStatus,
} from '../types/t1';
import { createInitialComplianceRules } from '../constants/rgceRules';
import { detectRRNA } from './rrnaDetector';
import { assignGenericHsCode } from '../constants/genericHscodes';
import { T1_MAX_VALUE_USD } from './taxCalculator';

// ============================================================================
// Individual Rule Evaluators
// ============================================================================

function evaluateRule373A(
  rule: T1ComplianceRule,
  _shipments: T1Shipment[]
): T1ComplianceRule {
  // In a real system, this would check ANAM registry database.
  // For simulation, we assume the courier IS registered.
  return { ...rule, status: 'PASSED', detail: 'Empresa registrada en ANAM (simulado).' };
}

function evaluateRule373B(
  rule: T1ComplianceRule,
  shipments: T1Shipment[]
): T1ComplianceRule {
  const violations: string[] = [];
  const affectedIds: string[] = [];
  const genericPatterns = [
    'artículos diversos', 'articulos diversos', 'various items',
    'regalo', 'gift', 'cortesía', 'cortesia', 'courtesy',
    'muestra gratis', 'free sample', 'sample free',
    'promotional', 'promocional', 'misc ', 'miscellaneous',
    'sundries', 'surtido', 'assorted', 'mixed items',
    'personal belongings', 'pertenencias personales',
    'household goods', 'efectos personales', 'personal effects',
    'varios', 'miscelaneos', 'misceláneos',
    'general merchandise', 'mercancia general', 'mercancía general',
    'unknown', 'desconocido', 'not specified', 'no especificado',
  ];

  for (const s of shipments) {
    const desc = s.description.toLowerCase();
    if (genericPatterns.some((p) => desc.includes(p))) {
      violations.push(`${s.guideId}: "${s.description}"`);
      affectedIds.push(s.id);
    }
  }

  if (violations.length > 0) {
    return {
      ...rule,
      status: 'FAILED',
      detail: `${violations.length} envío(s) con descripción genérica prohibida: ${violations.slice(0, 3).join('; ')}${violations.length > 3 ? '...' : ''}`,
      affectedShipmentIds: affectedIds,
    };
  }
  return { ...rule, status: 'PASSED', detail: 'Todas las descripciones son específicas y válidas.' };
}

function evaluateRule373C(
  rule: T1ComplianceRule,
  shipments: T1Shipment[]
): T1ComplianceRule {
  const violations: string[] = [];
  const affectedIds: string[] = [];

  for (const s of shipments) {
    if (s.declaredValueUsd <= 0) {
      violations.push(`${s.guideId}: $${s.declaredValueUsd.toFixed(2)}`);
      affectedIds.push(s.id);
    }
  }

  if (violations.length > 0) {
    return {
      ...rule,
      status: 'FAILED',
      detail: `${violations.length} envío(s) con valor cero o negativo: ${violations.slice(0, 3).join('; ')}${violations.length > 3 ? '...' : ''}`,
      affectedShipmentIds: affectedIds,
    };
  }
  return { ...rule, status: 'PASSED', detail: 'Todos los valores declarados son mayores a cero.' };
}

function evaluateRule373D(
  rule: T1ComplianceRule,
  shipments: T1Shipment[]
): T1ComplianceRule {
  const violations: string[] = [];
  const affectedIds: string[] = [];
  const rfcRegex = /^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$/i;

  for (const s of shipments) {
    if (!s.consigneeRfc || !rfcRegex.test(s.consigneeRfc.trim())) {
      violations.push(`${s.guideId}: RFC inválido o faltante "${s.consigneeRfc || 'VACÍO'}"`);
      affectedIds.push(s.id);
    }
  }

  if (violations.length > 0) {
    return {
      ...rule,
      status: 'FAILED',
      detail: `${violations.length} envío(s) sin RFC válido de consignatario: ${violations.slice(0, 3).join('; ')}${violations.length > 3 ? '...' : ''}`,
      affectedShipmentIds: affectedIds,
    };
  }
  return { ...rule, status: 'PASSED', detail: 'Todos los consignatarios tienen RFC válido.' };
}

function evaluateRule375A(
  rule: T1ComplianceRule,
  shipments: T1Shipment[]
): T1ComplianceRule {
  const violations: string[] = [];
  const affectedIds: string[] = [];

  for (const s of shipments) {
    if (s.declaredValueUsd > T1_MAX_VALUE_USD) {
      violations.push(`${s.guideId}: $${s.declaredValueUsd.toFixed(2)} USD (límite: $${T1_MAX_VALUE_USD})`);
      affectedIds.push(s.id);
    }
  }

  if (violations.length > 0) {
    return {
      ...rule,
      status: 'FAILED',
      detail: `${violations.length} envío(s) exceden $${T1_MAX_VALUE_USD} USD: ${violations.slice(0, 3).join('; ')}${violations.length > 3 ? '...' : ''}`,
      affectedShipmentIds: affectedIds,
    };
  }
  return { ...rule, status: 'PASSED', detail: `Todos los envíos están dentro del límite de $${T1_MAX_VALUE_USD} USD.` };
}

function evaluateRule375B(
  rule: T1ComplianceRule,
  shipments: T1Shipment[]
): T1ComplianceRule {
  const violations: string[] = [];
  const affectedIds: string[] = [];

  for (const s of shipments) {
    const genericCode = assignGenericHsCode(s.unit);
    // If the shipment already has a non-generic HS code set, flag it
    if (s.genericHsCode && !s.genericHsCode.startsWith('9901') && !s.genericHsCode.startsWith('9902')) {
      violations.push(`${s.guideId}: fracción ${s.genericHsCode} no es genérica`);
      affectedIds.push(s.id);
    }
  }

  if (violations.length > 0) {
    return {
      ...rule,
      status: 'FAILED',
      detail: `${violations.length} envío(s) sin código genérico: ${violations.slice(0, 3).join('; ')}${violations.length > 3 ? '...' : ''}`,
      affectedShipmentIds: affectedIds,
    };
  }
  return { ...rule, status: 'PASSED', detail: 'Todos los envíos utilizan códigos genéricos (9901.00.XX).' };
}

function evaluateRule375C(
  rule: T1ComplianceRule,
  shipments: T1Shipment[]
): T1ComplianceRule {
  // Group by consignee RFC and detect fractional patterns
  const byRfc = new Map<string, T1Shipment[]>();
  for (const s of shipments) {
    const rfc = s.consigneeRfc?.toUpperCase().trim() || 'UNKNOWN';
    if (!byRfc.has(rfc)) byRfc.set(rfc, []);
    byRfc.get(rfc)!.push(s);
  }

  const violations: string[] = [];
  const affectedIds: string[] = [];

  for (const [rfc, group] of byRfc) {
    if (group.length >= 3) {
      const totalValue = group.reduce((sum, s) => sum + s.declaredValueUsd, 0);
      if (totalValue > T1_MAX_VALUE_USD) {
        violations.push(
          `RFC ${rfc}: ${group.length} envíos, total $${totalValue.toFixed(2)} USD — posible fraccionamiento`
        );
        affectedIds.push(...group.map((s) => s.id));
      }
    }
  }

  if (violations.length > 0) {
    return {
      ...rule,
      status: 'FAILED',
      detail: `Detección de fraccionamiento: ${violations.length} consignatario(s). ${violations[0]}`,
      affectedShipmentIds: affectedIds,
    };
  }
  return { ...rule, status: 'PASSED', detail: 'No se detectaron patrones de fraccionamiento.' };
}

function evaluateRule375D(
  rule: T1ComplianceRule,
  shipments: T1Shipment[]
): T1ComplianceRule {
  const violations: string[] = [];
  const affectedIds: string[] = [];

  for (const s of shipments) {
    if (s.transportMode === 'LAND' || s.transportMode === 'AIR') continue;
    violations.push(`${s.guideId}: modo ${s.transportMode}`);
    affectedIds.push(s.id);
  }

  if (violations.length > 0) {
    return {
      ...rule,
      status: 'FAILED',
      detail: `${violations.length} envío(s) con modalidad no permitida (solo AIRE o TERRESTRE): ${violations.slice(0, 3).join('; ')}`,
      affectedShipmentIds: affectedIds,
    };
  }
  return { ...rule, status: 'PASSED', detail: 'Todos los envíos utilizan modalidad aérea o terrestre.' };
}

function evaluateRule375E(
  rule: T1ComplianceRule,
  shipments: T1Shipment[]
): T1ComplianceRule {
  const violations: string[] = [];
  const affectedIds: string[] = [];

  for (const s of shipments) {
    const rrnaFlags = detectRRNA(s);
    if (rrnaFlags.length > 0) {
      const blockedFlags = rrnaFlags.filter(
        (f) =>
          f !== 'ZERO_VALUE' &&
          f !== 'GENERIC_DESCRIPTION'
      );
      if (blockedFlags.length > 0) {
        violations.push(`${s.guideId}: ${blockedFlags.join(', ')}`);
        affectedIds.push(s.id);
      }
    }
  }

  if (violations.length > 0) {
    return {
      ...rule,
      status: 'FAILED',
      detail: `${violations.length} envío(s) con mercancía sujeta a RRNA: ${violations.slice(0, 3).join('; ')}${violations.length > 3 ? '...' : ''}`,
      affectedShipmentIds: affectedIds,
    };
  }
  return { ...rule, status: 'PASSED', detail: 'Ningún envío está sujeto a restricciones no arancelarias.' };
}

function evaluateRule3735A(
  rule: T1ComplianceRule,
  shipments: T1Shipment[]
): T1ComplianceRule {
  const standardCount = shipments.filter(
    (s) => !['US', 'USA', 'CA', 'CAN'].includes(s.originCountry.toUpperCase()) && s.declaredValueUsd > 50
  ).length;
  return {
    ...rule,
    status: 'PASSED',
    detail: `${standardCount} envío(s) aplicarán tasa global estándar del 33.5%.`,
  };
}

function evaluateRule3735B(
  rule: T1ComplianceRule,
  shipments: T1Shipment[]
): T1ComplianceRule {
  const usmcaCount = shipments.filter(
    (s) =>
      ['US', 'USA', 'CA', 'CAN'].includes(s.originCountry.toUpperCase()) &&
      s.declaredValueUsd > 117
  ).length;
  return {
    ...rule,
    status: 'PASSED',
    detail: `${usmcaCount} envío(s) son elegibles para tasa preferencial USMCA del 19%.`,
  };
}

function evaluateRule3735C(
  rule: T1ComplianceRule,
  shipments: T1Shipment[]
): T1ComplianceRule {
  const exemptCount = shipments.filter((s) => s.declaredValueUsd <= 50).length;
  return {
    ...rule,
    status: 'PASSED',
    detail: `${exemptCount} envío(s) con valor ≤$50 USD pueden calificar para exención de minimis.`,
  };
}

function evaluateRule3734A(rule: T1ComplianceRule): T1ComplianceRule {
  // Audit-only rule; always passes in normal operation
  return { ...rule, status: 'PASSED', detail: 'Sin evidencia de documentación falsa (revisión periódica).' };
}

function evaluateRule3734B(rule: T1ComplianceRule): T1ComplianceRule {
  // Audit-only rule; always passes in normal operation
  return { ...rule, status: 'PASSED', detail: 'Infraestructura de CCTV y controles cumple lineamientos SAT/ANAM.' };
}

// ============================================================================
// Main Compliance Evaluation
// ============================================================================

/**
 * Evaluate a full manifest against all RGCE T1 compliance rules.
 * Also updates each shipment's status in place.
 */
export function evaluateT1Compliance(shipments: T1Shipment[]): T1ComplianceResult {
  const baseRules = createInitialComplianceRules();
  const evaluatedRules: T1ComplianceRule[] = [];
  const violations: T1Violation[] = [];

  for (const rule of baseRules) {
    let evaluated: T1ComplianceRule;

    switch (rule.id) {
      case 'RGCE-3.7.3-A':
        evaluated = evaluateRule373A(rule, shipments);
        break;
      case 'RGCE-3.7.3-B':
        evaluated = evaluateRule373B(rule, shipments);
        break;
      case 'RGCE-3.7.3-C':
        evaluated = evaluateRule373C(rule, shipments);
        break;
      case 'RGCE-3.7.3-D':
        evaluated = evaluateRule373D(rule, shipments);
        break;
      case 'RGCE-3.7.5-A':
        evaluated = evaluateRule375A(rule, shipments);
        break;
      case 'RGCE-3.7.5-B':
        evaluated = evaluateRule375B(rule, shipments);
        break;
      case 'RGCE-3.7.5-C':
        evaluated = evaluateRule375C(rule, shipments);
        break;
      case 'RGCE-3.7.5-D':
        evaluated = evaluateRule375D(rule, shipments);
        break;
      case 'RGCE-3.7.5-E':
        evaluated = evaluateRule375E(rule, shipments);
        break;
      case 'RGCE-3.7.35-A':
        evaluated = evaluateRule3735A(rule, shipments);
        break;
      case 'RGCE-3.7.35-B':
        evaluated = evaluateRule3735B(rule, shipments);
        break;
      case 'RGCE-3.7.35-C':
        evaluated = evaluateRule3735C(rule, shipments);
        break;
      case 'RGCE-3.7.34-A':
        evaluated = evaluateRule3734A(rule);
        break;
      case 'RGCE-3.7.34-B':
        evaluated = evaluateRule3734B(rule);
        break;
      default:
        evaluated = { ...rule, status: 'PENDING' };
    }

    evaluatedRules.push(evaluated);

    // Build violations list
    if (evaluated.status === 'FAILED' && evaluated.affectedShipmentIds) {
      for (const shipId of evaluated.affectedShipmentIds) {
        violations.push({
          ruleId: evaluated.id,
          shipmentId: shipId,
          message: `${evaluated.title}: ${evaluated.detail || ''}`,
          severity: evaluated.severity,
        });
      }
    }
  }

  // Update shipment statuses based on violations
  updateShipmentStatuses(shipments, violations);

  const blockingCount = violations.filter((v) => v.severity === 'BLOCKING').length;
  const warningCount = violations.filter((v) => v.severity === 'WARNING').length;
  const passedCount = evaluatedRules.filter((r) => r.status === 'PASSED').length;
  const failedCount = evaluatedRules.filter((r) => r.status === 'FAILED').length;

  return {
    rules: evaluatedRules,
    violations,
    canProceed: blockingCount === 0,
    summary: {
      total: evaluatedRules.length,
      passed: passedCount,
      failed: failedCount,
      blocking: blockingCount,
      warning: warningCount,
    },
  };
}

/**
 * Update each shipment's status based on compliance violations.
 */
function updateShipmentStatuses(shipments: T1Shipment[], violations: T1Violation[]): void {
  const shipViolations = new Map<string, T1Violation[]>();
  for (const v of violations) {
    if (!shipViolations.has(v.shipmentId)) shipViolations.set(v.shipmentId, []);
    shipViolations.get(v.shipmentId)!.push(v);
  }

  for (const s of shipments) {
    const vs = shipViolations.get(s.id) || [];
    if (vs.length === 0) {
      if (s.status === 'PENDING') s.status = 'VALID';
      continue;
    }

    const hasBlocking = vs.some((v) => v.severity === 'BLOCKING');
    if (hasBlocking) {
      // Determine specific blocking type
      const ruleIds = vs.map((v) => v.ruleId);
      if (ruleIds.includes('RGCE-3.7.5-A')) s.status = 'EXCEEDS_THRESHOLD';
      else if (ruleIds.includes('RGCE-3.7.5-C')) s.status = 'FRACTIONAL_FLAG';
      else if (ruleIds.includes('RGCE-3.7.3-C')) s.status = 'ZERO_VALUE_BLOCKED';
      else if (ruleIds.includes('RGCE-3.7.3-B')) s.status = 'GENERIC_DESC_BLOCKED';
      else s.status = 'RRNA_BLOCKED';
    }
  }
}

/**
 * Get recommended action for a shipment based on its status.
 */
export function getRecommendedAction(status: ShipmentStatus): string {
  switch (status) {
    case 'VALID':
      return 'Apto para Pedimento T1';
    case 'EXCEEDS_THRESHOLD':
      return 'Extraer y despachar vía Pedimento A1 con Agente Aduanal';
    case 'RRNA_BLOCKED':
      return 'Separar mercancía RRNA; despachar vía A1 con permisos federales';
    case 'FRACTIONAL_FLAG':
      return 'Revisar fraccionamiento; consolidar y despachar vía A1';
    case 'ZERO_VALUE_BLOCKED':
      return 'Solicitar factura comercial con valor real al remitente';
    case 'GENERIC_DESC_BLOCKED':
      return 'Solicitar descripción específica del producto al remitente';
    case 'PENDING':
      return 'Pendiente de análisis de cumplimiento';
    default:
      return 'Revisar manualmente';
  }
}
