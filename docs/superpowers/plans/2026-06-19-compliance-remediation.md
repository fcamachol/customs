# Compliance Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every gap found in the 2026-06-19 PRD/ANAM compliance audit so the Riesgo T1 platform can pass AGACE evaluation and operate on real data.

**Architecture:** Monorepo — `shared/` (parsing, risk, export, pedimento), `server/` (Express + PostgreSQL via `node-pg-migrate`), `src/` (React 19 + Vite client). Convergence principle: the **`shared/` risk pipeline is canonical**; the legacy `src/engine/*` tax path is removed from the operative flow (PRD §10 forbids contribution calculation). Persistence stays self-hosted (Postgres + local volume) for data sovereignty.

**Tech Stack:** TypeScript, Express 4, PostgreSQL, `node-pg-migrate`, `xlsx`, `bcrypt`, `jsonwebtoken`, `otplib` (new, for MFA), Node `crypto` (hash chain + AES-256-GCM), Vitest, React 19.

## Global Constraints

- **Tasa global is captured, never calculated** (PRD §10). No code path may compute contributions/IGI/IVA/DTA in the operative flow.
- **Generic fraction is `9901000100`, unit `PCS`, RRNA `N/A`** in the T1 layout output (LayOut_sistema.xlsx), regardless of per-item manifest values.
- **Three roles only:** `admin`, `capturista`, `autoridad`. `autoridad` is strictly read-only. All `capturista` users share visibility of every record.
- **Every consequential action writes an audit row** with `user_id, action, entity, entity_id, before, after, ip_address` and a **chained SHA-256 hash** (`prev_hash` → `hash`). Audit table is append-only.
- **No secrets in source.** Server refuses to boot in production with a default `JWT_SECRET` or missing `FIELD_ENCRYPTION_KEY`.
- **Record identifier is `MAWB – Cliente`** throughout.
- Run server tests with `npm --prefix server test`; shared/client tests with `npm test`. TDD: failing test first, minimal code, green, commit.
- Each task = one atomic commit. Conventional Commit messages.

---

## File Structure (created/modified)

| Area | Files |
|---|---|
| Manifest ingestion | `shared/parsing/headerSynonyms.ts`, `shared/parsing/manifestParser.ts`, `shared/types/shipment.ts`, `shared/parsing/normalize.ts` (new) |
| Risk engine | `shared/risk/signals.ts`, `shared/risk/classify.ts`, `shared/risk/lists.ts`, `shared/risk/ruleset.ts` (new), `shared/risk/match.ts` (new) |
| Layout/report | `shared/export/layoutExport.ts`, `shared/export/reportBuilder.ts` |
| Audit integrity | `server/migrations/1700000700000_audit_hash_chain.ts` (new), `server/src/services/audit.ts`, `server/src/db/tx.ts` (new), `server/src/services/auditVerify.ts` (new), `server/src/routes/audit.ts` |
| Import-data capture | `server/migrations/1700000800000_import_data.ts` (new), `server/src/routes/importData.ts` (new), `src/components/SeguimientoView.tsx` |
| Artifact persistence | `server/migrations/1700000900000_artifact_files.ts` (new), `server/src/services/artifacts.ts` (new), `server/src/routes/risk.ts`, `server/src/routes/exports.ts` |
| RBAC/visibility | `server/src/auth/access.ts`, `server/src/routes/{manifests,pedimentoUpload,risk}.ts` |
| Catalogs & branding | `server/migrations/1700001000000_catalogs.ts` (new), `server/src/routes/catalogs.ts` (new), `src/components/ConfigurationView.tsx`, `src/components/ReporteGeneralView.tsx` |
| Consolidated report | `server/src/routes/consolidated.ts` (new) |
| MFA | `server/migrations/1700001100000_mfa.ts` (new), `server/src/auth/mfa.ts` (new), `server/src/routes/auth.ts` |
| PII at rest | `server/src/crypto/fieldCrypto.ts` (new), `server/src/index.ts` |
| Acerca de / branding UI | `src/components/AcercaDeView.tsx`, `src/components/DashboardView.tsx` |

---

# PHASE 0 — Blockers (must land first)

## Task 1: Manifest parser reads the real 28-column manifest

**Files:**
- Modify: `shared/parsing/headerSynonyms.ts`
- Test: `shared/parsing/headerSynonyms.test.ts`

**Interfaces:**
- Produces: `resolveHeader(raw: string): string | null` (unchanged signature) now resolving the 28 real input headers from `MANIFEST_TEST.xlsx` in addition to the layout headers.

Real input headers (from `/tmp/customs_docs/MANIFEST_TEST.txt`): `MWB`, `Número de guía de embarque`, `Expedidor`, `Dirección del remitente`, `Nombre/Código de ciudad del remitente`, `Nombre/Código de país del remitente`, `ID`, `Destinatario (CNNE)`, `Email`, `Dirección de CNNE`, `Nombre de ciudad de CNNE`, `Teléfono de CNNE`, `Código postal de CNNE`, `Nombre/Código de país CNNE`, `Peso`, `Unidad de peso`, `Descripción del Producto`, `Código HS`, `Precio unitario declarado`, `Número de productos`, `Divisa`, `Valor total declarado`, `Bulto`, `N° de pedido del cliente`, `URL`.

- [ ] **Step 1: Write failing tests**

```ts
// shared/parsing/headerSynonyms.test.ts — ADD these cases
import { describe, it, expect } from 'vitest';
import { resolveHeader } from './headerSynonyms';

describe('real manifest headers', () => {
  it('maps the 28 MANIFEST_TEST input headers', () => {
    expect(resolveHeader('MWB')).toBe('core.mawb');
    expect(resolveHeader('Número de guía de embarque')).toBe('core.guideId');
    expect(resolveHeader('Destinatario (CNNE)')).toBe('consignee.name');
    expect(resolveHeader('ID')).toBe('consignee.rfc');
    expect(resolveHeader('Email')).toBe('consignee.email');
    expect(resolveHeader('Dirección de CNNE')).toBe('consignee.address');
    expect(resolveHeader('Teléfono de CNNE')).toBe('consignee.phone');
    expect(resolveHeader('Peso')).toBe('core.weight');
    expect(resolveHeader('Unidad de peso')).toBe('core.weightUnit');
    expect(resolveHeader('Descripción del Producto')).toBe('core.description');
    expect(resolveHeader('Código HS')).toBe('core.hsCode');
    expect(resolveHeader('Precio unitario declarado')).toBe('core.unitPrice');
    expect(resolveHeader('Número de productos')).toBe('core.quantity');
    expect(resolveHeader('Divisa')).toBe('core.currency');
    expect(resolveHeader('Valor total declarado')).toBe('core.customsValueUsd');
    expect(resolveHeader('Expedidor')).toBe('sender.name');
    expect(resolveHeader('Dirección del remitente')).toBe('sender.address');
    expect(resolveHeader('Nombre/Código de país del remitente')).toBe('sender.countryCode');
    expect(resolveHeader('Bulto')).toBe('core.bulto');
    expect(resolveHeader('URL')).toBe('platform.url');
  });
  it('still maps existing layout headers', () => {
    expect(resolveHeader('Fracción arancelaria')).toBe('core.hsCode');
  });
});
```

