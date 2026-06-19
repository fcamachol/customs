import type { Shipment } from '../types/shipment';
import { norm, runSignals, type RiskContext } from './signals';
import { RULESET } from './ruleset';

export type RiskColor = 'verde' | 'amarillo' | 'rojo';

export function classifyScore(score: number): RiskColor {
  if (score < 2) return 'verde';
  if (score <= 3) return 'amarillo';
  return 'rojo';
}

export interface ScoredShipment {
  shipment: Shipment;
  score: number;
  color: RiskColor;
  incidences: string[];
  ruleset_version: string;
}

export interface ScoreOptions {
  /** Optional override list for piracy brands (falls back to built-in list when omitted) */
  piracyBrands?: string[];
  /** Optional override list for prohibited keywords (falls back to built-in list when omitted) */
  prohibitedKeywords?: string[];
}

export function scoreManifest(
  shipments: Shipment[],
  monthlyHistoryNames: Set<string>,
  options?: ScoreOptions,
): ScoredShipment[] {
  // Count DISTINCT packages (guideId) per consignee/address — not raw rows.
  // Each manifest row is a product line-item; many rows share one guideId (one
  // physical package/guide). Counting rows would flag every multi-line package
  // as "varios paquetes por consignatario" / "misma dirección de entrega".
  // Aggregate by package so the signals reflect real shipment units.
  const namePackages: Record<string, Set<string>> = {};
  const addressPackages: Record<string, Set<string>> = {};
  for (const s of shipments) {
    const n = norm(s.consignee.name);
    const a = norm(s.consignee.address ?? '');
    const pkg = s.guideId || s.id; // fall back to row id when a guide is absent
    if (n) (namePackages[n] ??= new Set()).add(pkg);
    if (a) (addressPackages[a] ??= new Set()).add(pkg);
  }
  const nameCounts: Record<string, number> = {};
  const addressCounts: Record<string, number> = {};
  for (const [k, v] of Object.entries(namePackages)) nameCounts[k] = v.size;
  for (const [k, v] of Object.entries(addressPackages)) addressCounts[k] = v.size;
  const ctx: RiskContext = {
    nameCounts,
    addressCounts,
    monthlyHistoryNames,
    piracyBrands: options?.piracyBrands,
    prohibitedKeywords: options?.prohibitedKeywords,
  };
  return shipments.map((s) => {
    const signals = runSignals(s, ctx);
    const fired = signals.filter((f) => f.flagged);
    const score = fired.length;
    const firedIds = new Set(fired.map((f) => f.id));
    // Severity override (RF-04): critical signals force rojo regardless of count
    const hasCritical = firedIds.has('prohibidos') || firedIds.has('pirateria');
    const color: RiskColor = hasCritical ? 'rojo' : classifyScore(score);
    return { shipment: s, score, color, incidences: fired.map((f) => f.incidence!).filter(Boolean), ruleset_version: RULESET.version };
  });
}
