import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { AcercaDeView } from './AcercaDeView';

vi.mock('../api', () => ({
  apiGet: vi.fn(async () => ({
    key: 'branding',
    value: { companyName: 'Capital Centennials', rfc: 'CAP010101CAP' },
  })),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiDownload: vi.fn(),
}));

beforeEach(() => vi.clearAllMocks());

describe('AcercaDeView', () => {
  it('renders company name from branding config', async () => {
    render(<AcercaDeView />);
    await waitFor(() => expect(screen.getByText('Capital Centennials')).toBeTruthy());
  });

  it('renders RFC from branding config', async () => {
    render(<AcercaDeView />);
    await waitFor(() => expect(screen.getByText(/CAP010101CAP/i)).toBeTruthy());
  });

  it('renders marco legal section', async () => {
    render(<AcercaDeView />);
    expect(screen.getByText(/Marco Legal/i)).toBeTruthy();
    expect(screen.getByText(/Ley Aduanera/i)).toBeTruthy();
    expect(screen.getByText(/RGCE 3\.7\.35/i)).toBeTruthy();
  });

  it('renders misión, visión, valores headings', () => {
    render(<AcercaDeView />);
    // Use getAllByText since the heading text may also appear in body paragraphs
    expect(screen.getAllByText(/Misión/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Visión/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Valores/i).length).toBeGreaterThan(0);
  });

  it('falls back to static RFC default when API fails', async () => {
    const { apiGet } = await import('../api');
    vi.mocked(apiGet).mockRejectedValueOnce(new Error('network'));
    render(<AcercaDeView />);
    // Should still render RFC with fallback
    await waitFor(() => expect(screen.getByText(/RFC:/i)).toBeTruthy());
    expect(screen.getByText(/CAP010101CAP/i)).toBeTruthy();
  });
});
