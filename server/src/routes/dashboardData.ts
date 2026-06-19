export type Distribution = { verde: number; amarillo: number; rojo: number };

export function mergeDistribution(rows: { risk_color: string; n: number }[]): Distribution {
  const d: Distribution = { verde: 0, amarillo: 0, rojo: 0 };
  for (const r of rows) if (r.risk_color in d) d[r.risk_color as keyof Distribution] = r.n;
  return d;
}

export function buildDashboardResponse(input: {
  manifests: number;
  distRows: { risk_color: string; n: number }[];
  byUserRows?: { userId: string; username: string; manifests: number; risk_color: string | null; n: number }[];
}): { manifests: number; distribution: Distribution; byUser?: { userId: string; username: string; manifests: number; distribution: Distribution }[] } {
  const base = { manifests: input.manifests, distribution: mergeDistribution(input.distRows) };
  if (!input.byUserRows) return base;
  const map = new Map<string, { userId: string; username: string; manifests: number; distribution: Distribution }>();
  for (const row of input.byUserRows) {
    let u = map.get(row.userId);
    if (!u) { u = { userId: row.userId, username: row.username, manifests: row.manifests, distribution: { verde: 0, amarillo: 0, rojo: 0 } }; map.set(row.userId, u); }
    if (row.risk_color && row.risk_color in u.distribution) u.distribution[row.risk_color as keyof Distribution] = row.n;
  }
  return { ...base, byUser: Array.from(map.values()) };
}