- [ ] **Step 2: Run, verify fail** — `npm test -- headerSynonyms` → FAIL.

- [ ] **Step 3: Implement** — add the input-manifest synonyms to `TABLE` in `shared/parsing/headerSynonyms.ts` (keys are already `normalize()`d at lookup, so write them in any casing — but `TABLE` keys must be pre-normalized; add lowercase-accentless forms):

```ts
  // --- real input-manifest headers (MANIFEST_TEST.xlsx) ---
  'mwb': 'core.mawb',
  'numero de guia de embarque': 'core.guideId',
  'expedidor': 'sender.name',
  'direccion del remitente': 'sender.address',
  'nombrecodigo de ciudad del remitente': 'sender.city',
  'nombrecodigo de pais del remitente': 'sender.countryCode',
  'id': 'consignee.rfc',
  'destinatario cnne': 'consignee.name',
  'email': 'consignee.email',
  'direccion de cnne': 'consignee.address',
  'nombre de ciudad de cnne': 'consignee.city',
  'telefono de cnne': 'consignee.phone',
  'codigo postal de cnne': 'consignee.postalCode',
  'nombrecodigo de pais cnne': 'consignee.countryCode',
  'peso': 'core.weight',
  'unidad de peso': 'core.weightUnit',
  'descripcion del producto': 'core.description',
  'codigo hs': 'core.hsCode',
  'precio unitario declarado': 'core.unitPrice',
  'numero de productos': 'core.quantity',
  'divisa': 'core.currency',
  'valor total declarado': 'core.customsValueUsd',
  'bulto': 'core.bulto',
  'n de pedido del cliente': 'core.clientOrderId',
  'url': 'platform.url',
```

Note: `normalize()` strips `/` and `(`, collapses spaces — `Nombre/Código de país CNNE` → `nombrecodigo de pais cnne`; `Destinatario (CNNE)` → `destinatario cnne`. Verify each key against `normalize()` output.

- [ ] **Step 4: Run, verify pass** — `npm test -- headerSynonyms` → PASS.

- [ ] **Step 5: Commit** — `git commit -am "fix(parsing): map the 28 real MANIFEST_TEST input headers"`

---

## Task 2: Extend Shipment model + numeric/weight normalization

**Files:**
- Create: `shared/parsing/normalize.ts`
- Modify: `shared/types/shipment.ts`, `shared/parsing/manifestParser.ts`
- Test: `shared/parsing/normalize.test.ts`, `shared/parsing/manifestParser.test.ts`

**Interfaces:**
- Produces: `parseNumber(raw: string): number` (handles `"0,79"` → `0.79`), `toKg(value: number, unit: string): number`. New `ShipmentCore` fields: `mawb?`, `weight?`, `weightUnit?`, `weightKg?`, `unitPrice?`, `bulto?`, `clientOrderId?`; new `consignee.city/postalCode/countryCode`, `sender.city/countryCode`, `platform.url`.

- [ ] **Step 1: Write failing tests**

```ts
// shared/parsing/normalize.test.ts
import { describe, it, expect } from 'vitest';
import { parseNumber, toKg } from './normalize';

describe('parseNumber', () => {
  it('parses comma decimals', () => { expect(parseNumber('0,79')).toBe(0.79); });
  it('parses dot decimals', () => { expect(parseNumber('8.95')).toBe(8.95); });
  it('strips thousands separators', () => { expect(parseNumber('1.234,50')).toBe(1234.5); });
  it('handles blank', () => { expect(parseNumber('')).toBe(0); });
});
describe('toKg', () => {
  it('converts grams to kg', () => { expect(toKg(500, 'gramo')).toBe(0.5); });
  it('keeps kg', () => { expect(toKg(2, 'KG')).toBe(2); });
});
```

```ts
// shared/parsing/manifestParser.test.ts — ADD
it('normalizes comma decimal value from a real-shaped row', () => {
  const { shipments } = parseManifestRows(
    [{ 'Valor total declarado': '0,79', 'Número de productos': '3', 'Peso': '500', 'Unidad de peso': 'gramo', 'Destinatario (CNNE)': 'Juan' }],
    '369-1');
  expect(shipments[0].customsValueUsd).toBe(0.79);
  expect(shipments[0].quantity).toBe(3);
  expect(shipments[0].weightKg).toBe(0.5);
  expect(shipments[0].consignee.name).toBe('Juan');
});
```

- [ ] **Step 2: Run, verify fail** — `npm test -- normalize manifestParser` → FAIL.

- [ ] **Step 3a: Implement `shared/parsing/normalize.ts`**

```ts
// Parse a human-entered number that may use comma decimals or dot/space thousands separators.
export function parseNumber(raw: string): number {
  const s = String(raw ?? '').trim();
  if (!s) return 0;
  let t = s.replace(/[^\d.,-]/g, '');
  const lastComma = t.lastIndexOf(','), lastDot = t.lastIndexOf('.');
  if (lastComma > lastDot) t = t.replace(/\./g, '').replace(',', '.'); // comma is decimal
  else t = t.replace(/,/g, '');                                        // dot is decimal
  const n = Number(t);
  return Number.isFinite(n) ? n : 0;
}

export function toKg(value: number, unit: string): number {
  const u = (unit ?? '').trim().toLowerCase();
  if (u.startsWith('g')) return value / 1000;          // gramo/g/grams
  return value;                                         // kg default
}
```

- [ ] **Step 3b: Extend `shared/types/shipment.ts`** — add to `ShipmentCore`:

```ts
  mawb?: string;
  weight?: number;
  weightUnit?: string;
  weightKg?: number;
  unitPrice?: number;
  bulto?: string;
  clientOrderId?: string;
```
and to `ConsigneeData`: `city?: string; postalCode?: string; countryCode?: string;`; to `SenderData`: `city?: string; countryCode?: string;`; to `PlatformData`: `url?: string;`.

- [ ] **Step 3c: Update `shared/parsing/manifestParser.ts`** — replace numeric handling and add weight derivation:

```ts
import { parseNumber, toKg } from './normalize';
// ...inside the for-loop, replace the quantity/value/appliedRate branches with:
      if (path === 'core.quantity') { s.quantity = parseNumber(value); continue; }
      if (path === 'core.customsValueUsd') { s.customsValueUsd = parseNumber(value); continue; }
      if (path === 'core.unitPrice') { s.unitPrice = parseNumber(value); continue; }
      if (path === 'core.weight') { s.weight = parseNumber(value); continue; }
      if (path === 'core.appliedRate') { s.appliedRate = parseNumber(value); continue; }
// ...after the loop, before `return s as Shipment;`:
    if (s.weight != null) s.weightKg = toKg(s.weight, s.weightUnit ?? '');
```
Also add `mawb` and the new nested keys to `blankShipment` defaults (`consignee`, `sender`, `platform` already objects — new optional keys need no default).

