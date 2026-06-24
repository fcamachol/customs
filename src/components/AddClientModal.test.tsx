// src/components/AddClientModal.test.tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AddClientModal } from './AddClientModal';
import { apiPost } from '../api';

vi.mock('../api', () => ({ apiPost: vi.fn() }));

beforeEach(() => vi.clearAllMocks());

describe('AddClientModal', () => {
  it('does not POST when name is empty', () => {
    render(<AddClientModal open onClose={() => {}} onCreated={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Guardar cliente/i }));
    expect(apiPost).not.toHaveBeenCalled();
    expect(screen.getByText(/nombre es requerido/i)).toBeTruthy();
  });

  it('POSTs only the client fields (no platform) and returns the created client', async () => {
    (apiPost as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'c1', name: 'ACME' });
    const onCreated = vi.fn();
    const onClose = vi.fn();
    render(<AddClientModal open onClose={onClose} onCreated={onCreated} />);

    fireEvent.change(screen.getByLabelText('Nombre / razón social'), { target: { value: 'ACME' } });
    fireEvent.change(screen.getByLabelText('Id fiscal'), { target: { value: 'ACM010101AAA' } });
    fireEvent.click(screen.getByRole('button', { name: /Guardar cliente/i }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ id: 'c1', name: 'ACME' }));
    expect(apiPost).toHaveBeenCalledWith('/api/catalogs/clients', expect.objectContaining({
      name: 'ACME',
      tax_id: 'ACM010101AAA',
    }));
    // Platforms are added later, from the client detail modal — not at creation.
    expect(apiPost).toHaveBeenCalledWith('/api/catalogs/clients', expect.not.objectContaining({
      platform: expect.anything(),
    }));
    expect(onClose).toHaveBeenCalled();
  });
});
