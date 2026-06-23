import type { Shipment } from '../types/shipment';
import { cleanId, validateTaxId } from '../parsing/taxId';
import { matchesBrand, matchesProhibited } from './lists';
import { resolveThresholds, type Thresholds, type Weights } from './ruleset';

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

// ─── Task 5: Graded, entity-aware signals with reason codes ──────────────────

export type SignalId = 'id' | 'cantidad' | 'monto' | 'direcciones' | 'prohibidos' | 'pirateria' | 'bbdd';

export interface ReasonCode {
  signalId: SignalId;
  points: number;
  weight: number;
  detail: string;
  evidence?: Record<string, unknown>;
  forcesBand?: 'rojo';
}

export interface EntityContext {
  thresholds: Thresholds;
  weights: Weights;
  /** Distinct consignee count per normalized address (smurfing indicator). */
  addressDistinctConsignees: Record<string, number>;
  /**
   * Monthly operation count per **normalized consignee name** (history + current)
   * for Ficha-124. Keyed by `norm(name)` to match the name-keyed monthly_history
   * DB rows. Do NOT use entityKey here — RFC/CURP keys would never match the
   * name-keyed history loaded from the server.
   */
  monthlyNameCount: Record<string, number>;
  piracyBrands?: string[];
  prohibitedKeywords?: string[];
}

/** Entity identity: RFC/CURP when present (deterministic), else normalized name. */
export function entityKey(c: { rfc?: string; curp?: string; name: string }): string {
  const id = cleanId(c.curp ?? c.rfc ?? '');
  return id || `name:${norm(c.name)}`;
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Graded, entity-aware signal evaluation.
 * Returns one ReasonCode per fired signal (points > 0 only).
 * A normal repeat buyer with a valid ID and in-band values fires nothing.
 */
export function gradeSignals(s: Shipment, ctx: EntityContext): ReasonCode[] {
  const t = ctx.thresholds;
  const w = ctx.weights;
  const out: ReasonCode[] = [];

  const add = (
    signalId: SignalId,
    frac: number,
    detail: string,
    evidence?: Record<string, unknown>,
    forces?: 'rojo',
  ): void => {
    const points = Math.round(w[signalId] * clamp01(frac));
    if (points > 0) {
      out.push({ signalId, points, weight: w[signalId], detail, evidence, forcesBand: forces });
    }
  };

  // id: missing or shape/checksum invalid → full weight
  const idRaw = cleanId(s.consignee.curp ?? s.consignee.rfc ?? '');
  const idCheck = validateTaxId(idRaw);
  if (!idRaw || !idCheck.shapeValid || !idCheck.checksumValid) {
    add('id', 1, !idRaw ? 'Falta RFC/CURP' : 'RFC/CURP inválido', { id: idRaw });
  }

  // cantidad: graded by excess over threshold
  if (s.quantity > t.cantidad) {
    add('cantidad', (s.quantity - t.cantidad) / t.cantidad, 'Demasiados productos', { quantity: s.quantity });
  }

  // monto: below min → full weight; above max → graded by excess
  if (s.customsValueUsd < t.montoMin) {
    add('monto', 1, 'Valor declarado incorrecto (muy bajo)', { value: s.customsValueUsd });
  } else if (s.customsValueUsd > t.montoMax) {
    add('monto', (s.customsValueUsd - t.montoMax) / t.montoMax, 'Valor declarado incorrecto (muy alto)', { value: s.customsValueUsd });
  }

  // direcciones: smurfing signal — distinct entities at one address ≥ threshold
  const normAddr = norm(s.consignee.address ?? '');
  const distinctCount = normAddr ? (ctx.addressDistinctConsignees[normAddr] ?? 0) : 0;
  if (distinctCount >= t.addressDistinctConsignees) {
    add(
      'direcciones',
      (distinctCount - (t.addressDistinctConsignees - 1)) / t.addressDistinctConsignees,
      'Misma dirección de entrega',
      { distinctConsignees: distinctCount },
    );
  }

  // prohibidos: full weight + forces rojo
  const prohibited = matchesProhibited(s.description, ctx.prohibitedKeywords);
  if (prohibited) {
    add('prohibidos', 1, `Artículos prohibidos (${prohibited})`, { matched: prohibited }, 'rojo');
  }

  // pirateria: full weight + forces rojo
  const brand = matchesBrand(s.description, ctx.piracyBrands);
  if (brand) {
    add('pirateria', 1, `Piratería (${brand})`, { matched: brand }, 'rojo');
  }

  // bbdd (Ficha-124): fires only when monthlyNameCount > 3, graded by excess over 3.
  // Keyed by normalized consignee name (consistent with name-keyed DB history).
  const mc = ctx.monthlyNameCount[norm(s.consignee.name)] ?? 0;
  if (mc > 3) {
    add('bbdd', (mc - 3) / 3, 'Varias importaciones en el mes', { monthlyCount: mc });
  }

  return out;
}
