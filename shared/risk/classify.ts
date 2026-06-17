import type { Shipment } from '../types/shipment';
import { norm, runSignals, type RiskContext } from './signals';

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
}

export function scoreManifest(shipments: Shipment[], monthlyHistoryNames: Set<string>): ScoredShipment[] {
  const nameCounts: Record<string, number> = {};
  const addressCounts: Record<string, number> = {};
  for (const s of shipments) {
    const n = norm(s.consignee.name);
    const a = norm(s.consignee.address ?? '');
    if (n) nameCounts[n] = (nameCounts[n] ?? 0) + 1;
    if (a) addressCounts[a] = (addressCounts[a] ?? 0) + 1;
  }
  const ctx: RiskContext = { nameCounts, addressCounts, monthlyHistoryNames };
  return shipments.map((s) => {
    const signals = runSignals(s, ctx);
    const fired = signals.filter((f) => f.flagged);
    const score = fired.length;
    return { shipment: s, score, color: classifyScore(score), incidences: fired.map((f) => f.incidence!).filter(Boolean) };
  });
}
