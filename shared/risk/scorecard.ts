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
  // A forcesBand:'rojo' signal (denied_party, prohibidos, pirateria) must win over the
  // insufficient-data gris short-circuit: a sanctions/prohibited hit may fire on rows
  // that are ALSO missing RFC/CURP or customs value, and hiding it in "Sin evaluar"
  // would remove it from the rojo review queue.
  const forced = reasons.some((r) => r.forcesBand === 'rojo');
  if (opts.insufficientData && !forced) return { score: 0, band: 'gris', reasons: sorted };
  const raw = reasons.reduce((sum, r) => sum + r.points, 0);
  const max = maxPoints(opts.weights) || 1;
  const score = Math.min(100, Math.round((100 * raw) / max));
  let band: Band;
  if (forced || score >= opts.bands.rojo) band = 'rojo';
  else if (score >= opts.bands.amarillo) band = 'amarillo';
  else band = 'verde';
  return { score, band, reasons: sorted };
}
