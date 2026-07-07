// src/components/RegistroView.test.tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import RegistroView from './RegistroView';
import { AuthProvider } from '../context/AuthContext';
import { apiGet, apiPost, apiUpload } from '../api';
import { extractMawb } from '../lib/extractMawb';

vi.mock('../api', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiUpload: vi.fn(),
}));
vi.mock('../lib/extractMawb', () => ({ extractMawb: vi.fn() }));

const mGet = apiGet as ReturnType<typeof vi.fn>;
const mPost = apiPost as ReturnType<typeof vi.fn>;
const mUpload = apiUpload as ReturnType<typeof vi.fn>;
const mExtract = extractMawb as ReturnType<typeof vi.fn>;

const CLIENTS = [{ id: 'c1', name: 'ACME', platforms: [{ id: 'p1', commercialName: 'Plat A' }] }];

// Route the shared apiGet mock: AuthProvider hits /api/auth/me, RegistroView hits /clients.
function mockUser(role: 'capturista' | 'admin' | 'super_admin' | null) {
  if (role) localStorage.setItem('token', 't'); else localStorage.removeItem('token');
  mGet.mockImplementation(async (path: string) => {
    if (path.includes('/api/auth/me')) return { id: 'u1', username: 'u', role };
    return CLIENTS;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mockUser('capturista'); // default: non-admin, so the mapping panel stays hidden
  mExtract.mockResolvedValue({ mawb: '369-94705516', ambiguous: false });
});

function renderView() {
  return render(<AuthProvider><RegistroView /></AuthProvider>);
}

function selectFile() {
  const input = document.getElementById('manifest-file') as HTMLInputElement;
  const file = new File(['x'], 'm.xlsx');
  fireEvent.change(input, { target: { files: [file] } });
}

// SearchSelect is a typeahead combobox: focus opens it, click the option to commit.
function pickOption(labelText: string, optionLabel: string) {
  fireEvent.focus(screen.getByLabelText(labelText));
  fireEvent.click(screen.getByText(optionLabel));
}

describe('RegistroView', () => {
  it('starts on the upload step without a MAWB field', () => {
    renderView();
    expect(screen.getByText(/Cargar manifiesto/i)).toBeTruthy();
    expect(screen.queryByLabelText('MAWB')).toBeNull();
  });

  it('does not render any tax/liquidación figure (PRD §10)', () => {
    renderView();
    expect(screen.queryByText(/Liquidaci[oó]n/i)).toBeNull();
    expect(screen.queryByText(/\bIGI\b|\bIVA\b|\bDTA\b/)).toBeNull();
  });

  it('extracts and pre-fills the MAWB after selecting a file', async () => {
    renderView();
    selectFile();
    fireEvent.click(await screen.findByRole('button', { name: /Continuar/i }));
    const mawb = await screen.findByLabelText('MAWB');
    await waitFor(() => expect((mawb as HTMLInputElement).value).toBe('369-94705516'));
  });

  it('keeps "Realizar análisis" disabled until both client and platform are selected', async () => {
    renderView();
    selectFile();
    fireEvent.click(await screen.findByRole('button', { name: /Continuar/i }));
    const analyze = await screen.findByRole('button', { name: /Realizar an[aá]lisis/i });
    expect((analyze as HTMLButtonElement).disabled).toBe(true);
    await screen.findByLabelText('Cliente');
    pickOption('Cliente', 'ACME');
    // Still disabled with no platform chosen.
    await waitFor(() => expect((analyze as HTMLButtonElement).disabled).toBe(true));
    pickOption('Plataforma', 'Plat A');
    await waitFor(() => expect((analyze as HTMLButtonElement).disabled).toBe(false));
  });

  it('submits in order: upload, client link, promote, risk', async () => {
    mUpload.mockResolvedValue({
      manifestId: 'm1', ingestionStatus: 'staged',
      counts: { total: 1, valid: 1, warning: 0, error: 0 },
      rejected: [], warnings: [], unmappedHeaders: [], duplicateHeaders: [],
    });
    mPost.mockImplementation(async (path: string) => {
      if (path.endsWith('/risk')) return { rows: [], summary: { total: 0 } };
      return { ok: true };
    });

    renderView();
    selectFile();
    fireEvent.click(await screen.findByRole('button', { name: /Continuar/i }));
    await screen.findByLabelText('Cliente');
    pickOption('Cliente', 'ACME');
    pickOption('Plataforma', 'Plat A');
    fireEvent.click(screen.getByRole('button', { name: /Realizar an[aá]lisis/i }));

    await waitFor(() => expect(mPost).toHaveBeenCalledWith('/api/manifests/m1/risk', {}));
    const paths = mPost.mock.calls.map((c) => c[0]);
    expect(paths).toEqual([
      '/api/manifests/m1/client',
      '/api/manifests/m1/promote',
      '/api/manifests/m1/risk',
    ]);
    // Client link carries both the selected client and platform.
    expect(mPost).toHaveBeenCalledWith('/api/manifests/m1/client', { clientId: 'c1', platformId: 'p1' });
    expect(mUpload).toHaveBeenCalledWith('/api/manifests', expect.any(FormData));
    // Verify FormData contents: clientName, clientId and mawbReference must reach the upload
    const fd = mUpload.mock.calls[0][1] as FormData;
    expect(fd.get('clientName')).toBe('ACME');
    expect(fd.get('clientId')).toBe('c1');
    expect(fd.get('mawbReference')).toBe('369-94705516');
  });
});

// Drive the wizard through client/platform selection to the point the upload fires.
async function analyzeWith(uploadResponse: Record<string, unknown>) {
  mUpload.mockResolvedValue(uploadResponse);
  mPost.mockImplementation(async (path: string) => {
    if (path.endsWith('/risk')) return { rows: [], summary: { total: 0 } };
    return { ok: true };
  });
  selectFile();
  fireEvent.click(await screen.findByRole('button', { name: /Continuar/i }));
  await screen.findByLabelText('Cliente');
  pickOption('Cliente', 'ACME');
  pickOption('Plataforma', 'Plat A');
  fireEvent.click(screen.getByRole('button', { name: /Realizar an[aá]lisis/i }));
}

const UNMAPPED_ERR = {
  manifestId: 'm1', ingestionStatus: 'staged',
  counts: { total: 1, valid: 0, warning: 0, error: 1 },
  rejected: [{ rowIndex: 0, field: 'description', message: 'Descripción requerida' }],
  warnings: [], unmappedHeaders: ['Detalle Mercancía'], duplicateHeaders: [],
};

describe('RegistroView per-client header mapping panel', () => {
  it('hides the mapping panel for a non-admin (but still shows the unmapped banner)', async () => {
    mockUser('capturista');
    renderView();
    await analyzeWith(UNMAPPED_ERR);
    await waitFor(() => expect(screen.getByText(/Columnas no mapeadas/)).toBeTruthy());
    expect(screen.queryByText(/Mapear columnas no reconocidas/)).toBeNull();
  });

  it('lets an admin save a per-client mapping for an unmapped header', async () => {
    mockUser('admin');
    renderView();
    await analyzeWith(UNMAPPED_ERR);
    await screen.findByText(/Mapear columnas no reconocidas/);

    // Pick a canonical path in the mapping combobox, then save.
    const combo = screen.getByRole('combobox');
    fireEvent.focus(combo);
    fireEvent.change(combo, { target: { value: 'core.description' } });
    fireEvent.click(screen.getByText('core.description'));
    fireEvent.click(screen.getByRole('button', { name: /Guardar/i }));

    await waitFor(() =>
      expect(mPost).toHaveBeenCalledWith('/api/header-mappings', {
        clientId: 'c1', header: 'Detalle Mercancía', canonicalPath: 'core.description',
      }),
    );
    // Button flips to "Guardado" after a successful save.
    await screen.findByRole('button', { name: /Guardado/i });
  });

  it('saves globally (clientId null) when the Global scope is chosen', async () => {
    mockUser('admin');
    renderView();
    await analyzeWith(UNMAPPED_ERR);
    await screen.findByText(/Mapear columnas no reconocidas/);

    fireEvent.click(screen.getByRole('button', { name: /Global/i }));
    const combo = screen.getByRole('combobox');
    fireEvent.focus(combo);
    fireEvent.change(combo, { target: { value: 'core.description' } });
    fireEvent.click(screen.getByText('core.description'));
    fireEvent.click(screen.getByRole('button', { name: /^Guardar$/i }));

    await waitFor(() =>
      expect(mPost).toHaveBeenCalledWith('/api/header-mappings', {
        clientId: null, header: 'Detalle Mercancía', canonicalPath: 'core.description',
      }),
    );
  });
});

describe('RegistroView multi-sheet info line', () => {
  it('reports which sheet was processed and which were skipped', async () => {
    mockUser('capturista');
    renderView();
    await analyzeWith({
      ...UNMAPPED_ERR, unmappedHeaders: [],
      sheetName: 'Datos', skippedSheets: ['Instrucciones', 'Notas'],
    });
    await waitFor(() =>
      expect(screen.getByText(/se procesó «Datos»/)).toBeTruthy(),
    );
    expect(screen.getByText(/Instrucciones, Notas/)).toBeTruthy();
  });
});
