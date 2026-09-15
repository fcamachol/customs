import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ClienteConvenios } from './ClienteConvenios';

vi.mock('../api', () => ({
  apiGet: vi.fn(),
  apiUpload: vi.fn(),
  apiDownload: vi.fn(),
}));
import { apiGet } from '../api';
const apiGetMock = vi.mocked(apiGet);

describe('ClienteConvenios', () => {
  beforeEach(() => vi.clearAllMocks());

  it('pide los convenios del cliente que se le pasa', async () => {
    apiGetMock.mockResolvedValue([]);
    render(<ClienteConvenios clientId="cli-1" isAdmin />);
    await waitFor(() => expect(apiGetMock).toHaveBeenCalledWith('/api/convenios?clientId=cli-1'));
  });

  // El vacío tiene que explicar POR QUÉ importa, no sólo decir que no hay nada: es el argumento
  // que Roberto dio en la junta para pedir esta pantalla.
  it('el estado vacío dice para qué sirven los contratos', async () => {
    apiGetMock.mockResolvedValue([]);
    render(<ClienteConvenios clientId="cli-1" isAdmin />);
    await waitFor(() => expect(screen.getByText(/La autoridad puede pedirlos/i)).toBeTruthy());
  });

  it('lista los contratos con su vigencia y estado de firma', async () => {
    apiGetMock.mockResolvedValue([
      { id: 'c1', fileId: 'f1', vigenciaDesde: '2026-01-01', vigenciaHasta: '2026-12-31', estadoFirma: 'firmado', firmadoAt: null },
    ]);
    render(<ClienteConvenios clientId="cli-1" isAdmin />);
    await waitFor(() => expect(screen.getByText('firmado')).toBeTruthy());
    expect(screen.getByText(/Vigencia/)).toBeTruthy();
  });

  it('sin permisos de admin no ofrece cargar', async () => {
    apiGetMock.mockResolvedValue([]);
    render(<ClienteConvenios clientId="cli-1" isAdmin={false} />);
    await waitFor(() => expect(apiGetMock).toHaveBeenCalled());
    expect(screen.queryByText(/Cargar contrato/i)).toBeNull();
  });
});
