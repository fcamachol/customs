import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import SeguimientoView from './SeguimientoView';

describe('SeguimientoView', () => {
  it('renders the search field and pedimento capture labels', () => {
    render(<SeguimientoView />);
    expect(screen.getByPlaceholderText(/Buscar/i)).toBeTruthy();
    expect(screen.getByText('Pedimento')).toBeTruthy();
    expect(screen.getByText('Agente Aduanal')).toBeTruthy();
  });
});
