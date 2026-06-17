import type { Pedimento } from '../types/pedimento';

const RFC = /^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$/;        // 12–13 chars
const CURP = /^[A-Z]{4}[0-9]{6}[HM][A-Z]{5}[A-Z0-9]{2}$/; // 18 chars

export function isValidTaxId(id: string): boolean {
  const v = (id ?? '').toUpperCase().replace(/\s/g, '');
  return RFC.test(v) || CURP.test(v);
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
