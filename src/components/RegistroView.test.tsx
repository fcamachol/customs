// src/components/RegistroView.test.tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import RegistroView from './RegistroView';
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

beforeEach(() => {
  vi.clearAllMocks();
  mGet.mockResolvedValue([{ id: 'c1', name: 'ACME' }]);
  mExtract.mockResolvedValue({ mawb: '369-94705516', ambiguous: false });
});

function selectFile() {
  const input = document.getElementById('manifest-file') as HTMLInputElement;
  const file = new File(['x'], 'm.xlsx');
  fireEvent.change(input, { target: { files: [file] } });
}

describe('RegistroView', () => {
  it('starts on the upload step without a MAWB field', () => {
    render(<RegistroView />);
    expect(screen.getByText(/Cargar manifiesto/i)).toBeTruthy();
    expect(screen.queryByLabelText('MAWB')).toBeNull();
  });

  it('does not render any tax/liquidación figure (PRD §10)', () => {
    render(<RegistroView />);
    expect(screen.queryByText(/Liquidaci[oó]n/i)).toBeNull();
    expect(screen.queryByText(/\bIGI\b|\bIVA\b|\bDTA\b/)).toBeNull();
  });

  it('extracts and pre-fills the MAWB after selecting a file', async () => {
    render(<RegistroView />);
    selectFile();
    fireEvent.click(await screen.findByRole('button', { name: /Continuar/i }));
    const mawb = await screen.findByLabelText('MAWB');
    await waitFor(() => expect((mawb as HTMLInputElement).value).toBe('369-94705516'));
  });

  it('keeps "Realizar análisis" disabled until a client is selected', async () => {
    render(<RegistroView />);
    selectFile();
    fireEvent.click(await screen.findByRole('button', { name: /Continuar/i }));
    const analyze = await screen.findByRole('button', { name: /Realizar an[aá]lisis/i });
    expect((analyze as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(await screen.findByLabelText('Cliente'), { target: { value: 'c1' } });
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

    render(<RegistroView />);
    selectFile();
    fireEvent.click(await screen.findByRole('button', { name: /Continuar/i }));
    fireEvent.change(await screen.findByLabelText('Cliente'), { target: { value: 'c1' } });
    fireEvent.click(screen.getByRole('button', { name: /Realizar an[aá]lisis/i }));

    await waitFor(() => expect(mPost).toHaveBeenCalledWith('/api/manifests/m1/risk', {}));
    const paths = mPost.mock.calls.map((c) => c[0]);
    expect(paths).toEqual([
      '/api/manifests/m1/client',
      '/api/manifests/m1/promote',
      '/api/manifests/m1/risk',
    ]);
    expect(mUpload).toHaveBeenCalledWith('/api/manifests', expect.any(FormData));
    // Verify FormData contents: clientName and mawbReference must reach the upload
    const fd = mUpload.mock.calls[0][1] as FormData;
    expect(fd.get('clientName')).toBe('ACME');
    expect(fd.get('mawbReference')).toBe('369-94705516');
  });
});
