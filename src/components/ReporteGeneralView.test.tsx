// src/components/ReporteGeneralView.test.tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import ReporteGeneralView from './ReporteGeneralView';

vi.mock('../api', () => ({
  apiGet: vi.fn(() => Promise.resolve([])),
  apiDownload: vi.fn(),
}));

describe('ReporteGeneralView', () => {
  it('renders remitente and plataforma field groups', () => {
    render(<ReporteGeneralView />);
    expect(screen.getByText('Datos del Remitente')).toBeTruthy();
    expect(screen.getByText('Datos de la Plataforma')).toBeTruthy();
  });
});