- [ ] **Step 4: Run, verify pass** — `npm test -- normalize manifestParser` → PASS.

- [ ] **Step 5: Commit** — `git commit -am "feat(parsing): extend Shipment model + comma/gram normalization (RF-02)"`

---

## Task 3: Chained-hash, IP-stamped audit trail (RF-21 / RNF-09 / RNF-10)

**Files:**
- Create: `server/migrations/1700000700000_audit_hash_chain.ts`, `server/src/db/tx.ts`, `server/src/services/auditVerify.ts`
- Modify: `server/src/services/audit.ts`, `server/src/routes/audit.ts`, all `recordAudit` call sites (pass `ip`)
- Test: `server/test/auditChain.test.ts`

**Interfaces:**
- Produces: `recordAudit(e: AuditEntry): Promise<void>` where `AuditEntry` gains `ip?: string | null`; `verifyAuditChain(): Promise<{ ok: boolean; brokenAtId?: string }>`; `withTransaction(fn)`.

- [ ] **Step 1: Migration** — `server/migrations/1700000700000_audit_hash_chain.ts`:

```ts
import type { MigrationBuilder } from 'node-pg-migrate';
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumns('audit_log', {
    ip_address: { type: 'text' },
    prev_hash: { type: 'text' },
    hash: { type: 'text' },
  });
}
export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumns('audit_log', ['ip_address', 'prev_hash', 'hash']);
}
```

- [ ] **Step 2: Transaction helper** — `server/src/db/tx.ts`:

```ts
import { pool } from './pool';
export async function withTransaction<T>(fn: (q: (text: string, params?: unknown[]) => Promise<any>) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn((text, params) => client.query(text, params as any[]));
    await client.query('COMMIT');
    return out;
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}
```

- [ ] **Step 3: Write failing test** — `server/test/auditChain.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '../src/db/pool';
import { recordAudit } from '../src/services/audit';
import { verifyAuditChain } from '../src/services/auditVerify';

describe('audit hash chain', () => {
  beforeEach(async () => { await query('TRUNCATE audit_log RESTART IDENTITY CASCADE'); });
  it('links each row to the previous hash and verifies intact', async () => {
    await recordAudit({ userId: null, action: 'LOGIN', ip: '10.0.0.1' });
    await recordAudit({ userId: null, action: 'RUN_RISK', entity: 'manifest', entityId: 'm1', ip: '10.0.0.2' });
    const { rows } = await query<{ prev_hash: string|null; hash: string; ip_address: string }>(
      'SELECT prev_hash, hash, ip_address FROM audit_log ORDER BY id');
    expect(rows[0].prev_hash).toBeNull();
    expect(rows[1].prev_hash).toBe(rows[0].hash);
    expect(rows[1].ip_address).toBe('10.0.0.2');
    expect((await verifyAuditChain()).ok).toBe(true);
  });
  it('detects tampering when a payload is mutated', async () => {
    await recordAudit({ userId: null, action: 'LOGIN', ip: '10.0.0.1' });
    // simulate storage-layer tampering by disabling the append-only trigger
    await query('ALTER TABLE audit_log DISABLE TRIGGER audit_no_update_delete');
    await query(`UPDATE audit_log SET action='HACKED' WHERE id=(SELECT min(id) FROM audit_log)`);
    await query('ALTER TABLE audit_log ENABLE TRIGGER audit_no_update_delete');
    expect((await verifyAuditChain()).ok).toBe(false);
  });
});
```

- [ ] **Step 4: Run, verify fail** — `npm --prefix server test -- auditChain` → FAIL.

- [ ] **Step 5: Implement `server/src/services/audit.ts`**

```ts
import { createHash } from 'node:crypto';
import { withTransaction } from '../db/tx';

export interface AuditEntry {
  userId: string | null; action: string; entity?: string; entityId?: string;
  before?: unknown; after?: unknown; ip?: string | null;
}

export function canonicalPayload(e: AuditEntry, createdAtIso: string): string {
  return JSON.stringify({
    userId: e.userId ?? null, action: e.action, entity: e.entity ?? null,
    entityId: e.entityId ?? null, before: e.before ?? null, after: e.after ?? null,
    ip: e.ip ?? null, createdAt: createdAtIso,
  });
}
export function rowHash(prevHash: string | null, payload: string): string {
  return createHash('sha256').update((prevHash ?? '') + payload).digest('hex');
}

export async function recordAudit(e: AuditEntry): Promise<void> {
  await withTransaction(async (q) => {
    await q('SELECT pg_advisory_xact_lock(91234567)'); // serialize chain appends
    const prev = await q('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1');
    const prevHash: string | null = prev.rows[0]?.hash ?? null;
    const createdAt = new Date().toISOString();
    const payload = canonicalPayload(e, createdAt);
    const hash = rowHash(prevHash, payload);
    await q(
      `INSERT INTO audit_log (user_id, action, entity, entity_id, before, after, ip_address, prev_hash, hash, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [e.userId, e.action, e.entity ?? null, e.entityId ?? null,
       e.before ? JSON.stringify(e.before) : null, e.after ? JSON.stringify(e.after) : null,
       e.ip ?? null, prevHash, hash, createdAt]);
  });
}
```

- [ ] **Step 6: Implement `server/src/services/auditVerify.ts`**

```ts
import { query } from '../db/pool';
import { canonicalPayload, rowHash, type AuditEntry } from './audit';

