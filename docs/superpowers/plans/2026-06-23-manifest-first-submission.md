# Manifest-First Submission Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorder `RegistroView` so the operator uploads the manifest first, the MAWB is auto-extracted from the file (editable), and a registered client is required before risk analysis runs — with an inline modal to add a new client.

**Architecture:** Pure-frontend change against existing endpoints. A new client-side helper extracts the MAWB from the workbook using the shared header resolver. `RegistroView` becomes a 4-step flow; a new reusable `Modal` hosts an `AddClientModal` form that posts the full ANAM client field set. Submit fans out to the existing manifest-upload → client-link → promote → risk endpoints.

**Tech Stack:** React 19, TypeScript, Vite, Tailwind, Vitest + Testing Library, `xlsx` (already a frontend dep), shared `shared/parsing/headerSynonyms`.

## Global Constraints

- No backend changes. Server-side MAWB derivation, schema changes, and joining `clients` in `records.ts` are out of scope.
- Spanish UI copy, matching existing `RegistroView` tone.
- Reuse existing `ui` primitives (`Button`, `Field`, `Input`, `Stepper`) and the `apiGet`/`apiPost`/`apiUpload` helpers from `src/api.ts`.
- `clientName` (free text) MUST still be sent on manifest upload — `records.ts` and report search read the `client_name` column for display/search. The `client_id` link is a separate call.
- Client required before analysis; MAWB required (editable, pre-filled from the file).
- The quick-add modal collects all ANAM client fields: `name` (required), `tax_id`, `address`, `phone`, `email`, and `platform.{commercialName, countryOfOrigin, legalName, email}`.

---

### Task 1: `extractMawb` client-side helper

**Files:**
- Create: `src/lib/extractMawb.ts`
- Test: `src/lib/extractMawb.test.ts`

**Interfaces:**
- Consumes: `resolveHeader` from `../../shared/parsing/headerSynonyms`; `xlsx`.
- Produces:
  ```ts
  export interface MawbExtraction { mawb: string | null; ambiguous: boolean }
  export function extractMawb(file: File): Promise<MawbExtraction>
  ```
  Semantics: read first sheet; find the column where `resolveHeader(header) === 'core.mawb'`. Exactly one distinct non-empty value → `{ mawb: value, ambiguous: false }`. Zero values or no column → `{ mawb: null, ambiguous: false }`. More than one distinct value → `{ mawb: null, ambiguous: true }`. Any parse error → `{ mawb: null, ambiguous: false }`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/extractMawb.test.ts
import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { extractMawb } from './extractMawb';

