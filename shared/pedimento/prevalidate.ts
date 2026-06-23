import type { Pedimento } from '../types/pedimento';
import { CURP_RE, RFC_RE, cleanId, isValidTaxIdStrict } from '../parsing/taxId';

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
  if (!isValidTaxId(p.header.importer.rfc)) errors.push('RFC del importador inválido.');
  if (!isValidTaxId(p.header.agent.agentRfc)) errors.push('RFC del agente inválido.');
  // Shape passes but the official check digit doesn't — warn (P1: RFC/CURP checksum).
  if (isValidTaxId(p.header.importer.rfc) && !isValidTaxIdStrict(p.header.importer.rfc))
    warnings.push('RFC del importador: dígito verificador no coincide.');
  if (isValidTaxId(p.header.agent.agentRfc) && !isValidTaxIdStrict(p.header.agent.agentRfc))
    warnings.push('RFC del agente: dígito verificador no coincide.');
  if (!p.header.observations?.trim()) errors.push('Faltan observaciones a nivel pedimento.');

  p.partidas.forEach((pa) => {
    if (!/^990[12]00\d{2}$/.test(pa.fraccion)) errors.push(`Partida ${pa.secuencia}: fracción debe iniciar con 9901/9902.`);
    if (pa.valorAduanaUsd > 2500) errors.push(`Partida ${pa.secuencia}: valor excede $2,500 USD.`);
    if (pa.valorAduanaUsd <= 0) errors.push(`Partida ${pa.secuencia}: valor debe ser mayor a 0.`);
    if (!/^GUIA .+ VALOR .+ USD NOMBRE .+ RFC-CURP .+$/.test(pa.observation)) {
      warnings.push(`Partida ${pa.secuencia}: formato de observación no estándar.`);
    }
  });

  return { status: errors.length ? 'REJECTED' : 'APPROVED', errors, warnings };
}