export async function verifyAuditChain(): Promise<{ ok: boolean; brokenAtId?: string }> {
  const { rows } = await query<any>(
    `SELECT id, user_id, action, entity, entity_id, before, after, ip_address, prev_hash, hash, created_at
     FROM audit_log ORDER BY id`);
  let prevHash: string | null = null;
  for (const r of rows) {
    const e: AuditEntry = { userId: r.user_id, action: r.action, entity: r.entity ?? undefined,
      entityId: r.entity_id ?? undefined, before: r.before ?? undefined, after: r.after ?? undefined, ip: r.ip_address };
    const payload = canonicalPayload(e, new Date(r.created_at).toISOString());
    if (r.prev_hash !== prevHash || r.hash !== rowHash(prevHash, payload)) return { ok: false, brokenAtId: String(r.id) };
    prevHash = r.hash;
  }
  return { ok: true };
}
```

- [ ] **Step 7: Stamp IP at every call site** — pass `ip: req.ip` to all `recordAudit({...})` calls in `routes/{auth,manifests,pedimentoUpload,risk,pedimento,exports,files}.ts`. Enable `app.set('trust proxy', true)` in `server/src/app.ts` (line after `const app = express();`) so `req.ip` reflects the real client behind the proxy.

- [ ] **Step 8: Add verify endpoint** — in `server/src/routes/audit.ts`, add:

```ts
import { verifyAuditChain } from '../services/auditVerify';
auditRouter.get('/verify', requireAuth, requireRole('autoridad', 'admin'), async (_req, res) => {
  res.json(await verifyAuditChain());
});
```

- [ ] **Step 9: Run, verify pass** — `npm --prefix server test -- auditChain` → PASS (both cases).

- [ ] **Step 10: Commit** — `git commit -am "feat(audit): SHA-256 chained, IP-stamped audit trail + verify endpoint (RF-21/RNF-09/10)"`

---

## Task 4: Wire Seguimiento import-data capture to the backend (RF-09)

**Files:**
- Create: `server/migrations/1700000800000_import_data.ts`, `server/src/routes/importData.ts`
- Modify: `server/src/app.ts`, `src/components/SeguimientoView.tsx`
- Test: `server/test/importData.test.ts`

**Interfaces:**
- Produces: `POST /api/manifests/:id/import-data` body `{ cveT1, patente, agenteAduanal, tasaImportacion, fechaEntrada, claveAduanaEntrada, claveAduanaDespacho }` → persists to `manifests.import_data` jsonb; `requireRole('admin','capturista')`; audited.

- [ ] **Step 1: Migration** — `1700000800000_import_data.ts`:

```ts
import type { MigrationBuilder } from 'node-pg-migrate';
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumns('manifests', { import_data: { type: 'jsonb' } });
}
export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumns('manifests', ['import_data']);
}
```

- [ ] **Step 2: Write failing test** — `server/test/importData.test.ts` (follow the existing server test harness in `server/test/` for auth/setup; reuse its helper to create a manifest + capturista token). Assert `POST /api/manifests/:id/import-data` returns 200 and `SELECT import_data FROM manifests` contains the saved fields; assert an `autoridad` token gets 403.

- [ ] **Step 3: Run, verify fail** — `npm --prefix server test -- importData` → FAIL.

- [ ] **Step 4: Implement `server/src/routes/importData.ts`**

```ts
import { Router } from 'express';
import { query } from '../db/pool';
import { requireAuth, requireRole } from '../auth/middleware';
import { recordAudit } from '../services/audit';

export const importDataRouter = Router();
const FIELDS = ['cveT1','patente','agenteAduanal','tasaImportacion','fechaEntrada','claveAduanaEntrada','claveAduanaDespacho'] as const;

importDataRouter.post('/:id/import-data', requireAuth, requireRole('admin','capturista'), async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const data = Object.fromEntries(FIELDS.map((f) => [f, body[f] ?? null]));
  const before = await query('SELECT import_data FROM manifests WHERE id=$1', [req.params.id]);
  if (!before.rows.length) { res.status(404).json({ error: 'Not found' }); return; }
  await query('UPDATE manifests SET import_data=$1 WHERE id=$2', [JSON.stringify(data), req.params.id]);
  await recordAudit({ userId: req.user!.userId, action: 'CAPTURE_IMPORT_DATA', entity: 'manifest',
    entityId: req.params.id, before: before.rows[0].import_data, after: data, ip: req.ip });
  res.json({ ok: true, importData: data });
});
```
Register in `server/src/app.ts`: `import { importDataRouter } from './routes/importData';` then `app.use('/api/manifests', importDataRouter);`.

- [ ] **Step 5: Wire the React form** — in `src/components/SeguimientoView.tsx` replace the mock `handleSave` (lines 103-108) with a real POST and import `apiPost`:

```ts
import { apiGet, apiPost } from '../api';
// ...
  async function handleSave(e: FormEvent) {
    e.preventDefault();
    if (!selectedId) return;
    setSaveError(null); setSaveSuccess(false);
    try {
      await apiPost(`/api/manifests/${selectedId}/import-data`, {
        cveT1: form.claveT1, patente: form.patente, agenteAduanal: form.agenteAduanal,
        tasaImportacion: form.tasaImportacion, fechaEntrada: form.fechaEntrada,
        claveAduanaEntrada: form.claveAduanaEntrada, claveAduanaDespacho: form.claveAduanaDespacho,
      });
      setSaveSuccess(true);
    } catch (err) { setSaveError(err instanceof Error ? err.message : 'Error al guardar.'); }
  }
