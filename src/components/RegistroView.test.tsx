import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import RegistroView from './RegistroView';

describe('RegistroView', () => {
  it('starts on Paso 1 with the manifest upload control', () => {
    render(<RegistroView />);
    expect(screen.getByText(/Paso 1|Cargar manifiesto/i)).toBeTruthy();
    expect(screen.getByText('MAWB')).toBeTruthy();
  });
});
