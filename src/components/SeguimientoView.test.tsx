import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import SeguimientoView from './SeguimientoView';

vi.mock('../api', () => ({
  apiGet: vi.fn(() => Promise.resolve([])),
  apiPost: vi.fn(() => Promise.resolve({ ok: true })),
  apiDownload: vi.fn(() => Promise.resolve()),
}));

describe('SeguimientoView', () => {
  it('renders the two work-queue tabs, the filter field and pedimento capture labels', () => {
    render(<SeguimientoView />);
    expect(screen.getByText('Sin pedimento')).toBeTruthy();
    expect(screen.getByText('Con pedimento')).toBeTruthy();
    expect(screen.getByPlaceholderText(/Filtrar/i)).toBeTruthy();
    expect(screen.getByText('Pedimento')).toBeTruthy();
    expect(screen.getByText('Agente Aduanal')).toBeTruthy();
  });
});
