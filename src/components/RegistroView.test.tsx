import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import RegistroView from './RegistroView';

describe('RegistroView', () => {
  it('starts on Paso 1 with the manifest upload control', () => {
    render(<RegistroView />);
    expect(screen.getByText(/Paso 1|Cargar manifiesto/i)).toBeTruthy();
    expect(screen.getByText('MAWB')).toBeTruthy();
  });

  it('does not render any tax/liquidación figure (PRD §10 — no contribution calculation)', () => {
    render(<RegistroView />);
    expect(screen.queryByText(/Liquidaci[oó]n/i)).toBeNull();
    expect(screen.queryByText(/\bIGI\b|\bIVA\b|\bDTA\b/)).toBeNull();
  });
});