function makeFile(rows: unknown[][]): File {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  return new File([buf], 'm.xlsx', {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

describe('extractMawb', () => {
  it('returns the single MWB value when the column is uniform', async () => {
    const file = makeFile([['MWB', 'Codigo HS'], ['369-94705516', '1'], ['369-94705516', '2']]);
    expect(await extractMawb(file)).toEqual({ mawb: '369-94705516', ambiguous: false });
  });

  it('returns null without ambiguity when there is no MWB column', async () => {
    const file = makeFile([['Codigo HS', 'Divisa'], ['1', 'USD']]);
    expect(await extractMawb(file)).toEqual({ mawb: null, ambiguous: false });
  });

  it('flags ambiguous when the MWB column has multiple distinct values', async () => {
    const file = makeFile([['MWB'], ['369-1'], ['369-2']]);
    expect(await extractMawb(file)).toEqual({ mawb: null, ambiguous: true });
  });

  it('returns null on an unreadable file', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'bad.xlsx');
    expect(await extractMawb(file)).toEqual({ mawb: null, ambiguous: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/extractMawb.test.ts`
Expected: FAIL — cannot resolve `./extractMawb`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/extractMawb.ts
import * as XLSX from 'xlsx';
import { resolveHeader } from '../../shared/parsing/headerSynonyms';

export interface MawbExtraction {
  mawb: string | null;
  ambiguous: boolean;
}

export async function extractMawb(file: File): Promise<MawbExtraction> {
  try {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '', blankrows: false });
    const headerRow = (aoa[0] ?? []).map((h) => String(h ?? '').trim());
    const colIdx = headerRow.findIndex((h) => resolveHeader(h) === 'core.mawb');
    if (colIdx === -1) return { mawb: null, ambiguous: false };
    const distinct = new Set(
      aoa.slice(1).map((r) => String(r[colIdx] ?? '').trim()).filter(Boolean),
    );
    if (distinct.size === 1) return { mawb: [...distinct][0], ambiguous: false };
    if (distinct.size > 1) return { mawb: null, ambiguous: true };
    return { mawb: null, ambiguous: false };
  } catch {
    return { mawb: null, ambiguous: false };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/extractMawb.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/extractMawb.ts src/lib/extractMawb.test.ts
git commit -m "feat(registro): client-side MAWB extraction helper"
```

---

### Task 2: `Modal` reusable UI primitive

**Files:**
- Create: `src/components/ui/Modal.tsx`
- Modify: `src/components/ui/index.ts`
- Test: `src/components/ui/Modal.test.tsx`

**Interfaces:**
- Consumes: `lucide-react` `X` icon.
- Produces:
  ```ts
  export function Modal(props: {
    open: boolean;
    onClose: () => void;
    title: string;
    children: React.ReactNode;
  }): JSX.Element | null
  ```
  Renders nothing when `open` is false. When open: a backdrop (click closes), a `role="dialog" aria-modal="true"` panel with the title, and a close button (`aria-label="Cerrar"`). `Escape` closes.

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/ui/Modal.test.tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Modal } from './Modal';

describe('Modal', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <Modal open={false} onClose={() => {}} title="Nuevo">body</Modal>,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders title and content when open', () => {
    render(<Modal open onClose={() => {}} title="Nuevo cliente">contenido</Modal>);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('Nuevo cliente')).toBeTruthy();
    expect(screen.getByText('contenido')).toBeTruthy();
  });

  it('calls onClose when the close button is clicked', () => {
    const onClose = vi.fn();
    render(<Modal open onClose={onClose} title="X">y</Modal>);
    fireEvent.click(screen.getByLabelText('Cerrar'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/components/ui/Modal.test.tsx`
Expected: FAIL — cannot resolve `./Modal`.

- [ ] **Step 3: Write minimal implementation**

```tsx
// src/components/ui/Modal.tsx
import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { X } from 'lucide-react';

export function Modal({ open, onClose, title, children }: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/40" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative z-10 w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-xl border border-slate-200 bg-white p-6 shadow-xl"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-slate-800">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="rounded-lg p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
```

Then add to `src/components/ui/index.ts` (append after the existing exports):

```ts
export { Modal } from './Modal';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/components/ui/Modal.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/ui/Modal.tsx src/components/ui/index.ts src/components/ui/Modal.test.tsx
git commit -m "feat(ui): reusable Modal primitive"
```

---

### Task 3: `AddClientModal` (full ANAM client form)

**Files:**
- Create: `src/components/AddClientModal.tsx`
- Test: `src/components/AddClientModal.test.tsx`

**Interfaces:**
- Consumes: `apiPost` from `../api`; `Modal`, `Button`, `Field`, `Input` from `./ui`.
- Produces:
  ```ts
  export interface ClientPlatform { commercialName?: string; countryOfOrigin?: string; legalName?: string; email?: string }
  export interface Client { id: string; name: string; tax_id?: string; address?: string; phone?: string; email?: string; platform?: ClientPlatform }
  export function AddClientModal(props: {
    open: boolean;
    onClose: () => void;
    onCreated: (client: Client) => void;
  }): JSX.Element
  ```
  On submit: requires non-empty `name` (else inline error, no request). POSTs to `/api/catalogs/clients` with `{ name, tax_id, address, phone, email, platform: { commercialName, countryOfOrigin, legalName, email } }` (all trimmed), calls `onCreated` with the returned `Client`, resets the form, and calls `onClose`. On request error: shows the error message and keeps the modal open.

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/AddClientModal.test.tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AddClientModal } from './AddClientModal';
import { apiPost } from '../api';

vi.mock('../api', () => ({ apiPost: vi.fn() }));

beforeEach(() => vi.clearAllMocks());

describe('AddClientModal', () => {
  it('does not POST when name is empty', () => {
    render(<AddClientModal open onClose={() => {}} onCreated={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Guardar cliente/i }));
    expect(apiPost).not.toHaveBeenCalled();
    expect(screen.getByText(/nombre es requerido/i)).toBeTruthy();
  });

  it('POSTs the ANAM fields and returns the created client', async () => {
    (apiPost as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'c1', name: 'ACME' });
    const onCreated = vi.fn();
    const onClose = vi.fn();
    render(<AddClientModal open onClose={onClose} onCreated={onCreated} />);

    fireEvent.change(screen.getByLabelText('Nombre / razón social'), { target: { value: 'ACME' } });
    fireEvent.change(screen.getByLabelText('Plataforma — País de origen'), { target: { value: 'CN' } });
    fireEvent.click(screen.getByRole('button', { name: /Guardar cliente/i }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ id: 'c1', name: 'ACME' }));
    expect(apiPost).toHaveBeenCalledWith('/api/catalogs/clients', expect.objectContaining({
      name: 'ACME',
      platform: expect.objectContaining({ countryOfOrigin: 'CN' }),
    }));
    expect(onClose).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/components/AddClientModal.test.tsx`
Expected: FAIL — cannot resolve `./AddClientModal`.

- [ ] **Step 3: Write minimal implementation**

```tsx
// src/components/AddClientModal.tsx
import { useState } from 'react';
import { apiPost } from '../api';
import { Modal, Button, Field, Input } from './ui';

export interface ClientPlatform {
  commercialName?: string;
  countryOfOrigin?: string;
  legalName?: string;
  email?: string;
}

export interface Client {
  id: string;
  name: string;
  tax_id?: string;
  address?: string;
  phone?: string;
  email?: string;
  platform?: ClientPlatform;
}

const EMPTY = {
  name: '', tax_id: '', address: '', phone: '', email: '',
  commercialName: '', countryOfOrigin: '', legalName: '', platformEmail: '',
};

export function AddClientModal({ open, onClose, onCreated }: {
  open: boolean;
  onClose: () => void;
  onCreated: (client: Client) => void;
}) {
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof typeof EMPTY>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function close() {
    setForm(EMPTY);
    setError(null);
    onClose();
  }

  async function submit() {
    if (!form.name.trim()) { setError('El nombre es requerido.'); return; }
    setSaving(true);
    setError(null);
    try {
      const created = await apiPost<Client>('/api/catalogs/clients', {
        name: form.name.trim(),
        tax_id: form.tax_id.trim(),
        address: form.address.trim(),
        phone: form.phone.trim(),
        email: form.email.trim(),
        platform: {
          commercialName: form.commercialName.trim(),
          countryOfOrigin: form.countryOfOrigin.trim(),
          legalName: form.legalName.trim(),
          email: form.platformEmail.trim(),
        },
      });
      setForm(EMPTY);
      onCreated(created);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al crear el cliente.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={open} onClose={close} title="Nuevo cliente">
      {error && (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
          {error}
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Nombre / razón social" htmlFor="c-name">
          <Input id="c-name" value={form.name} onChange={(e) => set('name', e.target.value)} />
        </Field>
        <Field label="Id fiscal (RFC)" htmlFor="c-tax">
          <Input id="c-tax" value={form.tax_id} onChange={(e) => set('tax_id', e.target.value)} />
        </Field>
        <Field label="Domicilio" htmlFor="c-addr">
          <Input id="c-addr" value={form.address} onChange={(e) => set('address', e.target.value)} />
        </Field>
        <Field label="Teléfono" htmlFor="c-phone">
          <Input id="c-phone" value={form.phone} onChange={(e) => set('phone', e.target.value)} />
        </Field>
        <Field label="Correo" htmlFor="c-email">
          <Input id="c-email" type="email" value={form.email} onChange={(e) => set('email', e.target.value)} />
        </Field>
        <Field label="Plataforma — Nombre comercial" htmlFor="c-pcomm">
          <Input id="c-pcomm" value={form.commercialName} onChange={(e) => set('commercialName', e.target.value)} />
        </Field>
        <Field label="Plataforma — País de origen" htmlFor="c-pcountry">
          <Input id="c-pcountry" value={form.countryOfOrigin} onChange={(e) => set('countryOfOrigin', e.target.value)} />
        </Field>
        <Field label="Plataforma — Razón social" htmlFor="c-plegal">
          <Input id="c-plegal" value={form.legalName} onChange={(e) => set('legalName', e.target.value)} />
        </Field>
        <Field label="Plataforma — Correo" htmlFor="c-pemail">
          <Input id="c-pemail" type="email" value={form.platformEmail} onChange={(e) => set('platformEmail', e.target.value)} />
        </Field>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" type="button" onClick={close}>Cancelar</Button>
        <Button type="button" onClick={submit} disabled={saving}>Guardar cliente</Button>
      </div>
    </Modal>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/components/AddClientModal.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/AddClientModal.tsx src/components/AddClientModal.test.tsx
git commit -m "feat(registro): add-client modal with full ANAM client fields"
```

---

### Task 4: `RegistroView` 4-step manifest-first flow

**Files:**
- Modify: `src/components/RegistroView.tsx` (full rewrite of the component body)
- Modify: `src/components/RegistroView.test.tsx` (replace existing tests)

**Interfaces:**
- Consumes: `extractMawb` from `../lib/extractMawb`; `AddClientModal`, `type Client` from `./AddClientModal`; `apiGet`, `apiPost`, `apiUpload` from `../api`; `Stepper`, `Button`, `Field`, `Input` from `./ui`; `RiskSummary`, `RiskResultTable`, types from `./RiskResultTable`.
- Produces: default-exported `RegistroView` (no props), unchanged consumer contract.

Flow:
- `STEPS = ['Cargar manifiesto', 'Datos del manifiesto', 'Análisis de riesgo', 'Resultado']` (indices 0–3).
- On mount, load clients: `apiGet<Client[]>('/api/catalogs/clients')`.
- Step 0: file drop. On file select, run `extractMawb`, store the result, and enable "Continuar". "Continuar" → step 1.
- Step 1: editable MAWB `Input` (pre-filled), ambiguity hint, client `<select>` + "+ Agregar cliente" (opens `AddClientModal`), "Atrás" → step 0, "Realizar análisis" disabled until `mawbReference.trim()` and `clientId`.
- "Realizar análisis" → step 2 (checklist animation), then: `apiUpload` POST `/api/manifests` (with `mawbReference` and `clientName` = selected client's name) → if `counts.error > 0`, surface rejected rows and return to step 0 → else `apiPost('/api/manifests/:id/client', { clientId })` → `apiPost('/api/manifests/:id/promote')` → `apiPost('/api/manifests/:id/risk')` → step 3 result. On any thrown error, set the error message and return to step 1.
- The checklist animation effect keys on `current === 2` (was `1`).

- [ ] **Step 1: Write the failing tests** (replace the whole file)

```tsx
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
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/components/RegistroView.test.tsx`
Expected: FAIL — the rewritten component does not yet exist / steps differ.

- [ ] **Step 3: Rewrite the component**

Replace the entire contents of `src/components/RegistroView.tsx` with:

```tsx
import { useState, useEffect } from 'react';
import { Upload, Check, Plus } from 'lucide-react';
import { apiGet, apiPost, apiUpload } from '../api';
import { Stepper, Button, Field, Input } from './ui';
import { extractMawb } from '../lib/extractMawb';
import { AddClientModal, type Client } from './AddClientModal';
import { RiskSummary, RiskResultTable, type RiskRow, type RiskSummaryData } from './RiskResultTable';

interface StagingResponse {
  manifestId: string;
  ingestionStatus: string;
  counts: { total: number; valid: number; warning: number; error: number };
  rejected: { rowIndex: number; field: string; message: string }[];
  warnings: { rowIndex: number; field: string; message: string }[];
  unmappedHeaders: string[];
  duplicateHeaders: string[];
}

interface RiskResponse {
  rows: RiskRow[];
  summary: RiskSummaryData;
}

const VALIDATION_LABELS = [
  'Validación ID',
  'Validación Cantidad',
  'Validación Monto',
  'Validación Consignatarios',
  'Validación Direcciones',
  'Artículos Prohibidos',
  'Validación Piratería',
  'Importaciones por consignatario',
];

const STEPS = ['Cargar manifiesto', 'Datos del manifiesto', 'Análisis de riesgo', 'Resultado'];

const SELECT_CLS =
  'w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 outline-none transition focus:border-navy-500 focus:ring-2 focus:ring-navy-500/25';

export default function RegistroView() {
  const [current, setCurrent] = useState(0);
  const [mawbReference, setMawbReference] = useState('');
  const [mawbAmbiguous, setMawbAmbiguous] = useState(false);
  const [clients, setClients] = useState<Client[]>([]);
  const [clientId, setClientId] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unmappedHeaders, setUnmappedHeaders] = useState<string[]>([]);
  const [staging, setStaging] = useState<StagingResponse | null>(null);
  const [result, setResult] = useState<RiskResponse | null>(null);
  const [checkedCount, setCheckedCount] = useState(0);

  useEffect(() => {
    apiGet<Client[]>('/api/catalogs/clients').then(setClients).catch(() => {});
  }, []);

  // Checklist animation runs while on the análisis step (index 2).
  useEffect(() => {
    if (current !== 2) {
      setCheckedCount(0);
      return;
    }
    if (checkedCount >= VALIDATION_LABELS.length) return;
    const timer = setTimeout(() => setCheckedCount((n) => n + 1), 220);
    return () => clearTimeout(timer);
  }, [current, checkedCount]);

  async function handleFile(selected: File | null) {
    setFile(selected);
    setMawbReference('');
    setMawbAmbiguous(false);
    if (!selected) return;
    const { mawb, ambiguous } = await extractMawb(selected);
    setMawbReference(mawb ?? '');
    setMawbAmbiguous(ambiguous);
  }

  function handleClientCreated(c: Client) {
    setClients((prev) => [...prev, c]);
    setClientId(c.id);
  }

  async function runAnalysis() {
    setError(null);
    setResult(null);
    setUnmappedHeaders([]);
    setStaging(null);

    if (!file) { setError('Selecciona un archivo de manifiesto.'); return; }
    if (!mawbReference.trim()) { setError('El MAWB es requerido.'); return; }
    if (!clientId) { setError('Selecciona un cliente.'); return; }

    setCurrent(2);
    setCheckedCount(0);

    try {
      const clientName = clients.find((c) => c.id === clientId)?.name ?? '';
      const form = new FormData();
      form.append('file', file);
      form.append('mawbReference', mawbReference.trim());
      form.append('clientName', clientName);

      const stagingResult = await apiUpload<StagingResponse>('/api/manifests', form);
      setUnmappedHeaders(stagingResult.unmappedHeaders ?? []);
      setStaging(stagingResult);

      if (stagingResult.counts.error > 0) {
        setCurrent(0);
        return;
      }

      await apiPost(`/api/manifests/${stagingResult.manifestId}/client`, { clientId });
      await apiPost(`/api/manifests/${stagingResult.manifestId}/promote`, {});
      const risk = await apiPost<RiskResponse>(`/api/manifests/${stagingResult.manifestId}/risk`, {});
      setResult(risk);

      setCheckedCount(VALIDATION_LABELS.length);
      setCurrent(3);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ocurrió un error al procesar el manifiesto.');
      setCurrent(1);
    }
  }

  return (
    <div className="space-y-6">
      <Stepper steps={STEPS} current={current} />

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
          {error}
        </div>
      )}

      {unmappedHeaders.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs font-medium text-amber-800">
          Columnas no mapeadas: {unmappedHeaders.join(', ')}
        </div>
      )}

      {staging && staging.counts.error > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm">
          <p className="font-medium text-amber-800">
            {staging.counts.error} fila(s) con errores no se importarán. Corríjalas y vuelva a subir el archivo.
          </p>
          <ul className="mt-2 list-disc pl-5 text-amber-900">
            {staging.rejected.slice(0, 50).map((r, i) => (
              <li key={i}>Fila {r.rowIndex + 1} — {r.field}: {r.message}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Step 0: Cargar manifiesto */}
      {current === 0 && (
        <div className="space-y-5 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <Field label="Manifiesto" htmlFor="manifest-file">
            <label
              htmlFor="manifest-file"
              className="flex cursor-pointer items-center gap-3 rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-3.5 text-sm transition hover:border-navy-400 hover:bg-navy-50/30"
            >
              <Upload className="h-4 w-4 shrink-0 text-navy-600" />
              <span className={file ? 'font-medium text-slate-800' : 'text-slate-500'}>
                {file ? file.name : 'Selecciona un archivo .xlsx, .xls o .csv'}
              </span>
            </label>
            <input
              id="manifest-file"
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
              className="sr-only"
            />
          </Field>

          <Button type="button" disabled={!file} onClick={() => setCurrent(1)}>
            Continuar
          </Button>
        </div>
      )}

      {/* Step 1: Datos del manifiesto */}
      {current === 1 && (
        <div className="space-y-5 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <Field label="MAWB" htmlFor="mawb">
            <Input
              id="mawb"
              type="text"
              value={mawbReference}
              onChange={(e) => setMawbReference(e.target.value)}
              placeholder="Ej. 045-12345678"
            />
          </Field>
          {mawbAmbiguous && (
            <p className="-mt-3 text-xs font-medium text-amber-700">
              El archivo contiene varios valores MWB. Confirme el MAWB correcto.
            </p>
          )}

          <Field label="Cliente" htmlFor="cliente">
            <div className="flex items-center gap-2">
              <select
                id="cliente"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                className={SELECT_CLS}
              >
                <option value="">Selecciona un cliente…</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
              <Button variant="secondary" type="button" onClick={() => setModalOpen(true)}>
                <Plus className="h-4 w-4" /> Agregar cliente
              </Button>
            </div>
          </Field>

          <div className="flex gap-2">
            <Button variant="secondary" type="button" onClick={() => setCurrent(0)}>
              Atrás
            </Button>
            <Button
              type="button"
              disabled={!mawbReference.trim() || !clientId}
              onClick={runAnalysis}
            >
              Realizar análisis de Riesgo
            </Button>
          </div>
        </div>
      )}

      {/* Step 2: Análisis de riesgo — 7-validation checklist */}
      {current === 2 && (
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm space-y-4">
          <p className="text-sm font-medium text-slate-600">Ejecutando validaciones…</p>
          <ul className="space-y-2">
            {VALIDATION_LABELS.map((label, i) => (
              <li key={label} className="flex items-center gap-3">
                <span
                  className={`grid h-5 w-5 shrink-0 place-items-center rounded-full transition-colors duration-300 ${
                    i < checkedCount ? 'bg-navy-800 text-white' : 'border border-slate-300 bg-slate-50'
                  }`}
                >
                  {i < checkedCount && <Check className="h-3 w-3" strokeWidth={3} />}
                </span>
                <span
                  className={`text-sm transition-colors duration-300 ${
                    i < checkedCount ? 'font-medium text-slate-800' : 'text-slate-400'
                  }`}
                >
                  {label}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Step 3: Resultado */}
      {current === 3 && result && (
        <div className="space-y-4">
          <RiskSummary summary={result.summary} />
          <RiskResultTable rows={result.rows} />
        </div>
      )}

      <AddClientModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onCreated={handleClientCreated}
      />
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/components/RegistroView.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Run the full suite + typecheck**

Run: `npm test && npm run lint`
Expected: all tests pass; `tsc --noEmit` reports no errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/RegistroView.tsx src/components/RegistroView.test.tsx
git commit -m "feat(registro): manifest-first flow with MAWB auto-extract and client picker"
```

---

## Self-Review

**Spec coverage:**
- Manifest-first 4-step flow → Task 4. ✓
- Client-side MAWB extraction (editable, ambiguous/missing fallback) → Task 1 + Task 4 step 1 wiring. ✓
- Client dropdown from `GET /api/catalogs/clients`, required before analysis → Task 4. ✓
- "+ Agregar cliente" modal with full ANAM fields → Tasks 2 + 3. ✓
- Two-call submit (manifest with `clientName`, then `/client` link) + promote + risk → Task 4. ✓
- Staging-error review behavior preserved → Task 4 (`counts.error > 0` → back to step 0 with rejected list). ✓
- Reusable `Modal` primitive (none existed) → Task 2. ✓
- Tests for extraction helper and new flow → Tasks 1 & 4. ✓
- No backend changes → honored throughout. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full content. ✓

**Type consistency:** `Client`/`ClientPlatform` defined in Task 3 and imported by Task 4. `MawbExtraction`/`extractMawb` defined in Task 1, consumed in Task 4. `Modal` props defined in Task 2, consumed in Task 3. Endpoint paths (`/client`, `/promote`, `/risk`) match the server routes verified in the spec. ✓
