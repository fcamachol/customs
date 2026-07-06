# One-Click Reporte General Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Reporte General page one click for the happy path — search → select record → download — by reusing the client/platform association the manifest already has and deleting the dead Remitente/Plataforma forms.

**Architecture:** `GET /api/records/:id` gains `clientId`/`platformId` (already columns on `manifests`, set by `POST /api/manifests/:id/client`). `ReporteGeneralView` fetches the detail on record select, prefills the association (read-only summary with "Cambiar" when fully associated; dropdowns with a best-effort name match otherwise), and only POSTs the association when the user changed it. Report content, endpoints, and builders are untouched.

**Tech Stack:** Express + pg (server), React + Vitest + Testing Library (front). Spec: `docs/superpowers/specs/2026-07-06-reporte-general-one-click-design.md`.

## Global Constraints

- UI copy is Spanish, matching existing strings exactly (e.g. `Selecciona un cliente…`, `Generar Reporte`).
- Do not modify report/layout endpoints, `reportBuilder.ts`, `reportData.ts`, or the capture workspace.
- Server tests run from `server/` (`npm test`), frontend tests from repo root (`npm test`); both are vitest.

---

### Task 1: Expose clientId/platformId on the record detail endpoint

**Files:**
- Modify: `server/src/routes/records.ts:142-148` (the `GET /:id` SELECT)
- Test: `server/test/routes/records.test.ts`

**Interfaces:**
- Produces: `GET /api/records/:id` response gains top-level `clientId: string | null` and `platformId: string | null`. Task 2's `RecordDetail` interface consumes exactly these two fields.

- [ ] **Step 1: Write the failing test**

Add to the existing `describe('records', …)` block in `server/test/routes/records.test.ts` (it uses the module-level `token`/`userId`; the `auth()` helper lives in a different describe, so use the inline header like the block's other tests):

```ts
  it('detail exposes the manifest client/platform association (null until bound)', async () => {
    const list = await request(app).get('/api/records?q=369-1').set('Authorization', `Bearer ${token}`);
    const id = list.body[0].id;

    // Unassociated manifest → explicit nulls
    let res = await request(app).get(`/api/records/${id}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.clientId).toBeNull();
    expect(res.body.platformId).toBeNull();

    // Bind a client + platform, then the detail returns their ids
    const c = await query(`INSERT INTO clients (name, created_by) VALUES ('Cliente A',$1) RETURNING id`, [userId]);
    const p = await query(
      `INSERT INTO client_platforms (client_id, commercial_name, created_by) VALUES ($1,'Tienda A',$2) RETURNING id`,
      [c.rows[0].id, userId]);
    await query('UPDATE manifests SET client_id=$1, platform_id=$2 WHERE id=$3', [c.rows[0].id, p.rows[0].id, id]);

    res = await request(app).get(`/api/records/${id}`).set('Authorization', `Bearer ${token}`);
    expect(res.body.clientId).toBe(c.rows[0].id);
    expect(res.body.platformId).toBe(p.rows[0].id);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `server/`): `npm test -- test/routes/records.test.ts -t 'client/platform association'`
