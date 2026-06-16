# Workflow Shell & Reports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the front-end product shell from `Analisis de Riesgo.pdf` — login + the six sections (Realizar Registro, Seguimiento, Reporte General, Consulta, Dashboard, Acerca de) — records keyed by `MAWB – Cliente`, the three stored artifacts per record, the "Generar Reporte" Excel export, the flat 34-column LayOut export, a per-user dashboard, and audit-log hardening (append-only enforcement) for government compliance.

**Architecture:** A typed `client/src/api.ts` wraps the backend. An auth context stores the JWT and gates routes by role. The six sections become routed views reusing existing components where possible. Server adds records/consulta/report/export endpoints; the report builder and LayOut exporter live in `shared/` so they are unit-testable without a browser.

**Tech Stack:** React 19, Vite, TypeScript, `xlsx` (export), Express, `pg`, `vitest`, `supertest`.

**Depends on:** Plans 01–04 (auth, data model, risk, pedimento).

---

### Task 1: Typed API client + auth context

**Files:**
- Create: `client/src/api.ts` (or `src/api.ts` if monorepo move deferred)
- Create: `src/context/AuthContext.tsx`
- Test: `src/context/AuthContext.test.tsx` (vitest + @testing-library/react)

- [ ] **Step 1: Add client test deps**

Run: `npm i -D vitest @testing-library/react @testing-library/jest-dom jsdom`
Add to root `package.json` scripts: `"test": "vitest run"`, and a `vitest.config.ts` with `environment: 'jsdom'`.

- [ ] **Step 2: Write the failing test**

`src/context/AuthContext.test.tsx`:
```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { AuthProvider, useAuth } from './AuthContext';

function Probe() {
  const { user, login } = useAuth();
  return <button onClick={() => login('admin', 'p')}>{user ? user.username : 'anon'}</button>;
}

describe('AuthContext', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, json: async () => ({ token: 't', user: { id: '1', username: 'admin', role: 'admin' } }),
    })) as any);
    localStorage.clear();
  });

  it('logs in and exposes the user', async () => {
    render(<AuthProvider><Probe /></AuthProvider>);
    screen.getByText('anon').click();
    await waitFor(() => expect(screen.getByText('admin')).toBeTruthy());
    expect(localStorage.getItem('token')).toBe('t');
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run src/context/AuthContext.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the API client**

`src/api.ts`:
```ts
const BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';

function authHeaders(): Record<string, string> {
  const t = localStorage.getItem('token');
  return t ? { Authorization: `Bearer ${t}` } : {};
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
  return res.json();
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(res.statusText);
  return res.json();
}
```

- [ ] **Step 5: Implement the auth context**

`src/context/AuthContext.tsx`:
```tsx
import { createContext, useContext, useState, type ReactNode } from 'react';
import { apiPost } from '../api';

interface User { id: string; username: string; role: 'capturista' | 'admin' | 'autoridad'; }
interface AuthValue { user: User | null; login: (u: string, p: string) => Promise<void>; logout: () => void; }

const Ctx = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  async function login(username: string, password: string) {
    const { token, user } = await apiPost<{ token: string; user: User }>('/api/auth/login', { username, password });
    localStorage.setItem('token', token);
    setUser(user);
  }
  function logout() { localStorage.removeItem('token'); setUser(null); }
  return <Ctx.Provider value={{ user, login, logout }}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `npx vitest run src/context/AuthContext.test.tsx`
Expected: PASS (1 test).

- [ ] **Step 7: Commit**

```bash
git add src/api.ts src/context/AuthContext.tsx src/context/AuthContext.test.tsx vitest.config.ts package.json
git commit -m "feat(client): typed API client + auth context"
```

---

### Task 2: Login screen + role-gated shell with the six sections

**Files:**
- Create: `src/components/LoginView.tsx`
- Create: `src/components/AppShell.tsx`
- Create: `src/components/AcercaDeView.tsx`
- Modify: `src/App.tsx` (wrap in AuthProvider, render LoginView when logged out, AppShell when logged in)

- [ ] **Step 1: Write the failing test for the shell nav**

