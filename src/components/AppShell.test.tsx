import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AppShell } from './AppShell';

describe('AppShell', () => {
  it('renders the six section labels', () => {
    render(<AppShell role="capturista" onSelect={() => {}} active="registro" />);
    for (const label of ['Realizar Registro', 'Seguimiento', 'Reporte General', 'Consulta', 'Dashboard', 'Acerca de']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });
});
