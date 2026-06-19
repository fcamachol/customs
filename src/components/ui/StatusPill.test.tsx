import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusPill } from './StatusPill';

describe('StatusPill', () => {
  it('renders the resultado label capitalized by default', () => {
    render(<StatusPill resultado="verde" />);
    expect(screen.getByText('Verde')).toBeTruthy();
  });
  it('uses a custom label when provided', () => {
    render(<StatusPill resultado="rojo" label="Artículos prohibidos" />);
    expect(screen.getByText('Artículos prohibidos')).toBeTruthy();
  });
});
