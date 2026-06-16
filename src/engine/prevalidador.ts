/**
 * Prevalidador — SAAI M3 Pre-Validation Simulation
 *
 * Simulates the electronic pre-validation performed by a Prevalidador
 * entity before the T1 pedimento is transmitted to SAT/ANAM servers.
 *
 * Validates structural correctness per Lineamientos Técnicos de
 * Registros VOCE – SAAI M3 (Anexo 22).
 */

import { T1PedimentoGlobal, PrevalidationResult } from '../types/t1';

/**
 * Validate a T1 Pedimento Global against SAAI M3 structural rules.
 */
export function prevalidatePedimento(pedimento: T1PedimentoGlobal): PrevalidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // ========================================================================
  // Record 500 — General Header Validation
  // ========================================================================
  if (!pedimento.record500) {
    errors.push('ERR-500: Registro 500 (Encabezado General) faltante');
  } else {
    if (!pedimento.record500.patent || pedimento.record500.patent.length < 3) {
      errors.push('ERR-500-PAT: Patente de Agente Aduanal inválida o faltante');
    }
    if (!pedimento.record500.pedimento || pedimento.record500.pedimento.replace(/\s/g, '').length !== 15) {
      errors.push('ERR-500-PED: Número de pedimento debe tener 15 dígitos');
    }
    if (pedimento.record500.clave !== 'T1') {
      errors.push('ERR-500-CLAVE: Clave de pedimento debe ser "T1"');
    }
    if (!pedimento.record500.genericRfc) {
      errors.push('ERR-500-RFC: RFC genérico del consignatario faltante');
    }
  }

  // ========================================================================
  // EM Identifier Validation
  // ========================================================================
  if (!pedimento.emIdentifier || pedimento.emIdentifier.length < 3) {
    errors.push('ERR-EM: Identificador EM (Empresa de Mensajería) requerido');
  }

  // ========================================================================
  // MJ Complement Consistency
  // ========================================================================
  const hasMjComplement = pedimento.mjComplement;
  const anyTaxable = pedimento.partidas.some((p) => p.valueUsd > 50);

  if (hasMjComplement && anyTaxable) {
    errors.push(
      'ERR-MJ: Complemento MJ (exención) incompatible con partidas gravables (> $50 USD)'
    );
  }

  if (!hasMjComplement && !anyTaxable) {
    warnings.push(
      'WARN-MJ: Todas las partidas son ≤$50 USD; considere activar complemento MJ'
    );
  }

  // ========================================================================
  // Partidas (Record 501) Validation
  // ========================================================================
  if (pedimento.partidas.length === 0) {
    errors.push('ERR-501: El pedimento no contiene partidas');
  }

  const seenSecuencias = new Set<number>();

  pedimento.partidas.forEach((partida, idx) => {
    const prefix = `ERR-501-${String(idx + 1).padStart(3, '0')}`;

    // Secuencia uniqueness
    if (seenSecuencias.has(partida.secuencia)) {
      errors.push(`${prefix}-SEQ: Secuencia duplicada ${partida.secuencia}`);
    }
    seenSecuencias.add(partida.secuencia);

    // Generic HS code must start with 9901 (import) or 9902 (export)
    if (!partida.genericHsCode || !/^990[12]\.00\.\d{2}$/.test(partida.genericHsCode)) {
      errors.push(
        `${prefix}-HS: Fracción arancelaria "${partida.genericHsCode}" no es código genérico válido (9901.00.XX o 9902.00.XX)`
      );
    }

    // Value threshold
    if (partida.valueUsd > 2500) {
      errors.push(
        `${prefix}-VAL: Valor $${partida.valueUsd.toFixed(2)} USD excede límite de $2,500 USD`
      );
    }

    if (partida.valueUsd <= 0) {
      errors.push(`${prefix}-VAL0: Valor declarado debe ser mayor a cero`);
    }

    // Consignee RFC required in observation
    if (!partida.consigneeRfc || partida.consigneeRfc.trim().length === 0) {
      errors.push(`${prefix}-RFC: RFC de consignatario requerido en observaciones`);
    } else {
      const rfcRegex = /^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$/i;
      if (!rfcRegex.test(partida.consigneeRfc.trim())) {
        errors.push(`${prefix}-RFC-FMT: RFC "${partida.consigneeRfc}" no cumple formato oficial`);
      }
    }

    // Quantity
    if (partida.quantity <= 0) {
      errors.push(`${prefix}-QTY: Cantidad debe ser mayor a cero`);
    }

    // Description
    if (!partida.description || partida.description.trim().length < 3) {
      errors.push(`${prefix}-DESC: Descripción demasiado corta o genérica`);
    }

    // Observation format check
    if (!partida.observation || !partida.observation.includes('EM1')) {
      warnings.push(
        `${prefix}-OBS: Observación no contiene identificador EM1 (formato recomendado: EM1|nombre|RFC:xxx)`
      );
    }
  });

  // ========================================================================
  // Result
  // ========================================================================
  const approved = errors.length === 0;

  return {
    status: approved ? 'APPROVED' : 'REJECTED',
    errors,
    warnings,
    vistoBueno: approved ? generateVistoBueno(pedimento) : undefined,
  };
}

/**
 * Generate a digital "Visto Bueno" (approval seal) for a validated pedimento.
 */
function generateVistoBueno(pedimento: T1PedimentoGlobal): string {
  const timestamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const hashInput = `${pedimento.emIdentifier}|${pedimento.numeroPedimento}|${pedimento.partidas.length}|${timestamp}`;
  const hash = simpleHash(hashInput);
  return `VB-${pedimento.emIdentifier}-${timestamp}-${hash}`;
}

/**
 * Simple string hash for simulation purposes (not cryptographically secure).
 */
function simpleHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return Math.abs(hash).toString(16).toUpperCase().padStart(8, '0');
}
