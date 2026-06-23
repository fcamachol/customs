import type { Shipment } from '../types/shipment';
import { cleanId, validateTaxId } from '../parsing/taxId';
import { matchesBrand, matchesProhibited } from './lists';
import { resolveThresholds, type Thresholds } from './ruleset';

export interface RiskContext {
  nameCounts: Record<string, number>;
  addressCounts: Record<string, number>;
  /**
   * Prior monthly operation counts per normalized consignee name, summed across
   * OTHER manifests in the same period (the current manifest is excluded so it is
   * counted once via `nameCounts`). Used by the `bbdd` signal to apply the Ficha
   * 124 ">3 operations/consignee/month" trigger against the full monthly total.
   */
  monthlyHistoryCounts: Record<string, number>;
  /** Optional override list for piracy brand detection */
  piracyBrands?: string[];
  /** Optional override list for prohibited keyword detection */
  prohibitedKeywords?: string[];
  /** Resolved thresholds (admin-configurable overrides already merged over RULESET defaults) */
  thresholds?: Thresholds;
}

export interface SignalResult {
  id: 'id' | 'cantidad' | 'monto' | 'consignatarios' | 'direcciones' | 'prohibidos' | 'pirateria' | 'bbdd';
  flagged: boolean;
  incidence?: string;
}

export const norm = (s: string): string =>
  (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

export function runSignals(s: Shipment, ctx: RiskContext): SignalResult[] {
  const t = ctx.thresholds ?? resolveThresholds();
  const idRaw = cleanId(s.consignee.curp ?? s.consignee.rfc ?? '');
  const idCheck = validateTaxId(idRaw);
  const name = norm(s.consignee.name);
  const addr = norm(s.consignee.address ?? '');
  const brand = matchesBrand(s.description, ctx.piracyBrands);
  const prohibited = matchesProhibited(s.description, ctx.prohibitedKeywords);

  const signals: SignalResult[] = [
    { id: 'id', flagged: !idRaw || !idCheck.shapeValid || !idCheck.checksumValid, incidence: !idRaw ? 'Falta RFC/CURP' : 'RFC/CURP inválido' },
    { id: 'cantidad', flagged: s.quantity > t.cantidad, incidence: 'Demasiados productos' },
    { id: 'monto', flagged: s.customsValueUsd < t.montoMin || s.customsValueUsd > t.montoMax, incidence: 'Valor declarado incorrecto' },
    { id: 'consignatarios', flagged: (ctx.nameCounts[name] ?? 0) >= t.consignatario, incidence: 'Varios paquetes por consignatario' },
    { id: 'direcciones', flagged: !!addr && (ctx.addressCounts[addr] ?? 0) >= t.direccion, incidence: 'Misma dirección de entrega' },
    { id: 'prohibidos', flagged: !!prohibited, incidence: prohibited ? `Artículos prohibidos (${prohibited})` : undefined },
    { id: 'pirateria', flagged: !!brand, incidence: brand ? `Piratería (${brand})` : undefined },
    { id: 'bbdd', flagged: (ctx.monthlyHistoryCounts[name] ?? 0) + (ctx.nameCounts[name] ?? 0) >= t.importacionesMes, incidence: 'Varias importaciones en el mes' },
  ];
  return signals.map((r) => ({ ...r, incidence: r.flagged ? r.incidence : undefined }));
}