Expected: FAIL — `expected undefined to be null` (the detail SELECT doesn't return the columns yet).

- [ ] **Step 3: Add the two columns to the detail SELECT**

In `server/src/routes/records.ts`, the `GET /:id` query currently reads:

```ts
    `SELECT m.id, m.mawb_reference AS "mawbReference", m.client_name AS "clientName",
            m.created_by AS "createdBy",
            m.risk_stale AS "riskStale",
            (SELECT count(*)::int FROM shipments s WHERE s.manifest_id=m.id) AS "shipmentCount"
     FROM manifests m WHERE m.id=$1`, [req.params.id]);
```

Change it to:

```ts
    `SELECT m.id, m.mawb_reference AS "mawbReference", m.client_name AS "clientName",
            m.client_id AS "clientId", m.platform_id AS "platformId",
            m.created_by AS "createdBy",
            m.risk_stale AS "riskStale",
            (SELECT count(*)::int FROM shipments s WHERE s.manifest_id=m.id) AS "shipmentCount"
     FROM manifests m WHERE m.id=$1`, [req.params.id]);
```

No other change needed: the handler ends with `res.json({ ...r, … })` (records.ts:201-213), so the two aliased columns flow straight into the response. Postgres returns SQL NULL as JS `null`, satisfying the `toBeNull()` assertions.

- [ ] **Step 4: Run test to verify it passes**

Run (from `server/`): `npm test -- test/routes/records.test.ts`
Expected: all tests in the file PASS (the new one plus the existing suite — the SELECT change must not break the Consulta tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/records.ts server/test/routes/records.test.ts
git commit -m "feat(records): expose manifest clientId/platformId in record detail"
```

---

### Task 2: One-click ReporteGeneralView

**Files:**
- Modify: `src/components/ReporteGeneralView.tsx` (full rewrite of the component body)
- Test: `src/components/ReporteGeneralView.test.tsx` (rewrite: three scenarios)

**Interfaces:**
- Consumes: `GET /api/records/:id` → `{ id, clientId: string | null, platformId: string | null, pedimentos: { id, numeroPedimento }[] }` (Task 1). `GET /api/catalogs/clients` → `Client[]` from `./AddClientModal` (`{ id, name, platforms?: { id?, commercialName?, legalName? }[] }`). `POST /api/manifests/:id/client` body `{ clientId, platformId }`.
- Produces: nothing consumed by later tasks (final task).

- [ ] **Step 1: Rewrite the test file with the three scenarios**

Replace the entire contents of `src/components/ReporteGeneralView.test.tsx` with:

```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ReporteGeneralView from './ReporteGeneralView';
import { apiGet, apiPost, apiDownload } from '../api';

vi.mock('../api', () => ({ apiGet: vi.fn(), apiPost: vi.fn(), apiDownload: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

const CLIENTS = [
  { id: 'cl1', name: 'ACME', platforms: [{ id: 'p1', commercialName: 'Shop A' }, { id: 'p2', commercialName: 'Shop B' }] },
];

/** Mock the three GETs; `detail` controls the association returned for record m1. */
function mockApi(detail: { clientId: string | null; platformId: string | null }) {
  (apiGet as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
    if (path === '/api/catalogs/clients') return Promise.resolve(CLIENTS);
    if (path.startsWith('/api/records?q=')) return Promise.resolve([
      { id: 'm1', mawbReference: '369-1', clientName: 'ACME', createdAt: '2026-06-23' },
    ]);
    if (path === '/api/records/m1') return Promise.resolve({
      id: 'm1', ...detail, pedimentos: [{ id: 'ped-1', numeroPedimento: '111' }],
    });
    return Promise.resolve([]);
  });
  (apiPost as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
  (apiDownload as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
}

/** Search for the seeded record and select it. */
async function searchAndSelect() {
  fireEvent.change(screen.getByPlaceholderText(/Buscar registro/i), { target: { value: '369' } });
  fireEvent.click(screen.getByRole('button', { name: /Buscar/i }));
  await waitFor(() => screen.getByText(/369-1/));
  fireEvent.click(screen.getByText(/369-1/));
}

/** Open a SearchSelect by focusing its input, then pick an option by label. */
async function pickOption(placeholder: string, optionLabel: string) {
  const input = await screen.findByPlaceholderText(placeholder);
  fireEvent.focus(input);
  const optionBtn = await screen.findByRole('button', { name: optionLabel });
  fireEvent.click(optionBtn);
}

describe('ReporteGeneralView one-click generation', () => {
  it('pre-associated manifest: shows the summary and downloads without re-binding', async () => {
    mockApi({ clientId: 'cl1', platformId: 'p2' });
    render(<ReporteGeneralView />);
    await searchAndSelect();

    // Association is shown read-only (no dropdowns) with a Cambiar affordance
    await waitFor(() => screen.getByText(/Cliente: ACME/));
    expect(screen.getByText(/Plataforma: Shop B/)).toBeTruthy();
    expect(screen.queryByPlaceholderText('Selecciona un cliente…')).toBeNull();
    expect(screen.getByRole('button', { name: /Cambiar/i })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Generar/i }));
    await waitFor(() => expect(apiDownload).toHaveBeenCalledWith('/api/pedimentos/ped-1/report.xlsx', 'Reporte_General_111.xlsx'));
    // Unchanged association → no bind POST
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('unassociated manifest: pre-selects the client by name, binds on generate', async () => {
    mockApi({ clientId: null, platformId: null });
    render(<ReporteGeneralView />);
    await searchAndSelect();

    // Dropdowns visible; client pre-matched by name so the platform select is already unlocked
    await pickOption('Selecciona una plataforma…', 'Shop B');

    fireEvent.click(screen.getByRole('button', { name: /Generar/i }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/api/manifests/m1/client', { clientId: 'cl1', platformId: 'p2' }));
    await waitFor(() => expect(apiDownload).toHaveBeenCalledWith('/api/pedimentos/ped-1/report.xlsx', 'Reporte_General_111.xlsx'));
  });

  it('no longer renders the manual Remitente/Plataforma forms', async () => {
    mockApi({ clientId: null, platformId: null });
    render(<ReporteGeneralView />);
    expect(screen.queryByText('Datos del Remitente')).toBeNull();
    expect(screen.queryByText('Datos de la Plataforma')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from repo root): `npm test -- src/components/ReporteGeneralView.test.tsx`
Expected: FAIL — scenario 1 can't find `Cliente: ACME` (detail isn't fetched on select today), scenario 3 finds the dead forms.

- [ ] **Step 3: Rewrite the component**

Replace the entire contents of `src/components/ReporteGeneralView.tsx` with:

```tsx
import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Search, Download } from 'lucide-react';
import { apiGet, apiPost, apiDownload } from '../api';
import { Card, Field, Input, Button, SearchSelect } from './ui';
import type { SearchSelectOption } from './ui';
import type { Client } from './AddClientModal';

interface RecordSummary {
  id: string;
  mawbReference: string;
  clientName: string;
  createdAt: string;
}

// A subdivisión (pedimento) of the selected record; each has its own Reporte General.
interface PedimentoItem {
  id: string;
  numeroPedimento: string | null;
}
interface RecordDetail {
  id: string;
  clientId: string | null;
  platformId: string | null;
  pedimentos: PedimentoItem[];
}

export default function ReporteGeneralView() {
  // Record search state
  const [query, setQuery] = useState('');
  const [records, setRecords] = useState<RecordSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedLabel, setSelectedLabel] = useState<string>('');
  const [detail, setDetail] = useState<RecordDetail | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  // Cliente/plataforma association. The remitente + plataforma report blocks come from the
  // clients catalog server-side; this page only needs to know WHICH client/platform.
  const [clients, setClients] = useState<Client[]>([]);
  const [selectedClientId, setSelectedClientId] = useState('');
  const [selectedPlatformId, setSelectedPlatformId] = useState('');
  // False when the manifest arrived fully associated → read-only summary until "Cambiar".
  const [editingAssoc, setEditingAssoc] = useState(true);

  useEffect(() => {
    apiGet<Client[]>('/api/catalogs/clients').then(setClients).catch(() => setClients([]));
  }, []);

  const clientOptions: SearchSelectOption[] = useMemo(
    () => clients.map((c) => ({ value: c.id, label: c.name })),
    [clients],
  );

  const platformOptions: SearchSelectOption[] = useMemo(() => {
    const c = clients.find((c) => c.id === selectedClientId);
    return (c?.platforms ?? []).map((p) => ({
      value: p.id!,
      label: p.commercialName || p.legalName || 'Plataforma',
    }));
  }, [clients, selectedClientId]);

  const clientLabel = clients.find((c) => c.id === selectedClientId)?.name ?? '';
  const platformLabel = platformOptions.find((o) => o.value === selectedPlatformId)?.label ?? '';

  function handleClientChange(id: string) {
    setSelectedClientId(id);
    setSelectedPlatformId(''); // platform list depends on the client
  }

  async function handleSearch(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSelectedId(null);
    setSelectedLabel('');
    setDetail(null);
    setSearchLoading(true);
    try {
      const results = await apiGet<RecordSummary[]>(`/api/records?q=${encodeURIComponent(query)}`);
      setRecords(results);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al buscar registros.');
    } finally {
      setSearchLoading(false);
    }
  }

  async function handleSelect(r: RecordSummary) {
    setSelectedId(r.id);
    setSelectedLabel(`${r.mawbReference} — ${r.clientName}`);
    setError(null);
    setDetail(null);
    try {
      const d = await apiGet<RecordDetail>(`/api/records/${r.id}`);
      setDetail(d);
      // Prefill from the manifest's existing association; fall back to a best-effort
      // catalog match on the manifest's client name.
      const matchedClient = d.clientId
        ?? clients.find((c) => c.name.trim().toLowerCase() === (r.clientName ?? '').trim().toLowerCase())?.id
        ?? '';
      setSelectedClientId(matchedClient);
      setSelectedPlatformId(d.platformId ?? '');
      setEditingAssoc(!(d.clientId && d.platformId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al cargar el registro.');
    }
  }

  async function handleGenerateReport() {
    if (!selectedId || !detail) return;
    if (!selectedClientId) { setError('Selecciona un cliente.'); return; }
    if (!selectedPlatformId) { setError('Selecciona una plataforma.'); return; }
    setError(null);
    setDownloading(true);
    try {
      // Only re-bind when the user actually changed the association.
      if (selectedClientId !== detail.clientId || selectedPlatformId !== detail.platformId) {
        await apiPost(`/api/manifests/${selectedId}/client`, {
          clientId: selectedClientId,
          platformId: selectedPlatformId,
        });
      }
      // Reporte General is per-pedimento (each subdivisión is its own customs submission), so
      // download the report.xlsx for each of the record's pedimentos.
      const peds = detail.pedimentos ?? [];
      if (peds.length === 0) {
        setError('Este registro aún no tiene pedimentos (subdivisiones). Genere el pedimento antes de descargar el reporte.');
        return;
      }
      for (const p of peds) {
        const suffix = p.numeroPedimento ? `_${p.numeroPedimento}` : '';
        await apiDownload(`/api/pedimentos/${p.id}/report.xlsx`, `Reporte_General${suffix}.xlsx`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al generar el reporte.');
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Record search */}
      <form onSubmit={handleSearch} className="flex gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar registro por MAWB o cliente"
            className="pl-10"
          />
        </div>
        <Button type="submit" disabled={searchLoading}>
          Buscar
        </Button>
      </form>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
          {error}
        </div>
      )}

      {records.length > 0 && (
        <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          {records.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => handleSelect(r)}
                className={`flex w-full items-center justify-between px-4 py-3 text-left text-sm transition-colors hover:bg-slate-50 ${
                  selectedId === r.id ? 'bg-navy-50 font-semibold text-navy-800' : ''
                }`}
              >
                <span>
                  <span className="font-semibold text-slate-800">{r.mawbReference}</span>
                  <span className="text-slate-500"> — {r.clientName}</span>
                </span>
                <span className="ml-2 shrink-0 text-xs text-slate-400">{r.createdAt}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {selectedId && (
        <div className="rounded-lg border border-navy-200 bg-navy-50/40 px-4 py-2.5 text-sm font-medium text-navy-800">
          Registro seleccionado: <span className="font-semibold">{selectedLabel}</span>
        </div>
      )}

      {/* Cliente y plataforma — read-only summary when the manifest is already associated */}
      {selectedId && detail && (
        <Card className="p-6 shadow-sm space-y-5">
          <h2 className="text-sm font-bold text-slate-800">Cliente y plataforma</h2>
          {!editingAssoc ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-slate-700">
                Cliente: <span className="font-semibold">{clientLabel || '—'}</span>
                <span className="mx-2 text-slate-300">·</span>
                Plataforma: <span className="font-semibold">{platformLabel || '—'}</span>
              </p>
              <Button type="button" variant="secondary" onClick={() => setEditingAssoc(true)}>
                Cambiar
              </Button>
            </div>
          ) : (
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="Cliente" htmlFor="rg-cliente">
                <SearchSelect
                  id="rg-cliente"
                  value={selectedClientId}
                  onChange={handleClientChange}
                  options={clientOptions}
                  placeholder="Selecciona un cliente…"
                />
              </Field>
              <Field label="Plataforma" htmlFor="rg-plataforma">
                <SearchSelect
                  id="rg-plataforma"
                  value={selectedPlatformId}
                  onChange={setSelectedPlatformId}
                  options={platformOptions}
                  placeholder={selectedClientId ? 'Selecciona una plataforma…' : 'Elige un cliente primero'}
                  disabled={!selectedClientId}
                />
              </Field>
            </div>
          )}
        </Card>
      )}

      {/* Generate report action */}
      <div className="flex items-center gap-3">
        <Button
          type="button"
          disabled={!selectedId || !detail || downloading}
          onClick={handleGenerateReport}
        >
          <Download className="h-4 w-4" />
          {downloading ? 'Generando…' : 'Generar Reporte'}
        </Button>
        {!selectedId && (
          <p className="text-xs text-slate-500">Selecciona un registro para habilitar la descarga.</p>
        )}
      </div>
    </div>
  );
}
```

Notes for the implementer:
- The `ANAM_COUNTRY_OPTIONS` import and every Remitente/Plataforma form state variable from the old file are gone — do not carry any of them over.
- `Button` supports `variant="secondary"` (see usage in `CaptureWorkspace.tsx`).
- If TypeScript flags the unused `Input` import after the rewrite, keep it — it is still used by the search box.

- [ ] **Step 4: Run tests to verify they pass**

Run (from repo root): `npm test -- src/components/ReporteGeneralView.test.tsx`
Expected: 3 tests PASS.

- [ ] **Step 5: Run the full frontend suite to catch regressions**

Run (from repo root): `npm test`
Expected: same pass/fail state as before this change, except `ReporteGeneralView.test.tsx` (now 3 tests). Known pre-existing failure: one `ConsultaView.test.tsx` risk-panel test is broken on HEAD (unrelated workstream) — do not chase it.

- [ ] **Step 6: Commit**

```bash
git add src/components/ReporteGeneralView.tsx src/components/ReporteGeneralView.test.tsx
git commit -m "feat(reporte-general): one-click generation from the manifest's existing association"
```
