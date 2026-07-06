// src/components/DashboardView.test.tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import DashboardView from './DashboardView';

vi.mock('../api', () => ({
  apiGet: vi.fn((path: string) =>
    path.startsWith('/api/dashboard')
      ? Promise.resolve({ manifests: 2, distribution: { verde: 9, amarillo: 1, rojo: 2, gris: 0 },
          byUser: [{ userId: 'u1', username: 'Ana', manifests: 2, distribution: { verde: 9, amarillo: 1, rojo: 2, gris: 0 } }] })
      : Promise.resolve([{ id: 'r1', mawbReference: '369-94705516', clientName: 'Cliente X', createdAt: '2026-06-19' }])),
}));

describe('DashboardView', () => {
  beforeEach(() => vi.clearAllMocks());
  it('renders KPI totals and per-user performance', async () => {
    render(<DashboardView />);
    await waitFor(() => expect(screen.getByText('369-94705516')).toBeTruthy());
    expect(screen.getByText('Ana')).toBeTruthy();      // desempeño por usuario
    expect(screen.getByText(/Registros/i)).toBeTruthy();// KPI label
  });
});
