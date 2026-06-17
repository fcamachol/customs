import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import RegistroView from './RegistroView';

describe('RegistroView', () => {
  it('renders the form fields and submit button', () => {
    render(<RegistroView />);
    expect(screen.getByLabelText('MAWB')).toBeTruthy();
    expect(screen.getByLabelText('Cliente')).toBeTruthy();
    expect(screen.getByLabelText('Manifiesto')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Realizar análisis de Riesgo' })).toBeTruthy();
  });
});