`src/components/AppShell.test.tsx`:
```tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AppShell } from './AppShell';

describe('AppShell', () => {
  it('renders the six section labels', () => {
    render(<AppShell role="capturista" onSelect={() => {}} active="registro" />);
    for (const label of ['Realizar Registro', 'Seguimiento', 'Reporte General', 'Consulta', 'Dashboard', 'Acerca de']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/AppShell.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `AppShell.tsx`**

`src/components/AppShell.tsx`:
```tsx
export type Section = 'registro' | 'seguimiento' | 'reporte' | 'consulta' | 'dashboard' | 'acerca';

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'registro', label: 'Realizar Registro' },
  { id: 'seguimiento', label: 'Seguimiento' },
  { id: 'reporte', label: 'Reporte General' },
  { id: 'consulta', label: 'Consulta' },
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'acerca', label: 'Acerca de' },
];

export function AppShell({ role, active, onSelect }: {
  role: string; active: Section; onSelect: (s: Section) => void;
}) {
  return (
    <nav aria-label="Secciones">
      <div className="brand">Capital Centennials</div>
      <ul>
        {SECTIONS.map((s) => (
          <li key={s.id}>
            <button aria-current={active === s.id} onClick={() => onSelect(s.id)}>{s.label}</button>
          </li>
        ))}
      </ul>
      <div className="role">{role}</div>
    </nav>
  );
}
```

- [ ] **Step 4: Implement `LoginView.tsx` and `AcercaDeView.tsx`**

`src/components/LoginView.tsx`:
```tsx
import { useState } from 'react';
import { useAuth } from '../context/AuthContext';

export function LoginView() {
  const { login } = useAuth();
  const [u, setU] = useState(''); const [p, setP] = useState(''); const [err, setErr] = useState('');
  return (
    <form onSubmit={async (e) => { e.preventDefault(); try { await login(u, p); } catch (x) { setErr(String(x)); } }}>
      <h1>Capital Centennials</h1>
      <input placeholder="Usuario" value={u} onChange={(e) => setU(e.target.value)} />
      <input placeholder="Contraseña" type="password" value={p} onChange={(e) => setP(e.target.value)} />
      <button type="submit">Entrar</button>
      {err && <p role="alert">{err}</p>}
    </form>
  );
}
```

`src/components/AcercaDeView.tsx`:
```tsx
export function AcercaDeView() {
  return (
    <section>
      <h2>Acerca de</h2>
      <p>Capital Centennials — plataforma de análisis de riesgo y cumplimiento T1.</p>
      <h3>Misión</h3><p>Garantizar importaciones de mensajería seguras y conformes.</p>
      <h3>Visión</h3><p>Ser la plataforma de referencia en cumplimiento aduanero T1.</p>
    </section>
  );
}
```

- [ ] **Step 5: Wire `App.tsx`**

Modify `src/App.tsx` to wrap the tree in `<AuthProvider>`, show `<LoginView/>` when `useAuth().user` is null, otherwise `<AppShell/>` + the active section view (reuse existing `ManifestUploadView`/`T1ComplianceView`/`DashboardView` for registro/compliance/dashboard; new views added in later tasks).

- [ ] **Step 6: Run to verify it passes**

Run: `npx vitest run src/components/AppShell.test.tsx`
Expected: PASS (1 test).

- [ ] **Step 7: Commit**

```bash
git add src/components/AppShell.tsx src/components/LoginView.tsx src/components/AcercaDeView.tsx src/components/AppShell.test.tsx src/App.tsx
git commit -m "feat(client): login + role-gated six-section shell"
```

---

### Task 3: Records (MAWB – Cliente) — Seguimiento + Consulta endpoints

**Files:**
- Create: `server/src/routes/records.ts`
- Modify: `server/src/app.ts`
- Test: `server/test/routes/records.test.ts`

- [ ] **Step 1: Write the failing test**

`server/test/routes/records.test.ts`:
```ts
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { hashPassword } from '../../src/auth/password';
import { signToken } from '../../src/auth/token';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

const app = createApp();
let token: string;

beforeEach(async () => {
  await truncateAll();
  const hash = await hashPassword('p');
  const u = await query(`INSERT INTO users (username,password_hash,role) VALUES ('c',$1,'capturista') RETURNING id`, [hash]);
  token = signToken({ userId: u.rows[0].id, role: 'capturista' });
  await query(`INSERT INTO manifests (mawb_reference, client_name) VALUES ('369-1','Cliente A'),('370-2','Cliente B')`);
});

