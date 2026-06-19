// src/components/ReporteGeneralView.test.tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ReporteGeneralView from './ReporteGeneralView';

const mockApiGet = vi.fn((_path: string) => Promise.resolve([]));
const mockApiPost = vi.fn((_path: string, _body: unknown) => Promise.resolve({ id: 'client-uuid-1' }));
const mockApiDownload = vi.fn((_path: string, _filename: string) => Promise.resolve());

vi.mock('../api', () => ({
  apiGet: (path: string) => mockApiGet(path),
  apiPost: (path: string, body: unknown) => mockApiPost(path, body),
  apiDownload: (path: string, filename: string) => mockApiDownload(path, filename),
}));

describe('ReporteGeneralView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiGet.mockResolvedValue([]);
    mockApiPost.mockResolvedValue({ id: 'client-uuid-1' });
    mockApiDownload.mockResolvedValue(undefined);
  });

  it('renders remitente and plataforma field groups', () => {
    render(<ReporteGeneralView />);
    expect(screen.getByText('Datos del Remitente')).toBeTruthy();
    expect(screen.getByText('Datos de la Plataforma')).toBeTruthy();
  });

  it('does not show Vista previa banners', () => {
    render(<ReporteGeneralView />);
    expect(screen.queryByText(/Vista previa/)).toBeNull();
  });

  it('fires create→link→download sequence on Generar Reporte when a record is selected', async () => {
    // Seed a record to select
    const record = { id: 'manifest-abc', mawbReference: 'MAW001', clientName: 'Acme', createdAt: '2024-01-01' };
    mockApiGet.mockResolvedValueOnce([record]);

    render(<ReporteGeneralView />);

    // Search for a record
    const searchInput = screen.getByPlaceholderText('Buscar registro por MAWB o cliente');
    fireEvent.change(searchInput, { target: { value: 'MAW001' } });
    const searchBtn = screen.getByRole('button', { name: /buscar/i });
    fireEvent.click(searchBtn);

    // Wait for results to appear
    await waitFor(() => screen.getByText('MAW001'));

    // Select the record
    const recordBtn = screen.getByText('MAW001').closest('button')!;
    fireEvent.click(recordBtn);

    // Now click Generar Reporte
    const generateBtn = screen.getByRole('button', { name: /generar reporte/i });
    fireEvent.click(generateBtn);

    // Wait for async operations
    await waitFor(() => {
      expect(mockApiPost).toHaveBeenCalledTimes(2);
    });

    // First call: create client
    expect(mockApiPost).toHaveBeenNthCalledWith(1, '/api/catalogs/clients', expect.objectContaining({ name: expect.any(String) }));
    // Second call: link client to manifest
    expect(mockApiPost).toHaveBeenNthCalledWith(2, '/api/manifests/manifest-abc/client', { clientId: 'client-uuid-1' });
    // Third: download
    expect(mockApiDownload).toHaveBeenCalledWith('/api/records/manifest-abc/report.xlsx', 'Reporte_General.xlsx');
  });
});
