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
  // Count line-item ROWS per consignee name / address to match the authoritative
  // Risk_analysis workbook (V4 consignatario, V5 dirección fire on row repetition).
  // Open decision (defer to client): whether V4/V5 should count distinct packages
  // (guideId) vs line-item rows — v1 uses rows per the source spreadsheet.
  const nameCounts: Record<string, number> = {};
  const addressCounts: Record<string, number> = {};
  for (const s of shipments) {
    const n = norm(s.consignee.name);
    const a = norm(s.consignee.address ?? '');
    if (n) nameCounts[n] = (nameCounts[n] ?? 0) + 1;
    if (a) addressCounts[a] = (addressCounts[a] ?? 0) + 1;
  }
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
