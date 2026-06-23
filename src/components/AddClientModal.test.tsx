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

  it('POSTs the ANAM fields and returns the created client', async () => {
    (apiPost as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'c1', name: 'ACME' });
    const onCreated = vi.fn();
    const onClose = vi.fn();
    render(<AddClientModal open onClose={onClose} onCreated={onCreated} />);

    fireEvent.change(screen.getByLabelText('Nombre / razón social'), { target: { value: 'ACME' } });
    fireEvent.change(screen.getByLabelText('Plataforma — País de origen'), { target: { value: 'CN' } });
    fireEvent.click(screen.getByRole('button', { name: /Guardar cliente/i }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ id: 'c1', name: 'ACME' }));
    expect(apiPost).toHaveBeenCalledWith('/api/catalogs/clients', expect.objectContaining({
      name: 'ACME',
      platform: expect.objectContaining({ countryOfOrigin: 'CN' }),
    }));
    expect(onClose).toHaveBeenCalled();
  });
});
