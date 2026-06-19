// src/components/Sidebar.test.tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Sidebar } from './Sidebar';

describe('Sidebar', () => {
  it('shows all sections for admin including Dashboard first', () => {
    render(<Sidebar role="admin" active="dashboard" onSelect={() => {}} username="Ana" onLogout={() => {}} />);
    for (const label of ['Dashboard', 'Realizar Registro', 'Seguimiento', 'Reporte General', 'Consulta', 'Acerca de']) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy();
    }
  });

  it('hides write-flows for autoridad', () => {
    render(<Sidebar role="autoridad" active="dashboard" onSelect={() => {}} username="Inspector" onLogout={() => {}} />);
    expect(screen.getByRole('button', { name: 'Dashboard' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Realizar Registro' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reporte General' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Seguimiento' })).toBeNull();
  });
});
