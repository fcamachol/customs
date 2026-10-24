import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { ClienteDirecciones } from './ClienteDirecciones';

/**
 * DIRECCIONES DE ENTREGA: el catálogo tenía CRUD completo en el servidor y ninguna pantalla, así
 * que no se podía dar de alta el almacén destino de un cliente — la planeación sólo podía elegir
 * entre lo que ya estuviera sembrado en base.
 *
 * Los dos comportamientos que importan y que estas pruebas fijan:
 *  - crear OMITE los opcionales vacíos; editar los manda como null. Crear sin dato es "no lo sé
 *    todavía"; editar a vacío es "bórralo", y el backend distingue null de ausente.
 *  - la baja DESACTIVA, no borra: los despachos y planes publicados nombran la dirección.
 */
vi.mock('../api', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(async () => ({})),
  apiPut: vi.fn(async () => ({})),
  apiDelete: vi.fn(async () => ({})),
}));

const DIR = {
  id: 'd1', alias: 'IMILE Cuautitlán', direccion: 'Parque Logístico 100',
  ciudad: 'Cuautitlán', estado: 'MEX', cp: '54800',
  contactoNombre: 'Ana', contactoTelefono: '5511', horario: '9-18', activo: true,
};

beforeEach(() => vi.clearAllMocks());

describe('ClienteDirecciones', () => {
  it('lista las direcciones del cliente', async () => {
    const { apiGet } = await import('../api');
    vi.mocked(apiGet).mockResolvedValue([DIR]);
    render(<ClienteDirecciones clientId="cl1" isAdmin onToast={() => {}} />);
    await waitFor(() => expect(screen.getByText('IMILE Cuautitlán')).toBeTruthy());
    expect(screen.getByText(/Parque Logístico 100/)).toBeTruthy();
  });

  it('al crear, omite los opcionales vacíos en vez de mandarlos como cadena vacía', async () => {
    const { apiGet, apiPost } = await import('../api');
    vi.mocked(apiGet).mockResolvedValue([]);
    render(<ClienteDirecciones clientId="cl1" isAdmin onToast={() => {}} />);

    await waitFor(() => expect(screen.getByRole('button', { name: /agregar dirección/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /agregar dirección/i }));
    fireEvent.change(screen.getByLabelText('Alias *'), { target: { value: 'Almacén Norte' } });
    fireEvent.change(screen.getByLabelText('Ciudad'), { target: { value: 'Monterrey' } });
    fireEvent.click(screen.getByRole('button', { name: /guardar dirección/i }));

    await waitFor(() => {
      expect(vi.mocked(apiPost)).toHaveBeenCalledWith(
        '/api/catalogs/clients/cl1/direcciones',
        { alias: 'Almacén Norte', ciudad: 'Monterrey' },
      );
    });
  });

  it('al editar, un campo vaciado viaja como null para poder borrarlo', async () => {
    const { apiGet, apiPut } = await import('../api');
    vi.mocked(apiGet).mockResolvedValue([DIR]);
    render(<ClienteDirecciones clientId="cl1" isAdmin onToast={() => {}} />);

    await waitFor(() => expect(screen.getByText('IMILE Cuautitlán')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /^editar$/i }));
    fireEvent.change(screen.getByLabelText('Horario de recepción'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /guardar cambios/i }));

    await waitFor(() => {
      expect(vi.mocked(apiPut)).toHaveBeenCalledWith(
        '/api/catalogs/clients/cl1/direcciones/d1',
        expect.objectContaining({ horario: null }),
      );
    });
  });

  it('la baja desactiva: ofrece «Desactivar», no «Eliminar»', async () => {
    const { apiGet, apiDelete } = await import('../api');
    vi.mocked(apiGet).mockResolvedValue([DIR]);
    render(<ClienteDirecciones clientId="cl1" isAdmin onToast={() => {}} />);

    await waitFor(() => expect(screen.getByText('IMILE Cuautitlán')).toBeTruthy());
    expect(screen.queryByRole('button', { name: /eliminar/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /desactivar la dirección/i }));
    await waitFor(() => {
      expect(vi.mocked(apiDelete)).toHaveBeenCalledWith('/api/catalogs/clients/cl1/direcciones/d1');
    });
  });

  it('una dirección inactiva sigue visible y se puede reactivar', async () => {
    const { apiGet, apiPut } = await import('../api');
    vi.mocked(apiGet).mockResolvedValue([{ ...DIR, activo: false }]);
    render(<ClienteDirecciones clientId="cl1" isAdmin onToast={() => {}} />);

    await waitFor(() => expect(screen.getByText(/inactiva/i)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /reactivar la dirección/i }));
    await waitFor(() => {
      expect(vi.mocked(apiPut)).toHaveBeenCalledWith(
        '/api/catalogs/clients/cl1/direcciones/d1', { activo: true },
      );
    });
  });

  it('sin permisos de admin no ofrece acciones de escritura', async () => {
    const { apiGet } = await import('../api');
    vi.mocked(apiGet).mockResolvedValue([DIR]);
    render(<ClienteDirecciones clientId="cl1" isAdmin={false} onToast={() => {}} />);
    await waitFor(() => expect(screen.getByText('IMILE Cuautitlán')).toBeTruthy());
    expect(screen.queryByRole('button', { name: /agregar dirección/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /desactivar/i })).toBeNull();
  });
});
