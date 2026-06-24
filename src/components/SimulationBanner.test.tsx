import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SimulationBanner } from './SimulationBanner';

describe('SimulationBanner', () => {
  it('renders the simulation notice', () => {
    render(<SimulationBanner />);
    expect(screen.getByTestId('simulation-banner')).toBeTruthy();
  });

  it('states documents are pre-validation only', () => {
    render(<SimulationBanner />);
    expect(screen.getByText(/Modo simulacion \/ pre-validacion/i)).toBeTruthy();
  });

  it('states documents are NOT legally submittable', () => {
    render(<SimulationBanner />);
    expect(screen.getByText(/NO son legalmente presentables ante el SAT\/VUCEM/i)).toBeTruthy();
  });

  it('mentions FIEL/e.firma signing requirement', () => {
    render(<SimulationBanner />);
    expect(screen.getByText(/FIEL\/e\.firma/i)).toBeTruthy();
  });

  it('mentions SAT/VUCEM transmission requirement', () => {
    render(<SimulationBanner />);
    expect(screen.getAllByText(/SAT\/VUCEM/i).length).toBeGreaterThan(0);
  });
});
