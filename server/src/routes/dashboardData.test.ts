import { describe, expect, it } from 'vitest';
import { mergeDistribution, buildDashboardResponse } from './dashboardData';

describe('mergeDistribution', () => {
  it('fills missing colors with zero', () => {
    expect(mergeDistribution([{ risk_color: 'verde', n: 5 }, { risk_color: 'rojo', n: 2 }]))
      .toEqual({ verde: 5, amarillo: 0, rojo: 2 });
  });
});

describe('buildDashboardResponse', () => {
  it('omits byUser when no byUserRows', () => {
    const r = buildDashboardResponse({ manifests: 3, distRows: [{ risk_color: 'verde', n: 9 }] });
    expect(r).toEqual({ manifests: 3, distribution: { verde: 9, amarillo: 0, rojo: 0 } });
    expect(r.byUser).toBeUndefined();
  });
  it('groups per-user distributions and manifest counts', () => {
    const r = buildDashboardResponse({
      manifests: 2,
      distRows: [{ risk_color: 'verde', n: 4 }, { risk_color: 'rojo', n: 1 }],
      byUserRows: [
        { userId: 'u1', username: 'Ana', manifests: 1, risk_color: 'verde', n: 3 },
        { userId: 'u1', username: 'Ana', manifests: 1, risk_color: 'rojo', n: 1 },
        { userId: 'u2', username: 'Beto', manifests: 1, risk_color: 'verde', n: 1 },
      ],
    });
    expect(r.byUser).toEqual([
      { userId: 'u1', username: 'Ana', manifests: 1, distribution: { verde: 3, amarillo: 0, rojo: 1 } },
      { userId: 'u2', username: 'Beto', manifests: 1, distribution: { verde: 1, amarillo: 0, rojo: 0 } },
    ]);
  });
});
