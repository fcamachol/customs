import type { Pedimento } from '../types/pedimento';
import { GENERIC_FRACTION_RE } from './fraction';
import { CURP_RE, RFC_RE, cleanId, isValidTaxIdStrict } from '../parsing/taxId';

/**
 * F13: Per-entity aggregate cap — mirrors RULESET.thresholds.montoMax (= 2500).
 * Single-sourced here so the per-row cap and the aggregate grouping cap cannot drift.
 * Cross-reference: RULESET.montoMax = 2500 in shared/risk/ruleset.ts.
 */
const SPLIT_CAP_USD = 2500;

/**
 * Parse the RFC-CURP identity from a standard partida observation string.
 * Format: "GUIA ... VALOR ... USD NOMBRE ... RFC-CURP <id>"
 * Returns the id segment if found, otherwise null.
 */
function parseIdFromObservation(obs: string): string | null {
  const m = /RFC-CURP\s+(\S+)/.exec(obs ?? '');
  return m ? m[1].toUpperCase() : null;
}

export function isValidTaxId(id: string): boolean {
  const v = cleanId(id);
  return RFC_RE.test(v) || CURP_RE.test(v);
}

export interface PrevalidationResult {
  status: 'APPROVED' | 'REJECTED';
  errors: string[];
  warnings: string[];
}

export function prevalidatePedimento(p: Pedimento): PrevalidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!/^\d{15}$/.test(p.header.numeroPedimento)) errors.push('El número de pedimento debe tener 15 dígitos.');
  if (p.header.clave !== 'T1') errors.push('Clave debe ser T1.');
  // F05: RFC/CURP checksum blocking when the RFC is PRESENT. A MISSING (empty) RFC means the
  // entity was auto-registered from a pedimento but not yet verified — that is a warning, not a
  // hard error, so a captured pedimento can still be prevalidated while the catalog is completed.
  if (!p.header.importer.rfc) warnings.push('RFC del importador no disponible — entidad sin verificar.');
  else if (!isValidTaxIdStrict(p.header.importer.rfc)) errors.push('RFC del importador inválido (dígito verificador no coincide).');
  if (!p.header.agent.agentRfc) warnings.push('RFC del agente no disponible — entidad sin verificar.');
  else if (!isValidTaxIdStrict(p.header.agent.agentRfc)) errors.push('RFC del agente inválido (dígito verificador no coincide).');
  if (!p.header.agent.agencyRfc) warnings.push('RFC de la agencia no disponible — entidad sin verificar.');
  else if (!isValidTaxIdStrict(p.header.agent.agencyRfc)) errors.push('RFC de la agencia inválido (dígito verificador no coincide).');
  if (!p.header.observations?.trim()) errors.push('Faltan observaciones a nivel pedimento.');

  p.partidas.forEach((pa) => {
    if (!GENERIC_FRACTION_RE.test(pa.fraccion)) errors.push(`Partida ${pa.secuencia}: fracción debe iniciar con 9901/9902.`);
    if (pa.valorAduanaUsd > SPLIT_CAP_USD) errors.push(`Partida ${pa.secuencia}: valor excede $${SPLIT_CAP_USD} USD.`);
    if (pa.valorAduanaUsd <= 0) errors.push(`Partida ${pa.secuencia}: valor debe ser mayor a 0.`);
    if (!/^GUIA .+ VALOR .+ USD NOMBRE .+ RFC-CURP .+$/.test(pa.observation)) {
      warnings.push(`Partida ${pa.secuencia}: formato de observación no estándar.`);
    }
    if (p.header.clave === 'T1' && pa.contribuciones && pa.contribuciones.length) errors.push(`Partida ${pa.secuencia}: T1/IMD no admite contribuciones (regla de no contribución).`);
  });

  // F13: cross-row aggregate cap — group partidas by consignee key and push an error
  // if any group total exceeds SPLIT_CAP_USD (posible envío fraccionado).
  // Grouping key precedence: consigneeKey (set by buildPedimento) → parsed RFC-CURP
  // from observation (backwards-compat with already-persisted pedimentos) → seq:<n>.
  const entityTotals: Record<string, number> = {};
  for (const pa of p.partidas) {
    const gk =
      pa.consigneeKey ??
      parseIdFromObservation(pa.observation) ??
      `seq:${pa.secuencia}`;
    entityTotals[gk] = (entityTotals[gk] ?? 0) + (Number.isFinite(pa.valorAduanaUsd) ? pa.valorAduanaUsd : 0);
  }
  for (const [id, total] of Object.entries(entityTotals)) {
    if (total > SPLIT_CAP_USD) {
      errors.push(
        `Consignatario ${id}: valor agregado $${total.toFixed(2)} USD excede $${SPLIT_CAP_USD} USD (posible envío fraccionado).`,
      );
    }
  }

  return { status: errors.length ? 'REJECTED' : 'APPROVED', errors, warnings };
}
