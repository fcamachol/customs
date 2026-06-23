// shared/risk/scorecard.ts
import type { ReasonCode } from './signals';
import { maxPoints, type Bands, type Weights } from './ruleset';

export type Band = 'verde' | 'amarillo' | 'rojo' | 'gris';

export interface ScoreResult {
  score: number;
  band: Band;
  reasons: ReasonCode[];
}

export function scoreRow(
  reasons: ReasonCode[],
  opts: { weights: Weights; bands: Bands; insufficientData: boolean },
): ScoreResult {
  const sorted = [...reasons].sort((a, b) => b.points - a.points);
  if (opts.insufficientData) return { score: 0, band: 'gris', reasons: sorted };
  const raw = reasons.reduce((sum, r) => sum + r.points, 0);
  const max = maxPoints(opts.weights) || 1;
  const score = Math.min(100, Math.round((100 * raw) / max));
  const forced = reasons.some((r) => r.forcesBand === 'rojo');
  let band: Band;
  if (forced || score >= opts.bands.rojo) band = 'rojo';
  else if (score >= opts.bands.amarillo) band = 'amarillo';
  else band = 'verde';
  return { score, band, reasons: sorted };
}
