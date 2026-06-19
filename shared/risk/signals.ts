import type { Shipment } from '../types/shipment';
import { matchesBrand, matchesProhibited } from './lists';
import { RULESET } from './ruleset';

export interface RiskContext {
  nameCounts: Record<string, number>;
  addressCounts: Record<string, number>;
  monthlyHistoryNames: Set<string>;
  /** Optional override list for piracy brand detection */
  piracyBrands?: string[];
  /** Optional override list for prohibited keyword detection */
  prohibitedKeywords?: string[];
}

export interface SignalResult {
  id: 'id' | 'cantidad' | 'monto' | 'consignatarios' | 'direcciones' | 'prohibidos' | 'pirateria' | 'bbdd';
  flagged: boolean;
  incidence?: string;
}

export const norm = (s: string): string =>
  (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

export function runSignals(s: Shipment, ctx: RiskContext): SignalResult[] {
  const id = (s.consignee.curp ?? s.consignee.rfc ?? '').replace(/\s/g, '');
  const name = norm(s.consignee.name);
  const addr = norm(s.consignee.address ?? '');
  const brand = matchesBrand(s.description, ctx.piracyBrands);
  const prohibited = matchesProhibited(s.description, ctx.prohibitedKeywords);

  const signals: SignalResult[] = [
    { id: 'id', flagged: !(id.length === 13 || id.length === 18), incidence: 'Falta RFC/CURP' },
    { id: 'cantidad', flagged: s.quantity > RULESET.thresholds.cantidad, incidence: 'Demasiados productos' },
    { id: 'monto', flagged: s.customsValueUsd < RULESET.thresholds.montoMin || s.customsValueUsd > RULESET.thresholds.montoMax, incidence: 'Valor declarado incorrecto' },
    { id: 'consignatarios', flagged: (ctx.nameCounts[name] ?? 0) >= RULESET.thresholds.consignatario, incidence: 'Varios paquetes por consignatario' },
    { id: 'direcciones', flagged: !!addr && (ctx.addressCounts[addr] ?? 0) >= RULESET.thresholds.direccion, incidence: 'Misma dirección de entrega' },
    { id: 'prohibidos', flagged: !!prohibited, incidence: prohibited ? `Artículos prohibidos (${prohibited})` : undefined },
    { id: 'pirateria', flagged: !!brand, incidence: brand ? `Piratería (${brand})` : undefined },
    { id: 'bbdd', flagged: ctx.monthlyHistoryNames.has(name), incidence: 'Varias importaciones en el mes' },
  ];
  return signals.map((r) => ({ ...r, incidence: r.flagged ? r.incidence : undefined }));
}