```
Remove any "la persistencia se conectará al backend" placeholder banner in this view.

- [ ] **Step 6: Run, verify pass** — `npm --prefix server test -- importData` → PASS; `npm test -- SeguimientoView` → PASS.

- [ ] **Step 7: Commit** — `git commit -am "feat(seguimiento): persist import-data capture to backend (RF-09)"`

---

## Task 5: Remove contribution calculation from the operative flow (§10)

**Files:**
- Modify: `src/components/ManifestUploadView.tsx`, `src/nav.ts`
- Delete (or quarantine): operative use of `src/engine/taxCalculator.ts`
- Test: `src/components/RegistroView.test.tsx` (confirm canonical path), grep assertion

**Interfaces:** none new. After this task the "Realizar registro" route renders `RegistroView` (canonical `shared/` pipeline), and no UI surfaces a "Liquidación estimada MXN".

- [ ] **Step 1: Confirm the canonical route** — verify `src/nav.ts` maps "Realizar registro" to `RegistroView` (which posts to `/api/manifests` then `/api/manifests/:id/risk`). If `ManifestUploadView` is still wired anywhere in `nav.ts`/`App.tsx`, repoint it to `RegistroView`.

- [ ] **Step 2: Write failing guard test** — `src/components/ManifestUploadView.test.tsx` (or extend RegistroView test):

```ts
it('does not render any tax/liquidación figure', () => {
  render(<RegistroView />);
  expect(screen.queryByText(/Liquidación/i)).toBeNull();
  expect(screen.queryByText(/IGI|IVA|DTA/)).toBeNull();
});
```

- [ ] **Step 3: Run, verify fail (if legacy view is active)** — `npm test -- ManifestUpload RegistroView`.

- [ ] **Step 4: Implement** — remove the liquidación/tax block and the `taxCalculator` import from `ManifestUploadView.tsx` (the "Liquidación estimada MXN" render at ~line 646 and its calculation). If `ManifestUploadView` is fully superseded by `RegistroView`, delete the file and its test, and remove references. Keep `src/engine/taxCalculator.ts` file only if other non-operative code imports it; otherwise delete it. Run `grep -rn "taxCalculator\|Liquidación\|calculateGlobalTax" src` to confirm zero operative references.

- [ ] **Step 5: Run, verify pass** — `npm test` (full client suite) → PASS.

- [ ] **Step 6: Commit** — `git commit -am "fix(registro): remove contribution calculation from operative flow (PRD §10)"`

---

# PHASE 1 — Must requirements still open

## Task 6: Inject fixed T1 layout values 9901000100 / PCS / N/A

**Files:** Modify `shared/export/layoutExport.ts`; Test `shared/export/layoutExport.test.ts`

**Interfaces:** `toLayoutRows(shipments)` now emits constant `Fracción arancelaria = '9901000100'`, `Unidad de medida = 'PCS'`, `Regulaciones... = 'N/A'` for every row.

- [ ] **Step 1: Failing test**

```ts
it('injects generic fraction, PCS unit, and N/A RRNA', () => {
  const rows = toLayoutRows([{ ...baseShipment, hsCode: '6109100022', unit: 'gramo' }]);
  expect(rows[0]['Fracción arancelaria']).toBe('9901000100');
  expect(rows[0]['Unidad de medida']).toBe('PCS');
  expect(rows[0]['Regulaciones y restricciones no arancelarias']).toBe('N/A');
});
```

- [ ] **Step 2: Run fail** — `npm test -- layoutExport`.

- [ ] **Step 3: Implement** — in `toLayoutRows`, replace `s.hsCode` → `'9901000100'`, `s.unit` → `'PCS'`, and the RRNA slot (`s.rrnaNote ?? ''`) → `'N/A'` in the `v` array. Add a `GENERIC_T1_FRACTION = '9901000100'` const at top.

- [ ] **Step 4: Run pass** — `npm test -- layoutExport`.

- [ ] **Step 5: Commit** — `git commit -am "fix(export): inject T1 fixed values 9901000100/PCS/N/A (§8.2)"`

---

## Task 7: Client & platform catalog (table + CRUD route)

**Files:** Create `server/migrations/1700001000000_catalogs.ts`, `server/src/routes/catalogs.ts`; Modify `server/src/app.ts`; Test `server/test/catalogs.test.ts`

**Interfaces:**
- `clients` table: `id, name, tax_id, address, phone, email, platform jsonb, created_by, created_at`.
- `GET /api/catalogs/clients`, `POST /api/catalogs/clients` (`admin`,`capturista`), `PUT /api/catalogs/clients/:id`, `DELETE` (`admin`). All audited.

- [ ] **Step 1: Migration** `1700001000000_catalogs.ts` — create `clients` table (columns above) plus a generic `config` table `{ key text pk, value jsonb, updated_by uuid, updated_at timestamptz }` (used by Tasks 11/14).

- [ ] **Step 2: Failing test** — `catalogs.test.ts`: POST a client as capturista → 201; GET lists it; PUT updates; DELETE as capturista → 403, as admin → 200; autoridad POST → 403.

- [ ] **Step 3: Run fail** — `npm --prefix server test -- catalogs`.

- [ ] **Step 4: Implement `server/src/routes/catalogs.ts`** — Router with the four handlers, parameterized SQL, `requireRole` gating per the interface, `recordAudit` with `ip: req.ip` on writes. Register `app.use('/api/catalogs', catalogsRouter)`.

- [ ] **Step 5: Run pass** — `npm --prefix server test -- catalogs`.

- [ ] **Step 6: Commit** — `git commit -am "feat(catalogs): client/platform catalog CRUD + config table (RF-24/RF-11)"`

---

## Task 8: Reporte General — full LayOut merge + catalog wiring (RF-11/RF-12)

**Files:** Modify `shared/export/reportBuilder.ts`, `server/src/routes/exports.ts`, `src/components/ReporteGeneralView.tsx`; Test `shared/export/reportBuilder.test.ts`

**Interfaces:** `buildReportRows(input)` returns full LayOut rows (34 cols via `toLayoutRows`) enriched with `sender`/`platform`/`client` fields and risk `Resultado`/`Motivo` columns. `exports.ts` `report.xlsx` reads `manifests.import_data` + selected client and merges.

- [ ] **Step 1: Failing test** — `reportBuilder.test.ts`: given shipments + client {name, platform} + import_data {patente, tasaImportacion, claveAduanaEntrada}, the output row contains all LAYOUT_HEADERS, the patente/tasa/aduana injected into the operación block, sender & platform populated, and `Resultado`/`Motivo` appended.

- [ ] **Step 2: Run fail** — `npm test -- reportBuilder`.

- [ ] **Step 3: Implement** — rewrite `buildReportRows` to call `toLayoutRows(shipments)` then merge per-row: overlay `import_data` (patente → 'Patente AA', tasaImportacion → 'Tasa global o cuota aplicada', claveAduanaEntrada/Despacho → their columns, cveT1/pedimento → 'No. de registro T1'/'No. pedimento'), overlay `client.platform` into Plataforma cols and `client` into Remitente cols when shipment-level blank, append `Resultado` + `Motivo`. Update `ReportInput` type accordingly. Update `exports.ts` `report.xlsx` to load `import_data` and the linked client and pass them in.

- [ ] **Step 4: Wire `ReporteGeneralView.tsx`** — on "Generar Reporte", first `apiPost('/api/catalogs/clients', {...remitente, platform:{...}})` (or select existing), associate to the record, then download. Remove the two "Vista previa — se conectará al backend" banners.

- [ ] **Step 5: Run pass** — `npm test -- reportBuilder` and client tests.

- [ ] **Step 6: Commit** — `git commit -am "feat(reporte): full LayOut merge with catalog + import data (RF-11/RF-12)"`

---

## Task 9: Persist the three expediente artifacts as real files (RF-06/RF-13)

**Files:** Create `server/migrations/1700000900000_artifact_files.ts`, `server/src/services/artifacts.ts`; Modify `server/src/routes/risk.ts`, `server/src/routes/exports.ts`, `server/src/storage/files.ts` (extend `FileKind`); Test `server/test/artifacts.test.ts`

**Interfaces:** `manifests.risk_file_id`, `manifests.report_file_id` (uuid → files). `FileKind` gains `'risk_analysis'`. On risk run → generate+store risk XLSX, set `risk_file_id`. On report generate → store report XLSX, set `report_file_id`. `Consulta`/exports serve the stored file when present.

- [ ] **Step 1: Migration** — add `risk_file_id`, `report_file_id` columns; widen `files.kind` check to include `'risk_analysis'` (drop+recreate constraint).

- [ ] **Step 2: Failing test** — after `POST /:id/risk`, `manifests.risk_file_id` is non-null and a `files` row with kind `risk_analysis` exists; `GET /:id/risk.xlsx` streams the stored bytes.

- [ ] **Step 3: Run fail** — `npm --prefix server test -- artifacts`.

- [ ] **Step 4: Implement** — `artifacts.ts` exposes `buildRiskWorkbook(rows)` and `buildReportWorkbook(...)` returning Buffers (reuse the `workbook()` helper logic, extracted/shared). In `risk.ts`, after scoring, generate buffer and `saveFile({ kind: 'risk_analysis', ... })`, `UPDATE manifests SET risk_file_id=$1`. In `exports.ts`, `report.xlsx`/`risk.xlsx` first check for a stored `*_file_id` and stream it via the file store; regenerate only if absent. Include `Motivo` column in the risk workbook (audit noted it was missing).

- [ ] **Step 5: Run pass** — `npm --prefix server test -- artifacts`.

- [ ] **Step 6: Commit** — `git commit -am "feat(expediente): persist risk+report XLSX as immutable artifacts (RF-06/RF-13)"`

---

## Task 10: Enforce authority read-only + capturista shared visibility

**Files:** Modify `server/src/auth/access.ts`, `server/src/routes/{manifests,pedimentoUpload,risk}.ts`, `server/src/routes/records.ts`, `server/src/routes/exports.ts`; Test `server/test/rbac.test.ts`

**Interfaces:** `canSeeAll(role)` returns true for `capturista` too. All mutating routes carry `requireRole('admin','capturista')`.

- [ ] **Step 1: Failing test** — `rbac.test.ts`: (a) `autoridad` token POST to `/api/manifests`, `/api/manifests/:id/pedimento-pdf`, `/api/manifests/:id/risk` each → 403; (b) capturista B can `GET /api/records/:id` for a record created by capturista A → 200.

- [ ] **Step 2: Run fail** — `npm --prefix server test -- rbac`.

- [ ] **Step 3: Implement** —
  - `access.ts`: `return role === 'admin' || role === 'autoridad' || role === 'capturista';` (i.e. only differentiate write access, not read). Add a comment explaining PRD shared-visibility rule.
  - `manifests.ts`: `manifestsRouter.post('/', requireAuth, requireRole('admin','capturista'), ...)`.
  - `pedimentoUpload.ts`: add `requireRole('admin','capturista')` to the POST.
  - `risk.ts`: add `requireRole('admin','capturista')` to the POST.
  - In `records.ts`/`exports.ts` the ownership scoping now collapses (canSeeAll true for all) — keep the code (still correct) but ensure capturista reaches peer records.

- [ ] **Step 4: Run pass** — `npm --prefix server test -- rbac`.

- [ ] **Step 5: Commit** — `git commit -am "fix(rbac): autoridad read-only + capturista shared visibility (RF-22/roles)"`

---

## Task 11: MFA (TOTP) — enrollment + login second factor (RNF-04)

**Files:** Create `server/migrations/1700001100000_mfa.ts`, `server/src/auth/mfa.ts`; Modify `server/src/routes/auth.ts`, `server/package.json` (add `otplib`), `src/components/LoginView.tsx`; Test `server/test/mfa.test.ts`

**Interfaces:** `users.mfa_secret text`, `users.mfa_enabled boolean default false`. `POST /api/auth/mfa/setup` (authed) → returns otpauth URL + secret; `POST /api/auth/mfa/enable` (authed, `{ code }`) verifies & sets enabled. `POST /api/auth/login` requires `{ username, password, code }` when `mfa_enabled`; wrong/absent code → 401.

- [ ] **Step 1: Add dependency** — `npm --prefix server install otplib`.

- [ ] **Step 2: Migration** — add `mfa_secret`, `mfa_enabled` columns to `users`.

- [ ] **Step 3: Failing test** — `mfa.test.ts`: enroll a user, generate a valid TOTP with `authenticator.generate(secret)`, enable; login without code → 401; login with valid code → 200 + token.

- [ ] **Step 4: Run fail** — `npm --prefix server test -- mfa`.

- [ ] **Step 5: Implement `server/src/auth/mfa.ts`** wrapping `otplib` `authenticator` (`generateSecret`, `keyuri`, `verify`). Update `auth.ts` login: after password check, if `user.mfa_enabled` then `if (!code || !verifyTotp(user.mfa_secret, code)) return 401`. Add setup/enable routes (authed), audited with `ip: req.ip`.

- [ ] **Step 6: Wire `LoginView.tsx`** — add an optional "Código MFA" field; include `code` in the login POST; on a `mfa_required` error show the field.

- [ ] **Step 7: Run pass** — `npm --prefix server test -- mfa`.

- [ ] **Step 8: Commit** — `git commit -am "feat(auth): TOTP MFA enrollment + login second factor (RNF-04)"`

---

## Task 12: Field-level AES-256-GCM encryption for PII at rest (RNF-03/08) + secret hardening (RNF-05)

**Files:** Create `server/src/crypto/fieldCrypto.ts`; Modify `server/src/routes/manifests.ts` (encrypt consignee rfc/curp/passport on insert), `server/src/routes/{records,exports,risk}.ts` (decrypt on read), `server/src/index.ts` (boot guard), `.env.example`; Test `server/test/fieldCrypto.test.ts`

**Interfaces:** `encryptField(plain: string): string` → `v1:<iv_b64>:<tag_b64>:<ct_b64>`; `decryptField(enc: string): string` (passthrough if not `v1:`-prefixed, for backward compat). Key from `FIELD_ENCRYPTION_KEY` (32-byte base64).

- [ ] **Step 1: Failing test** — `fieldCrypto.test.ts`: `decryptField(encryptField('GODE801231ABC')) === 'GODE801231ABC'`; ciphertext ≠ plaintext; two encryptions of same value differ (random IV).

- [ ] **Step 2: Run fail** — `npm --prefix server test -- fieldCrypto`.

- [ ] **Step 3: Implement `fieldCrypto.ts`** with `node:crypto` `createCipheriv('aes-256-gcm', key, iv)` (12-byte IV), store iv/tag/ct base64. Throw on boot if key missing/invalid length.

- [ ] **Step 4: Apply at boundaries** — in `manifests.ts`, before persisting each shipment, encrypt `consignee.rfc`, `consignee.curp`, `consignee.passport` (and `consignee.foreignTaxId`, `socialSecurity` if present). In read paths that build layout/report/risk output (`exports.ts`, `risk.ts`), decrypt those fields after loading `data`. Add a small `mapShipmentDecrypt(s)` helper to centralize.

- [ ] **Step 5: Boot guard** — in `server/src/index.ts`, in production also require `FIELD_ENCRYPTION_KEY`. Add both `JWT_SECRET` and `FIELD_ENCRYPTION_KEY` placeholders to `.env.example` with generation instructions; ensure no default value is committed.

- [ ] **Step 6: Run pass** — `npm --prefix server test` (full server suite, confirm no regressions).

- [ ] **Step 7: Commit** — `git commit -am "feat(security): AES-256-GCM PII-at-rest + production secret guards (RNF-03/05/08)"`

---

## Task 13: Consolidated authority report (RF-23)

**Files:** Create `server/src/routes/consolidated.ts`; Modify `server/src/app.ts`; Test `server/test/consolidated.test.ts`

**Interfaces:** `GET /api/consolidated.xlsx?period=YYYY-MM` (and `?date=YYYY-MM-DD` for daily), `requireRole('autoridad','admin')` — produces an XLS from the §8.4 monthly base (manifests + shipments + `Valida` flag) for the period. Audited.

- [ ] **Step 1: Failing test** — seed two manifests with scored shipments in a period; `GET /api/consolidated.xlsx?period=...` as admin → 200 + xlsx buffer whose row count equals the period's shipment count; as capturista → 403.

- [ ] **Step 2: Run fail** — `npm --prefix server test -- consolidated`.

- [ ] **Step 3: Implement** — query shipments joined to manifests within the period, project to a consolidated row set (MAWB, cliente, guía, consignatario, valor, color, `Valida` = color==='verde'), build a workbook, `send()`. `recordAudit({ action: 'EXPORT_CONSOLIDATED', ip: req.ip })`. Register route.

- [ ] **Step 4: Run pass** — `npm --prefix server test -- consolidated`.

- [ ] **Step 5: Commit** — `git commit -am "feat(reports): consolidated daily/monthly authority XLS (RF-23)"`

---

## Task 14: Catalog-driven risk lists + branding config (RF-20/RF-24)

**Files:** Modify `shared/risk/lists.ts` (accept injected lists), `server/src/routes/risk.ts` (load lists from `config`), `server/src/routes/catalogs.ts` (config endpoints), `src/components/ConfigurationView.tsx`, `src/components/AcercaDeView.tsx`, `src/components/DashboardView.tsx` / shared header (branding); Test `shared/risk/lists.test.ts`, `server/test/catalogs.test.ts`

**Interfaces:** `matchesBrand(desc, brands?)`, `matchesProhibited(desc, keywords?)` accept optional override lists (default to the built-in constants). `GET/PUT /api/catalogs/config/:key` for keys `prohibited`, `piracy_brands`, `branding` (`{ logoUrl, rfc, companyName }`), `validation_params`.

- [ ] **Step 1: Failing tests** — `lists.test.ts`: `matchesProhibited('Faro delantero', ['faro'])` matches even though 'faro' isn't a default keyword. `catalogs.test.ts`: PUT `/config/branding` as admin persists; as capturista → 403.

- [ ] **Step 2: Run fail** — `npm test -- lists`; `npm --prefix server test -- catalogs`.

- [ ] **Step 3: Implement** — parameterize `matchesBrand`/`matchesProhibited`/`runSignals`/`scoreManifest` to thread optional lists (default to constants). `risk.ts` loads `prohibited`/`piracy_brands` from `config` (fallback to constants when unset) and passes them in. Add `config` GET/PUT to `catalogs.ts` (`requireRole('admin')` for PUT). `ConfigurationView.tsx`: forms to edit prohibited/brands/branding via these endpoints. `AcercaDeView.tsx`: render `marco legal` text + Capital Centennials company data + RFC from `config/branding`. Branding (logo+RFC) rendered in the app header and passed into generated XLS (a header row in `workbook()`), satisfying RF-20.

- [ ] **Step 4: Run pass** — both suites.

- [ ] **Step 5: Commit** — `git commit -am "feat(config): DB-driven catalogs, branding, and Acerca de marco legal (RF-20/RF-24/RF-19)"`

---

## Task 15: Upload bounds + PDF MIME validation (RF-08) & CORS tightening

**Files:** Modify `server/src/routes/pedimentoUpload.ts`, `server/src/storage/files.ts`, `server/src/app.ts`; Test `server/test/pedimentoUpload.test.ts`

**Interfaces:** reject non-`application/pdf` and files outside a configurable floor/ceiling; CORS defaults closed in production.

- [ ] **Step 1: Failing test** — uploading a non-PDF buffer → 400; uploading a 0-byte file → 400.

- [ ] **Step 2: Run fail** — `npm --prefix server test -- pedimentoUpload`.

- [ ] **Step 3: Implement** — in `pedimentoUpload.ts` check `req.file.mimetype === 'application/pdf'` and `req.file.size > 0`; keep the 100 MB multer ceiling (covers the 80 MB max), add a configurable min via env `PEDIMENTO_MIN_BYTES` (default 0 to avoid blocking test fixtures). In `app.ts`, when `NODE_ENV==='production'` and `CORS_ORIGIN` unset, default to an empty allowlist (deny) instead of `true`, and log a warning.

- [ ] **Step 4: Run pass** — `npm --prefix server test -- pedimentoUpload`.

- [ ] **Step 5: Commit** — `git commit -am "fix(upload): PDF MIME/size validation + closed CORS default in prod (RF-08)"`

---

# PHASE 2 — Quality, credibility & decisions

## Task 16: Declarative, versioned ruleset + bucket mapping (D2) + severity (RF-04)

**Files:** Create `shared/risk/ruleset.ts`; Modify `shared/risk/classify.ts`, `server/src/routes/risk.ts`, `server/migrations/1700001200000_ruleset_version.ts` (new); Test `shared/risk/classify.test.ts`

**Interfaces:** `RULESET = { version: '2026-06', thresholds: { cantidad: 10, montoMin: 1, montoMax: 2500, consignatario: 3, ... }, classify: {...} }`. `scoreManifest` reads thresholds from `RULESET`. Each risk run stores `ruleset_version` on the manifest. Summary returns all three PRD buckets including **`noIdentificados`**. Severity: a `prohibidos` or `pirateria` hit forces `rojo`.

- [ ] **Step 1: Failing tests** — (a) a shipment with only a prohibited-keyword hit classifies `rojo` (severity override) even though score < 2; (b) `scoreManifest` summary exposes `{ analizados, aprobados, noIdentificados, validarEnPrevio }`; (c) consignatario threshold now fires at **≥3** (PRD D4) not ≥2.

> **Decision note (D2/D4):** thresholds and the semáforo→bucket mapping are pending client confirmation. This task implements the **PRD-body** interpretation: bucket `aprobados = verde`, `noIdentificados = amarillo`, `validarEnPrevio = rojo`; consignatario umbral `≥3`. If the client confirms the spreadsheet interpretation instead (umbral `>1`, count-only coloring), change only `RULESET` — no other code.

- [ ] **Step 2: Run fail** — `npm test -- classify`.

- [ ] **Step 3: Implement** — `ruleset.ts` exports the config object. `signals.ts`/`classify.ts` consume it (consignatario `>= RULESET.thresholds.consignatario`). Add a severity pass in `scoreManifest`: if incidences include prohibidos/pirateria → `color='rojo'`. `risk.ts` summary maps the three buckets and persists `ruleset_version` (new column via migration). Update existing tests that asserted the old buckets.

- [ ] **Step 4: Run pass** — `npm test -- classify` and `npm --prefix server test -- risk`.

- [ ] **Step 5: Commit** — `git commit -am "feat(risk): versioned ruleset, 3-bucket summary, severity override (RF-04/D2/D4)"`

---

## Task 17: Fuzzy / normalized matching for catalogs & entity counting

**Files:** Create `shared/risk/match.ts`; Modify `shared/risk/lists.ts`, `shared/risk/classify.ts`; Test `shared/risk/match.test.ts`

**Interfaces:** `fuzzyIncludes(haystack, needle, threshold=0.85): boolean` (normalized Levenshtein/Jaro-Winkler); consignee/address counting normalizes (accent/case/whitespace + collapse punctuation) before tallying so V4/V5/V8 don't undercount rings.

- [ ] **Step 1: Failing tests** — `fuzzyIncludes('addidas shoes','adidas')` true; `'Juan  Pérez'` and `'juan perez'` count as the same consignee.

- [ ] **Step 2: Run fail** — `npm test -- match`.

- [ ] **Step 3: Implement** — `match.ts` with a small dependency-free Levenshtein ratio. Use it in `matchesBrand` (and optionally prohibited) and tighten `norm()` used by `scoreManifest` counters (strip punctuation, collapse spaces).

- [ ] **Step 4: Run pass** — `npm test -- match classify`.

- [ ] **Step 5: Commit** — `git commit -am "feat(risk): fuzzy brand match + normalized entity counting"`

---

## Task 18: Denied-party / sanctions screening (9th signal)

**Files:** Modify `shared/risk/signals.ts`, `shared/risk/classify.ts`, `shared/risk/lists.ts`, `server/src/routes/risk.ts` (load denied-party list from `config`); Test `shared/risk/signals.test.ts`

**Interfaces:** new `SignalResult.id` `'denied'`; flags when consignee/sender name fuzzy-matches a denied-party list (`config` key `denied_parties`, default empty). A denied hit forces `rojo`.

- [ ] **Step 1: Failing test** — a shipment whose consignee matches a denied-party entry flags `denied` and classifies `rojo`.

- [ ] **Step 2: Run fail** — `npm test -- signals`.

- [ ] **Step 3: Implement** — add the signal using `fuzzyIncludes` against the injected denied list; extend the severity override (Task 16) to include `denied`. Thread the list from `risk.ts` `config`.

- [ ] **Step 4: Run pass** — `npm test -- signals classify`.

- [ ] **Step 5: Commit** — `git commit -am "feat(risk): denied-party/sanctions screening signal"`

---

## Task 19: Dashboard charts + expediente status view (RF-16/17/18)

**Files:** Modify `src/components/DashboardView.tsx`, `server/src/routes/dashboardData.ts`; Test `src/components/DashboardView.test.tsx`

**Interfaces:** dashboard renders SVG/CSS bar+donut for per-user productivity and risk distribution (volumen, %aprobados/amarillos/rojos, tiempos), plus a status table (records complete vs awaiting pedimento/report) from a new `GET /api/dashboard/status`.

- [ ] **Step 1: Failing test** — DashboardView renders chart elements (role `img`/`figure` with accessible labels) and a status row per record.

- [ ] **Step 2: Run fail** — `npm test -- DashboardView`.

- [ ] **Step 3: Implement** — add `/api/dashboard/status` (counts by artifact-presence: has `risk_file_id`, has pedimento `file_id`, has `report_file_id`). Render lightweight inline-SVG charts (no new chart dependency) + a status table. Include a "tiempos" metric (avg minutes between manifest upload and report) computed from `created_at` deltas.

- [ ] **Step 4: Run pass** — `npm test -- DashboardView`.

- [ ] **Step 5: Commit** — `git commit -am "feat(dashboard): charts + expediente status view (RF-16/17/18)"`

---

# PHASE 3 — Infrastructure & process (non-code, for the AGACE package)

These items from the audit are environment/process-level, not application code. Track them as deliverables for the evaluation dossier; they do not have TDD tasks but **must be closed before evaluation**.

- [ ] **RNF-02/03 TLS in transit** — terminate TLS 1.2+ at the reverse proxy (nginx/ALB); HSTS; redirect HTTP→HTTPS. Document in deployment diagram.
- [ ] **RNF-11/12 Cloud DR + SLA** — managed Postgres with read replica + automated backups; documented RTO/RPO (resolves **D8**); restore drill evidence.
- [ ] **RNF-13 Large-file object storage** — move pedimento PDFs from local disk + in-memory multer to streamed/resumable object storage (S3/GCS) with multipart upload; replace `multer.memoryStorage()` to avoid buffering 80 MB in RAM.
- [ ] **RNF-14 Async batch** — move risk scoring of thousands of partidas to a queue/worker for very large manifests (current synchronous loop is fine for moderate sizes; document the threshold).
- [ ] **RNF-15 Observability** — structured logging + error/metrics pipeline (replace `console.error`).
- [ ] **RNF-06/07 ISO 27001 + pen test** — with the cybersecurity partner; remediate findings; attach evidence.
- [ ] **§13 documentary package** — architecture/deployment diagrams, data dictionary + E-R, technical & user manuals, test URL + credentials, pen-test evidence, ISO policy + DRP, evidence of `autoridad` access.
- [ ] **LFPDPPP** — aviso de privacidad, ARCO workflow, breach plan, retention policy (resolves **D8**).

# Open client/customs-broker decisions (block final sign-off, not the build)
- **D1** OCR auto-read of pedimento header (Should; not built — RF-10 deferred).
- **D2/D4** confirm semáforo→bucket mapping and consignatario/dirección thresholds (Task 16 implements the PRD-body interpretation; change `RULESET` only).
- **D3** origin of CNNE RFC (the manifest carries only `ID`; layout wants RFC+CURP).
- **D5** include tasa-consistency check with vigencias table (33.5% non-treaty / 19/17/0% T-MEC) — warn-only.
- **D6** SAT product-key validation.
- **D7** consolidated-report cadence/layout (Task 13 supports daily+monthly).
- **The AGACE checklist in writing** — the "22 requisitos"/ISO/pen-test/"pruebas conjuntas"/"espejo SHCP" are not published rules (Team B1); obtain the real criteria from ANAM/AGACE.

---

## Self-Review

- **Spec coverage:** every audit finding maps to a task — parser vocab (T1), normalization (T2), hash chain (T3), import-data wiring (T4), tax removal (T5), layout fixed values (T6), catalog (T7), reporte general (T8), artifact persistence (T9), RBAC/visibility (T10), MFA (T11), PII encryption + secrets (T12), consolidated report (T13), config-driven catalogs/branding/Acerca de (T14), upload bounds/CORS (T15), versioned ruleset/buckets/severity (T16), fuzzy matching (T17), denied-party (T18), dashboard charts/status (T19); infra items in Phase 3.
- **No placeholders:** logic-bearing steps include real code; wiring steps name exact files, routes, and field maps.
- **Type consistency:** `recordAudit` `ip` field, `FileKind` `'risk_analysis'`, `manifests.{import_data,risk_file_id,report_file_id,ruleset_version}`, `config` table, and `RULESET` are referenced consistently across tasks.