describe('records', () => {
  it('searches by MAWB – Cliente', async () => {
    const res = await request(app).get('/api/records?q=Cliente%20A').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].clientName).toBe('Cliente A');
  });

  it('returns a single record with its 3 artifacts in Consulta', async () => {
    const list = await request(app).get('/api/records?q=369-1').set('Authorization', `Bearer ${token}`);
    const id = list.body[0].id;
    const res = await request(app).get(`/api/records/${id}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('artifacts');
    expect(res.body.artifacts).toHaveProperty('riskAnalysis');
    expect(res.body.artifacts).toHaveProperty('pedimentoPdf');
    expect(res.body.artifacts).toHaveProperty('report');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx vitest run test/routes/records.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`server/src/routes/records.ts`:
```ts
import { Router } from 'express';
import { query } from '../db/pool';
import { requireAuth } from '../auth/middleware';

export const recordsRouter = Router();

recordsRouter.get('/', requireAuth, async (req, res) => {
  const q = `%${(req.query.q as string) ?? ''}%`;
  const { rows } = await query(
    `SELECT id, mawb_reference AS "mawbReference", client_name AS "clientName", created_at AS "createdAt"
     FROM manifests WHERE mawb_reference ILIKE $1 OR client_name ILIKE $1 ORDER BY created_at DESC`, [q]);
  res.json(rows);
});

recordsRouter.get('/:id', requireAuth, async (req, res) => {
  const { rows } = await query(
    `SELECT m.id, m.mawb_reference AS "mawbReference", m.client_name AS "clientName",
            m.pedimento, m.prevalidation, m.file_id AS "pedimentoFileId",
            (SELECT count(*)::int FROM shipments s WHERE s.manifest_id=m.id) AS "shipmentCount"
     FROM manifests m WHERE m.id=$1`, [req.params.id]);
  if (!rows.length) { res.status(404).json({ error: 'Not found' }); return; }
  const r = rows[0];
  res.json({
    ...r,
    artifacts: {
      riskAnalysis: `/api/records/${r.id}/risk.xlsx`,
      pedimentoPdf: r.pedimentoFileId ? `/api/files/${r.pedimentoFileId}` : null,
      report: `/api/records/${r.id}/report.xlsx`,
    },
  });
});
```

- [ ] **Step 4: Mount + run**

Add `app.use('/api/records', recordsRouter)` to `app.ts`. Run:
`cd server && npx vitest run test/routes/records.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/records.ts server/src/app.ts server/test/routes/records.test.ts
git commit -m "feat(server): records search + consulta (3 artifacts)"
```

---

### Task 4: LayOut 34-column exporter + Reporte General builder

**Files:**
- Create: `shared/export/layoutExport.ts`
- Create: `shared/export/reportBuilder.ts`
- Test: `shared/export/layoutExport.test.ts`, `shared/export/reportBuilder.test.ts`

- [ ] **Step 1: Write the failing test for the layout exporter**

`shared/export/layoutExport.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { toLayoutRows, LAYOUT_HEADERS } from './layoutExport';
import type { Shipment } from '../types/shipment';

const s: Shipment = {
  id: '1', mawbReference: '369', description: 'TRAJE', hsCode: '99010001', quantity: 1, unit: '6',
  customsValueUsd: 120, currency: 'USD', originCountry: 'CN', guideId: 'g1', arrivalDate: '2025-04-04',
  customsEntryCode: '4', customsClearanceCode: '850',
  consignee: { name: 'Juan', rfc: 'TOMM020922D40', curp: 'AERA790828HBSRBR04', address: 'Calle 1', phone: '55', email: 'a@b.com' },
  sender: { name: 'SHEIN HK', taxId: 'HK1', address: 'HK', phone: '852', email: 's@x.com' },
  platform: { commercialName: 'SHEIN', countryOfOrigin: 'CN', legalName: 'Shein Ltd', email: 'p@x.com' },
} as Shipment;

describe('layoutExport', () => {
  it('emits all 34 headers', () => {
    expect(LAYOUT_HEADERS).toHaveLength(34);
  });
  it('maps a shipment into a 34-field row in order', () => {
    const row = toLayoutRows([s])[0];
    expect(row[LAYOUT_HEADERS[3]]).toBe('TRAJE');            // col 4 descripción
    expect(row[LAYOUT_HEADERS[17]]).toBe('TOMM020922D40');   // col 18 RFC
    expect(row[LAYOUT_HEADERS[25]]).toBe('SHEIN HK');        // col 26 remitente nombre
    expect(row[LAYOUT_HEADERS[30]]).toBe('SHEIN');           // col 31 plataforma nombre comercial
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd shared && npx vitest run export/layoutExport.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the layout exporter**

`shared/export/layoutExport.ts`:
```ts
import type { Shipment } from '../types/shipment';

export const LAYOUT_HEADERS = [
  'No. de registro T1', 'Patente AA', 'No. pedimento', 'Descripción de la mercancía',
  'Fracción arancelaria', 'Cantidad de la mercancía', 'Unidad de medida', 'Valor en Aduana declarado',
  'Moneda', 'País de procedencia', 'Fecha de arribo a territorio nacional', 'No. de guía aérea',
  'Tasa global o cuota aplicada', 'Regulaciones y restricciones no arancelarias',
  'Clave de Aduana de entrada', 'Clave de Aduana de despacho',
  'Consignatario Nombre/razón social', 'Consignatario RFC', 'Consignatario CURP',
  'Consignatario ID Fiscal país residencia', 'Consignatario No. Seguridad Social',
  'Consignatario No. pasaporte', 'Consignatario Domicilio', 'Consignatario Teléfono', 'Consignatario Correo',
  'Remitente Nombre/razón social', 'Remitente Id fiscal', 'Remitente Domicilio', 'Remitente Teléfono', 'Remitente Correo',
  'Plataforma Nombre comercial', 'Plataforma País de origen', 'Plataforma Razón social', 'Plataforma Correo',
] as const;

export function toLayoutRows(shipments: Shipment[]): Record<string, string>[] {
  return shipments.map((s) => {
    const v = [
      s.t1RegistryId ?? '', s.patente ?? '', s.pedimentoNumber ?? '', s.description,
      s.hsCode, String(s.quantity), s.unit, String(s.customsValueUsd),
      s.currency, s.originCountry, s.arrivalDate ?? '', s.guideId,
      s.appliedRate != null ? String(s.appliedRate) : '', s.rrnaNote ?? '',
      s.customsEntryCode ?? '', s.customsClearanceCode ?? '',
      s.consignee.name, s.consignee.rfc, s.consignee.curp ?? '',
      s.consignee.foreignTaxId ?? '', s.consignee.socialSecurity ?? '',
      s.consignee.passport ?? '', s.consignee.address ?? '', s.consignee.phone ?? '', s.consignee.email ?? '',
      s.sender.name, s.sender.taxId ?? '', s.sender.address ?? '', s.sender.phone ?? '', s.sender.email ?? '',
      s.platform.commercialName, s.platform.countryOfOrigin ?? '', s.platform.legalName ?? '', s.platform.email ?? '',
    ];
    return Object.fromEntries(LAYOUT_HEADERS.map((h, i) => [h, v[i]]));
  });
}
```

- [ ] **Step 4: Write + implement the Reporte General builder**

`shared/export/reportBuilder.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { buildReportRows } from './reportBuilder';

describe('buildReportRows', () => {
  it('merges shipment + risk + pedimento partida + client into one row', () => {
    const rows = buildReportRows({
      shipments: [{ guideId: 'g1', consignee: { name: 'Juan' }, customsValueUsd: 120 } as any],
      riskByGuide: { g1: { color: 'rojo', incidences: ['Piratería (Nike)'] } },
      client: { name: 'Cliente A', taxId: 'C1' },
    });
    expect(rows[0].Guia).toBe('g1');
    expect(rows[0].Resultado).toBe('rojo');
    expect(rows[0].Cliente).toBe('Cliente A');
  });
});
```

`shared/export/reportBuilder.ts`:
```ts
import type { Shipment } from '../types/shipment';

export interface ReportInput {
  shipments: Shipment[];
  riskByGuide: Record<string, { color: string; incidences: string[] }>;
  client: { name: string; taxId?: string };
}

export function buildReportRows(input: ReportInput): Record<string, string>[] {
  return input.shipments.map((s) => {
    const r = input.riskByGuide[s.guideId] ?? { color: '', incidences: [] };
    return {
      Guia: s.guideId,
      Destinatario: s.consignee.name,
      ValorUSD: String(s.customsValueUsd),
      Resultado: r.color,
      Motivo: r.incidences.join('; '),
      Cliente: input.client.name,
      ClienteIdFiscal: input.client.taxId ?? '',
    };
  });
}
```

- [ ] **Step 5: Run both to verify they pass**

Run: `cd shared && npx vitest run export/`
Expected: PASS (3 tests total).

- [ ] **Step 6: Commit**

```bash
git add shared/export/ 
git commit -m "feat(export): 34-column LayOut export + Reporte General builder"
```

---

### Task 5: Export endpoints (risk.xlsx, report.xlsx, layout.xlsx)

**Files:**
- Create: `server/src/routes/exports.ts`
- Modify: `server/src/app.ts`
- Test: `server/test/routes/exports.test.ts`

- [ ] **Step 1: Write the failing test**

`server/test/routes/exports.test.ts`:
```ts
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import * as XLSX from 'xlsx';
import { createApp } from '../../src/app';
import { hashPassword } from '../../src/auth/password';
import { signToken } from '../../src/auth/token';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

const app = createApp();
let token: string; let manifestId: string;

beforeEach(async () => {
  await truncateAll();
  const hash = await hashPassword('p');
  const u = await query(`INSERT INTO users (username,password_hash,role) VALUES ('c',$1,'capturista') RETURNING id`, [hash]);
  token = signToken({ userId: u.rows[0].id, role: 'capturista' });
  const m = await query(`INSERT INTO manifests (mawb_reference, client_name) VALUES ('369-1','Cliente A') RETURNING id`);
  manifestId = m.rows[0].id;
  const s = { id: crypto.randomUUID(), mawbReference: '369-1', description: 'TRAJE', hsCode: '99010001',
    quantity: 1, unit: '6', customsValueUsd: 120, currency: 'USD', originCountry: 'CN', guideId: 'g1',
    consignee: { name: 'Juan', rfc: 'TOMM020922D40' }, sender: { name: 'S' }, platform: { commercialName: 'P' } };
  await query('INSERT INTO shipments (id,manifest_id,data,risk_color) VALUES ($1,$2,$3,$4)', [s.id, manifestId, JSON.stringify(s), 'verde']);
});

describe('exports', () => {
  it('returns a parseable LayOut workbook with 34 columns', async () => {
    const res = await request(app).get(`/api/records/${manifestId}/layout.xlsx`).set('Authorization', `Bearer ${token}`).buffer().parse((r, cb) => {
      const chunks: Buffer[] = []; r.on('data', (c) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    const wb = XLSX.read(res.body, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const json = XLSX.utils.sheet_to_json(sheet);
    expect(Object.keys(json[0] as object)).toHaveLength(34);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx vitest run test/routes/exports.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`server/src/routes/exports.ts`:
```ts
import { Router } from 'express';
import * as XLSX from 'xlsx';
import { query } from '../db/pool';
import { requireAuth } from '../auth/middleware';
import { recordAudit } from '../services/audit';
import { toLayoutRows } from '../../../shared/export/layoutExport';
import { buildReportRows } from '../../../shared/export/reportBuilder';
import type { Shipment } from '../../../shared/types/shipment';

export const exportsRouter = Router();

function workbook(rows: Record<string, unknown>[]): Buffer {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Hoja1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function send(res: any, buf: Buffer, name: string) {
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
}

async function loadShipments(manifestId: string): Promise<{ data: Shipment; risk_color: string | null }[]> {
  const { rows } = await query<{ data: Shipment; risk_color: string | null }>(
    'SELECT data, risk_color FROM shipments WHERE manifest_id=$1', [manifestId]);
  return rows;
}

exportsRouter.get('/:id/layout.xlsx', requireAuth, async (req, res) => {
  const rows = await loadShipments(req.params.id);
  send(res, workbook(toLayoutRows(rows.map((r) => r.data))), 'LayOut_sistema.xlsx');
  await recordAudit({ userId: req.user!.userId, action: 'EXPORT_LAYOUT', entity: 'manifest', entityId: req.params.id });
});

exportsRouter.get('/:id/risk.xlsx', requireAuth, async (req, res) => {
  const rows = await loadShipments(req.params.id);
  const out = rows.map((r) => ({ Guia: r.data.guideId, Destinatario: r.data.consignee.name, Resultado: r.risk_color ?? '' }));
  send(res, workbook(out), 'Analisis_de_Riesgo.xlsx');
  await recordAudit({ userId: req.user!.userId, action: 'EXPORT_RISK', entity: 'manifest', entityId: req.params.id });
});

exportsRouter.get('/:id/report.xlsx', requireAuth, async (req, res) => {
  const m = await query(`SELECT client_name FROM manifests WHERE id=$1`, [req.params.id]);
  const rows = await loadShipments(req.params.id);
  const reportRows = buildReportRows({
    shipments: rows.map((r) => r.data),
    riskByGuide: Object.fromEntries(rows.map((r) => [r.data.guideId, { color: r.risk_color ?? '', incidences: [] }])),
    client: { name: m.rows[0]?.client_name ?? '' },
  });
  send(res, workbook(reportRows), 'Reporte_General.xlsx');
  await recordAudit({ userId: req.user!.userId, action: 'EXPORT_REPORT', entity: 'manifest', entityId: req.params.id });
});
```

- [ ] **Step 4: Mount + run**

Add `app.use('/api/records', exportsRouter)` to `app.ts` (after `recordsRouter`). Run:
`cd server && npx vitest run test/routes/exports.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/exports.ts server/src/app.ts server/test/routes/exports.test.ts
git commit -m "feat(server): xlsx exports — layout, risk, report"
```

---

### Task 6: Per-user dashboard endpoint

**Files:**
- Create: `server/src/routes/dashboard.ts`
- Modify: `server/src/app.ts`
- Test: `server/test/routes/dashboard.test.ts`

- [ ] **Step 1: Write the failing test**

`server/test/routes/dashboard.test.ts`:
```ts
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { hashPassword } from '../../src/auth/password';
import { signToken } from '../../src/auth/token';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

const app = createApp();
let token: string; let userId: string;

beforeEach(async () => {
  await truncateAll();
  const hash = await hashPassword('p');
  const u = await query(`INSERT INTO users (username,password_hash,role) VALUES ('c',$1,'capturista') RETURNING id`, [hash]);
  userId = u.rows[0].id; token = signToken({ userId, role: 'capturista' });
  const m = await query(`INSERT INTO manifests (mawb_reference, created_by) VALUES ('369-1',$1) RETURNING id`, [userId]);
  const mid = m.rows[0].id;
  const mk = (color: string) => query('INSERT INTO shipments (id,manifest_id,data,risk_color) VALUES (gen_random_uuid(),$1,$2,$3)', [mid, '{}', color]);
  await mk('verde'); await mk('amarillo'); await mk('rojo');
});

describe('GET /api/dashboard', () => {
  it('returns per-user counts and risk distribution', async () => {
    const res = await request(app).get('/api/dashboard').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.manifests).toBe(1);
    expect(res.body.distribution).toEqual({ verde: 1, amarillo: 1, rojo: 1 });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx vitest run test/routes/dashboard.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`server/src/routes/dashboard.ts`:
```ts
import { Router } from 'express';
import { query } from '../db/pool';
import { requireAuth } from '../auth/middleware';

export const dashboardRouter = Router();

dashboardRouter.get('/', requireAuth, async (req, res) => {
  const uid = req.user!.userId;
  const m = await query(`SELECT count(*)::int AS n FROM manifests WHERE created_by=$1`, [uid]);
  const d = await query(
    `SELECT s.risk_color, count(*)::int AS n
     FROM shipments s JOIN manifests mf ON mf.id=s.manifest_id
     WHERE mf.created_by=$1 AND s.risk_color IS NOT NULL GROUP BY s.risk_color`, [uid]);
  const distribution: Record<string, number> = { verde: 0, amarillo: 0, rojo: 0 };
  for (const row of d.rows) distribution[row.risk_color] = row.n;
  res.json({ manifests: m.rows[0].n, distribution });
});
```

- [ ] **Step 4: Mount + run**

Add `app.use('/api/dashboard', dashboardRouter)`. Run:
`cd server && npx vitest run test/routes/dashboard.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/dashboard.ts server/src/app.ts server/test/routes/dashboard.test.ts
git commit -m "feat(server): per-user dashboard metrics"
```

---

### Task 7: Audit-log append-only enforcement (compliance hardening)

**Files:**
- Create: `server/migrations/1700000400000_audit_append_only.ts`
- Test: `server/test/services/auditImmutable.test.ts`

- [ ] **Step 1: Write the migration (DB trigger blocking UPDATE/DELETE)**

`server/migrations/1700000400000_audit_append_only.ts`:
```ts
import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION audit_block_mutation() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'audit_log is append-only'; END;
    $$ LANGUAGE plpgsql;
  `);
  pgm.sql(`
    CREATE TRIGGER audit_no_update_delete
    BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION audit_block_mutation();
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`DROP TRIGGER IF EXISTS audit_no_update_delete ON audit_log;`);
  pgm.sql(`DROP FUNCTION IF EXISTS audit_block_mutation();`);
}
```
Run: `cd server && npm run migrate up && DATABASE_URL=$TEST_DATABASE_URL npm run migrate up`

- [ ] **Step 2: Write the failing test**

`server/test/services/auditImmutable.test.ts`:
```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { recordAudit } from '../../src/services/audit';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

describe('audit immutability', () => {
  beforeEach(truncateAll);

  it('blocks UPDATE and DELETE on audit_log', async () => {
    await recordAudit({ userId: null, action: 'LOGIN' });
    await expect(query(`UPDATE audit_log SET action='X'`)).rejects.toThrow(/append-only/);
    await expect(query(`DELETE FROM audit_log`)).rejects.toThrow(/append-only/);
  });
});
```

Note: `truncateAll` uses TRUNCATE (not DELETE), which bypasses row triggers, so test isolation still works.

- [ ] **Step 3: Run to verify it passes**

Run: `cd server && npx vitest run test/services/auditImmutable.test.ts`
Expected: PASS (1 test).

- [ ] **Step 4: Commit**

```bash
git add server/migrations/1700000400000_audit_append_only.ts server/test/services/auditImmutable.test.ts
git commit -m "feat(server): enforce append-only audit_log at DB level"
```

---

### Task 8: Full suite green + manual smoke

**Files:** none (verification task)

- [ ] **Step 1: Run all server tests**

Run: `cd server && npm test`
Expected: all suites PASS.

- [ ] **Step 2: Run all shared tests**

Run: `cd shared && npx vitest run`
Expected: all PASS.

- [ ] **Step 3: Run client tests + typecheck**

Run: `npx vitest run && npm run lint`
Expected: PASS, `tsc` exits 0.

- [ ] **Step 4: Manual smoke**

Run server (`npm run server:dev`) and client (`npm run dev`); log in, upload a manifest, run risk, generate pedimento, export the three artifacts, view the dashboard. Confirm each writes an audit row (`SELECT action FROM audit_log ORDER BY id`).

- [ ] **Step 5: Commit any fixes, then finish the branch**

Use the `superpowers:finishing-a-development-branch` skill to open a PR.

---

## Self-Review Notes (coverage of spec §3.5 + compliance pillars)
- Six sections: Login (Task 2), Realizar Registro (reuses upload + risk from plans 02/03), Seguimiento + Consulta (Task 3), Reporte General (Tasks 4/5), Dashboard (Task 6), Acerca de (Task 2).
- Records keyed by `MAWB – Cliente` (Task 3 search). Three artifacts per record surfaced in Consulta (Task 3) and produced by exports (Task 5).
- "Generar Reporte" Excel + the flat 34-column LayOut export (Tasks 4/5). Per-user dashboard (Task 6).
- Government-compliance: every mutating/export endpoint writes an audit row; append-only enforced at the DB level (Task 7).
- Reused: `Shipment`/`Pedimento` types, risk colors, `toLayoutRows`/`buildReportRows`, `recordAudit`, `requireAuth`/`requireRole` — all from plans 01–04, names unchanged.
- Note: the client views for Seguimiento data-capture form and Reporte client-catalog form consume the endpoints above; their detailed field forms reuse the `ConsigneeData`/`SenderData`/`PlatformData` shapes from plan 02 and are wired in Task 2's `App.tsx` routing.
