# Phase A — Manifest Ingestion Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace single-shot manifest parse-and-persist with a bronze→silver→gold staging pipeline: server-side parsing, per-row validation that quarantines bad rows instead of silently corrupting them, and an idempotent promotion gate.

**Architecture:** The client uploads the raw .xlsx (multipart). The server stores it (bronze, hashed), runs `XLSX.read`, and calls a shared validator that produces per-row `valid|warning|error` staging rows (silver). A separate `promote` endpoint upserts valid/warning rows into `shipments` (gold) by a per-line idempotency key, then risk scoring runs. No required-field value is ever coerced or fabricated.

**Tech Stack:** TypeScript, Express, node-pg-migrate (PostgreSQL), multer, xlsx (`^0.18.5`, already a server dep), Vitest + supertest, React (frontend).

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-06-22-phase-a-manifest-ingestion-integrity-design.md` (v2). Every task implicitly serves it.
- **País semantics:** Do NOT rename `Shipment.originCountry` (read by `taxCalculator.ts`/`t1Compliance.ts` for USMCA — renaming changes tax rates). ADD `procedenceCountry`. Missing `originCountry` = **warning** at ingestion (hard-gated in Phase B). No `'US'` fabrication anywhere.
- **Severities:** hard error → row quarantined, not promotable. warning → row persists, promotable, flagged. Duplicate mapped header → whole-file rejection.
- **Locale-ambiguous numbers** (e.g. `"1,000"`) in a required numeric field are a **hard error** in Phase A (only auto-disambiguation defers to Phase C).
- **Lock authority:** declaration locking stays with `computeLock` (`manifestLock.ts`). New `manifests.ingestion_status` is orthogonal: `draft|staged|promoted`.
- **Test commands:** shared/frontend → `npm test -- <path>` (vitest run). server → `npm --prefix server test -- <path>`. Migrations → `npm --prefix server run migrate` (apply to the test DB before running server tests).
- **Migration slot:** next is `1700001900000_*` (builder style, see `server/migrations/1700001600000_super_admin_role.ts`).
- **Idempotency key:** composite string `${mawb}|${guideId}|${lineSeq}|${hsCode}` where `lineSeq` = 1-based ordinal of the row within its `guideId` group (stable across re-uploads of the same-ordered file). Plain string (no hashing) so the validator stays node-free/browser-safe.

---

## File Structure

**Create:**
- `server/migrations/1700001900000_manifest_staging.ts` — schema (files.content_hash, manifests cols, manifest_staging_rows, shipments.idempotency_key + unique).
- `shared/parsing/catalogs.ts` — static ISO-3166 / ISO-4217 / weight-unit lookups.
- `shared/parsing/catalogs.test.ts`
- `shared/types/staging.ts` — `RowSeverity`, `RowIssue`, `RowStatus`, `StagingRow`, `IngestResult`, issue-code constants.
- `shared/parsing/validateManifest.ts` — the validator (rows → IngestResult).
- `shared/parsing/validateManifest.test.ts`
- `shared/parsing/manifestGolden.test.ts` — real `MANIFEST_TEST.xlsx` end-to-end.
- `server/src/services/manifestIngest.ts` — `XLSX.read` (server-only) → validator.
- `server/test/services/manifestIngest.test.ts`

**Modify:**
- `shared/parsing/normalize.ts` — add `parseNumberStrict`, `convertWeight`, `parseManifestDate`.
- `shared/parsing/normalize.test.ts` — cover the new functions.
- `shared/parsing/headerSynonyms.ts` — remap `'pais de procedencia'` → `core.procedenceCountry`.
- `shared/parsing/manifestParser.ts` — extract `mapRowToShipment`; populate `procedenceCountry`.
- `shared/parsing/manifestParser.test.ts` — update procedencia assertion.
- `shared/types/shipment.ts` — add `procedenceCountry?: string`.
- `server/src/storage/files.ts` — SHA-256 `content_hash` in `saveFile` + `FileMeta`.
- `server/src/routes/manifests.ts` — multipart `POST /`, `GET /:id/staging`, `POST /:id/promote`.
- `server/test/routes/manifests.test.ts` — rewrite for the new contract.
- `server/test/helpers/db.ts` — add `manifest_staging_rows` to `truncateAll`.
- `src/components/RegistroView.tsx` — multipart upload + review step + promote.
- `src/context/T1Context.tsx:171` — remove `|| 'US'`.

**Delete:**
- `src/utils/fileParser.ts` (orphan, zero importers, no test).

---

## Task 1: Staging schema migration

**Files:**
- Create: `server/migrations/1700001900000_manifest_staging.ts`
- Modify: `server/test/helpers/db.ts:5`
- Test: `server/test/migrations/staging.test.ts`

**Interfaces:**
- Produces: tables/columns — `files.content_hash text`; `manifests.ingestion_status text ('draft'|'staged'|'promoted')`, `manifests.source_file_id uuid`, `manifests.source_header jsonb`, `manifests.file_content_hash text`; table `manifest_staging_rows`; `shipments.idempotency_key text` + unique `(manifest_id, idempotency_key)`.

- [ ] **Step 1: Write the migration**

```ts
// server/migrations/1700001900000_manifest_staging.ts
import type { MigrationBuilder } from 'node-pg-migrate';

// Phase A: bronze/silver staging for manifest ingestion.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumns('files', { content_hash: { type: 'text' } });

  pgm.addColumns('manifests', {
    ingestion_status: { type: 'text', notNull: true, default: 'draft' },
    source_file_id: { type: 'uuid', references: 'files', onDelete: 'SET NULL' },
    source_header: { type: 'jsonb' },
    file_content_hash: { type: 'text' },
  });
  pgm.addConstraint('manifests', 'manifests_ingestion_status_check', {
    check: "ingestion_status IN ('draft','staged','promoted')",
  });

  pgm.createTable('manifest_staging_rows', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    manifest_id: { type: 'uuid', notNull: true, references: 'manifests', onDelete: 'CASCADE' },
    row_index: { type: 'integer', notNull: true },
    idempotency_key: { type: 'text', notNull: true },
    data: { type: 'jsonb', notNull: true },
    status: { type: 'text', notNull: true },
    errors: { type: 'jsonb', notNull: true, default: '[]' },
    warnings: { type: 'jsonb', notNull: true, default: '[]' },
    promoted_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('manifest_staging_rows', 'manifest_staging_rows_status_check', {
    check: "status IN ('valid','warning','error')",
  });
  pgm.addConstraint('manifest_staging_rows', 'manifest_staging_rows_idem_uq', {
    unique: ['manifest_id', 'idempotency_key'],
  });
  pgm.createIndex('manifest_staging_rows', 'manifest_id');

  pgm.addColumns('shipments', { idempotency_key: { type: 'text' } });
  pgm.addConstraint('shipments', 'shipments_manifest_idem_uq', {
    unique: ['manifest_id', 'idempotency_key'],
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint('shipments', 'shipments_manifest_idem_uq');
  pgm.dropColumns('shipments', ['idempotency_key']);
  pgm.dropTable('manifest_staging_rows');
  pgm.dropConstraint('manifests', 'manifests_ingestion_status_check');
  pgm.dropColumns('manifests', ['ingestion_status', 'source_file_id', 'source_header', 'file_content_hash']);
  pgm.dropColumns('files', ['content_hash']);
}
```

- [ ] **Step 2: Add the new table to the test truncate helper**

In `server/test/helpers/db.ts:5`, add `manifest_staging_rows` to the TRUNCATE list:

```ts
    `TRUNCATE users, audit_log, files, manifests, shipments, monthly_history, clients, config, pedimento_scans, validated_rfcs, manifest_staging_rows RESTART IDENTITY CASCADE`,
```

- [ ] **Step 3: Apply the migration to the test DB**

Run: `npm --prefix server run migrate`
Expected: output ending in `Migrations complete!` listing `1700001900000_manifest_staging`.

- [ ] **Step 4: Write a schema smoke test**

```ts
// server/test/migrations/staging.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

beforeEach(truncateAll);

describe('manifest staging schema', () => {
  it('persists a staging row and enforces the per-manifest idempotency uniqueness', async () => {
    const m = await query(`INSERT INTO manifests (mawb_reference) VALUES ('M-1') RETURNING id`);
    const manifestId = m.rows[0].id;
    await query(
      `INSERT INTO manifest_staging_rows (manifest_id, row_index, idempotency_key, data, status)
       VALUES ($1, 0, 'k1', '{}'::jsonb, 'valid')`, [manifestId]);
    await expect(
      query(`INSERT INTO manifest_staging_rows (manifest_id, row_index, idempotency_key, data, status)
             VALUES ($1, 1, 'k1', '{}'::jsonb, 'valid')`, [manifestId]),
    ).rejects.toThrow();
    const { rows } = await query(`SELECT ingestion_status FROM manifests WHERE id=$1`, [manifestId]);
    expect(rows[0].ingestion_status).toBe('draft');
  });
});
```

- [ ] **Step 5: Run the test**

Run: `npm --prefix server test -- test/migrations/staging.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/migrations/1700001900000_manifest_staging.ts server/test/helpers/db.ts server/test/migrations/staging.test.ts
git commit -m "feat(db): manifest staging schema (bronze/silver + idempotency key)"
```

---

## Task 2: Static catalogs (country / currency / unit)

**Files:**
- Create: `shared/parsing/catalogs.ts`, `shared/parsing/catalogs.test.ts`

**Interfaces:**
- Produces:
  - `resolveCountry(codeOrName: string): string | null` — returns ISO-3166 alpha-2 or null if unknown.
  - `resolveCurrency(codeOrName: string): string | null` — returns ISO-4217 code or null.
  - `weightFactorToKg(unit: string): number | null` — multiplier to kg, or null if unknown unit.

- [ ] **Step 1: Write the failing test**

```ts
// shared/parsing/catalogs.test.ts
import { describe, expect, it } from 'vitest';
import { resolveCountry, resolveCurrency, weightFactorToKg } from './catalogs';

describe('resolveCountry', () => {
  it('passes through a known ISO code', () => expect(resolveCountry('CN')).toBe('CN'));
  it('maps a Spanish name', () => expect(resolveCountry('Porcelana')).toBe('CN'));
  it('maps México', () => expect(resolveCountry('México')).toBe('MX'));
  it('is accent/case-insensitive', () => expect(resolveCountry('mexico')).toBe('MX'));
  it('returns null for unknown', () => expect(resolveCountry('XX')).toBeNull());
});

describe('resolveCurrency', () => {
  it('passes through a known code', () => expect(resolveCurrency('USD')).toBe('USD'));
  it('maps the Spanish name', () => expect(resolveCurrency('Dólar estadounidense')).toBe('USD'));
  it('returns null for unknown', () => expect(resolveCurrency('Quatloos')).toBeNull());
});

describe('weightFactorToKg', () => {
  it('grams', () => expect(weightFactorToKg('gramo')).toBe(0.001));
  it('kg', () => expect(weightFactorToKg('kg')).toBe(1));
  it('lb', () => expect(weightFactorToKg('lb')).toBeCloseTo(0.453592));
  it('oz', () => expect(weightFactorToKg('oz')).toBeCloseTo(0.0283495));
  it('returns null for unknown', () => expect(weightFactorToKg('cubits')).toBeNull());
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- shared/parsing/catalogs.test.ts`
Expected: FAIL ("Cannot find module './catalogs'").

- [ ] **Step 3: Implement catalogs**

```ts
// shared/parsing/catalogs.ts
// Static ISO-3166 / ISO-4217 / weight-unit catalogs for ingestion normalization.
// Code-with-name-fallback (Phase A): prefer an ISO code, else map a Spanish/English name.

const norm = (s: string): string =>
  (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

// alpha-2 → accepted names (Spanish + English). Extend as real feeds require.
const COUNTRY_NAMES: Record<string, string[]> = {
  CN: ['china', 'porcelana'],
  MX: ['mexico', 'estados unidos mexicanos'],
  US: ['estados unidos', 'estados unidos de america', 'usa', 'united states'],
  CA: ['canada'],
  VN: ['vietnam'],
  KR: ['corea del sur', 'corea', 'south korea'],
  JP: ['japon', 'japan'],
  DE: ['alemania', 'germany'],
  ES: ['espana', 'spain'],
  GB: ['reino unido', 'united kingdom'],
  HK: ['hong kong'],
};
const COUNTRY_CODES = new Set(Object.keys(COUNTRY_NAMES));
const COUNTRY_BY_NAME: Record<string, string> = {};
for (const [code, names] of Object.entries(COUNTRY_NAMES)) for (const n of names) COUNTRY_BY_NAME[norm(n)] = code;

export function resolveCountry(codeOrName: string): string | null {
  const raw = (codeOrName ?? '').trim();
  if (!raw) return null;
  const upper = raw.toUpperCase();
  if (upper.length === 2 && COUNTRY_CODES.has(upper)) return upper;
  return COUNTRY_BY_NAME[norm(raw)] ?? null;
}

const CURRENCY_NAMES: Record<string, string[]> = {
  USD: ['dolar estadounidense', 'dolar', 'us dollar', 'dolares'],
  MXN: ['peso mexicano', 'pesos'],
  EUR: ['euro'],
  CAD: ['dolar canadiense'],
};
const CURRENCY_CODES = new Set(Object.keys(CURRENCY_NAMES));
const CURRENCY_BY_NAME: Record<string, string> = {};
for (const [code, names] of Object.entries(CURRENCY_NAMES)) for (const n of names) CURRENCY_BY_NAME[norm(n)] = code;

export function resolveCurrency(codeOrName: string): string | null {
  const raw = (codeOrName ?? '').trim();
  if (!raw) return null;
  const upper = raw.toUpperCase();
  if (upper.length === 3 && CURRENCY_CODES.has(upper)) return upper;
  return CURRENCY_BY_NAME[norm(raw)] ?? null;
}

// unit token → kg multiplier.
const WEIGHT_FACTORS: Record<string, number> = {
  mg: 0.000001,
  g: 0.001, gr: 0.001, gram: 0.001, grams: 0.001, gramo: 0.001, gramos: 0.001,
  kg: 1, kgs: 1, kilogramo: 1, kilogramos: 1, kilo: 1, kilos: 1,
  t: 1000, ton: 1000, tonelada: 1000, toneladas: 1000,
  lb: 0.453592, lbs: 0.453592, libra: 0.453592, libras: 0.453592, pound: 0.453592,
  oz: 0.0283495, onza: 0.0283495, onzas: 0.0283495, ounce: 0.0283495,
};

export function weightFactorToKg(unit: string): number | null {
  const u = norm(unit);
  if (!u) return null;
  return WEIGHT_FACTORS[u] ?? null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- shared/parsing/catalogs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/parsing/catalogs.ts shared/parsing/catalogs.test.ts
git commit -m "feat(parsing): static country/currency/unit catalogs"
```

---

## Task 3: Strict numeric, weight, and date helpers

**Files:**
- Modify: `shared/parsing/normalize.ts`
- Test: `shared/parsing/normalize.test.ts`

**Interfaces:**
- Consumes: `weightFactorToKg` from `./catalogs` (Task 2).
- Produces:
  - `type NumberResult = { ok: true; value: number } | { ok: false; code: 'not_a_number' | 'ambiguous_locale' }`
  - `parseNumberStrict(raw: string): NumberResult`
  - `convertWeight(value: number, unit: string): { ok: true; kg: number } | { ok: false }`
  - `parseManifestDate(raw: unknown): { ok: true; iso: string } | { ok: false }`
- Existing `parseNumber` / `toKg` remain unchanged (still used by `mapRowToShipment`).

- [ ] **Step 1: Write the failing test (append to normalize.test.ts)**

```ts
// shared/parsing/normalize.test.ts — append
import { convertWeight, parseManifestDate, parseNumberStrict } from './normalize';

describe('parseNumberStrict', () => {
  it('parses a plain number', () => expect(parseNumberStrict('120.5')).toEqual({ ok: true, value: 120.5 }));
  it('parses a comma decimal', () => expect(parseNumberStrict('0,79')).toEqual({ ok: true, value: 0.79 }));
  it('rejects non-numeric', () => expect(parseNumberStrict('N/A')).toEqual({ ok: false, code: 'not_a_number' }));
  it('rejects empty', () => expect(parseNumberStrict('')).toEqual({ ok: false, code: 'not_a_number' }));
  it('flags ambiguous thousands/decimal "1,000"', () =>
    expect(parseNumberStrict('1,000')).toEqual({ ok: false, code: 'ambiguous_locale' }));
  it('accepts unambiguous grouped "1,234.50"', () =>
    expect(parseNumberStrict('1,234.50')).toEqual({ ok: true, value: 1234.5 }));
});

describe('convertWeight', () => {
  it('grams to kg', () => expect(convertWeight(245, 'gramo')).toEqual({ ok: true, kg: 0.245 }));
  it('lb to kg', () => { const r = convertWeight(1, 'lb'); expect(r.ok && Math.abs(r.kg - 0.453592) < 1e-6).toBe(true); });
  it('fails unknown unit', () => expect(convertWeight(1, 'cubits')).toEqual({ ok: false }));
});

describe('parseManifestDate', () => {
  it('parses an Excel serial number', () => expect(parseManifestDate(45000)).toEqual({ ok: true, iso: '2023-03-15' }));
  it('parses an ISO string', () => expect(parseManifestDate('2024-01-31')).toEqual({ ok: true, iso: '2024-01-31' }));
  it('parses dd/mm/yyyy', () => expect(parseManifestDate('31/01/2024')).toEqual({ ok: true, iso: '2024-01-31' }));
  it('fails on garbage', () => expect(parseManifestDate('not a date')).toEqual({ ok: false }));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- shared/parsing/normalize.test.ts`
Expected: FAIL (imports not exported).

- [ ] **Step 3: Implement the helpers (append to normalize.ts)**

```ts
// shared/parsing/normalize.ts — append
import { weightFactorToKg } from './catalogs';

export type NumberResult = { ok: true; value: number } | { ok: false; code: 'not_a_number' | 'ambiguous_locale' };

// Strict variant of parseNumber: never silently coerces. Flags locale-ambiguous inputs
// like "1,000" where the comma could be a thousands separator OR a decimal point.
export function parseNumberStrict(raw: string): NumberResult {
  const s = String(raw ?? '').trim();
  if (!s) return { ok: false, code: 'not_a_number' };
  const cleaned = s.replace(/[^\d.,-]/g, '');
  if (!/\d/.test(cleaned)) return { ok: false, code: 'not_a_number' };
  const lastComma = cleaned.lastIndexOf(','), lastDot = cleaned.lastIndexOf('.');
  // Ambiguous: exactly one comma, no dot, and exactly 3 digits after the comma → could be 1.000 or 1000.
  if (lastComma !== -1 && lastDot === -1) {
    const after = cleaned.slice(lastComma + 1);
    const commas = (cleaned.match(/,/g) ?? []).length;
    if (commas === 1 && /^\d{3}$/.test(after)) return { ok: false, code: 'ambiguous_locale' };
  }
  let t = cleaned;
  if (lastComma > lastDot) t = t.replace(/\./g, '').replace(',', '.');
  else t = t.replace(/,/g, '');
  const n = Number(t);
  return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, code: 'not_a_number' };
}

export function convertWeight(value: number, unit: string): { ok: true; kg: number } | { ok: false } {
  const factor = weightFactorToKg(unit);
  if (factor === null) return { ok: false };
  return { ok: true, kg: value * factor };
}

// Excel serial epoch is 1899-12-30 (accounts for the Lotus 1900 leap-year bug).
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
const iso = (d: Date): string => d.toISOString().slice(0, 10);

export function parseManifestDate(raw: unknown): { ok: true; iso: string } | { ok: false } {
  if (raw == null || raw === '') return { ok: false };
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return { ok: true, iso: iso(new Date(EXCEL_EPOCH + raw * 86400000)) };
  }
  const s = String(raw).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) { const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])); return Number.isNaN(d.getTime()) ? { ok: false } : { ok: true, iso: iso(d) }; }
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/); // dd/mm/yyyy
  if (m) { const d = new Date(Date.UTC(+m[3], +m[2] - 1, +m[1])); return Number.isNaN(d.getTime()) || +m[2] > 12 ? { ok: false } : { ok: true, iso: iso(d) }; }
  return { ok: false };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- shared/parsing/normalize.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/parsing/normalize.ts shared/parsing/normalize.test.ts
git commit -m "feat(parsing): strict number/weight/date helpers (no silent coercion)"
```

---

## Task 4: `procedenceCountry` field + header remap + `mapRowToShipment`

**Files:**
- Modify: `shared/types/shipment.ts:49`, `shared/parsing/headerSynonyms.ts:12`, `shared/parsing/manifestParser.ts`, `shared/parsing/manifestParser.test.ts`

**Interfaces:**
- Produces:
  - `Shipment.procedenceCountry?: string` (país de procedencia / shipped-from).
  - `mapRowToShipment(row: Record<string, unknown>): Shipment` exported from `manifestParser.ts` (the per-row mapping extracted from `parseManifestRows`; populates `procedenceCountry` from sender country code/name).
- `parseManifestRows` keeps its current `(rows, mawb) => ParseResult` signature (now delegates per-row to `mapRowToShipment`).

- [ ] **Step 1: Update the existing test expectation (procedencia → procedenceCountry)**

In `shared/parsing/manifestParser.test.ts`, change the procedencia assertion and add a sender-derived one:

```ts
    expect(out.shipments[0].procedenceCountry).toBe('CN'); // was originCountry
    expect(out.shipments[0].originCountry).toBe('');        // no manufacture-origin column → empty
```

Add a case proving sender columns drive procedence:

```ts
  it('derives procedenceCountry from the sender country column', () => {
    const { shipments } = parseManifestRows(
      [{ 'Código de país del remitente': 'CN', 'Destinatario (CNNE)': 'Juan' }], 'M');
    expect(shipments[0].procedenceCountry).toBe('CN');
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- shared/parsing/manifestParser.test.ts`
Expected: FAIL (`procedenceCountry` undefined / `originCountry` still 'CN').

- [ ] **Step 3: Add the type field**

In `shared/types/shipment.ts`, inside `ShipmentCore` after `originCountry: string;` (line 49):

```ts
  originCountry: string;       // país de origen (manufactured) — NOT derivable from shipper
  procedenceCountry?: string;  // país de procedencia (shipped-from) — from sender country
```

- [ ] **Step 4: Remap the procedencia header**

In `shared/parsing/headerSynonyms.ts:12` change:

```ts
  'pais de procedencia': 'core.procedenceCountry',
```

- [ ] **Step 5: Extract `mapRowToShipment` and populate procedenceCountry**

Replace the body of `parseManifestRows` in `shared/parsing/manifestParser.ts` so the per-row mapping is a reusable export, and derive `procedenceCountry` from the sender country after mapping. Keep the existing `core.originCountry` uppercase + numeric handling:

```ts
import { resolveCountry } from './catalogs';

export function mapRowToShipment(row: Record<string, unknown>): Shipment {
  const s: any = blankShipment('');
  for (const [rawHeader, raw] of Object.entries(row)) {
    const path = resolveHeader(rawHeader);
    if (!path) continue;
    let value = cleanCell(raw);
    if (path === 'core.originCountry') value = value.toUpperCase();
    if (path === 'core.quantity') { s.quantity = parseNumber(value); continue; }
    if (path === 'core.customsValueUsd') { s.customsValueUsd = parseNumber(value); continue; }
    if (path === 'core.unitPrice') { s.unitPrice = parseNumber(value); continue; }
    if (path === 'core.weight') { s.weight = parseNumber(value); continue; }
    if (path === 'core.appliedRate') { s.appliedRate = parseNumber(value); continue; }
    if (rawHeader && resolveHeader(rawHeader) && path.endsWith('.rfc')) {
      // generic ID column → route by shape (RFC vs CURP)
      if (classifyTaxId(value) === 'curp') { s.consignee.curp = value; continue; }
      s.consignee.rfc = value; continue;
    }
    const [group, key] = path.split('.');
    if (group === 'core') s[key] = value;
    else s[group][key] = value;
  }
  if (s.weight != null) s.weightKg = toKg(s.weight, s.weightUnit ?? '');
  // país de procedencia: explicit column, else sender country code/name.
  const proc = s.procedenceCountry || s.sender?.countryCode || s.sender?.countryName || '';
  const resolvedProc = resolveCountry(proc);
  s.procedenceCountry = resolvedProc ?? (proc ? String(proc).toUpperCase() : '');
  return s as Shipment;
}

export function parseManifestRows(rows: Record<string, unknown>[], mawb: string): ParseResult {
  const unmapped = new Set<string>();
  const shipments = rows.map((row) => {
    for (const rawHeader of Object.keys(row)) if (!resolveHeader(rawHeader)) unmapped.add(rawHeader);
    const s = mapRowToShipment(row);
    return { ...s, mawbReference: mawb };
  });
  return { shipments, unmappedHeaders: [...unmapped] };
}
```

Add the `classifyTaxId` import at the top: `import { classifyTaxId } from './taxId';` (if not already present).

> NOTE: `blankShipment` already initializes `consignee.rfc = ''`. The CURP branch leaves `rfc` as `''`, matching the existing test (`rfc` `''`, `curp` set).

- [ ] **Step 6: Run to verify it passes**

Run: `npm test -- shared/parsing/manifestParser.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the full lint to catch type ripples**

Run: `npm run lint`
Expected: PASS (no errors; `originCountry` untouched, `procedenceCountry` is optional/additive).

- [ ] **Step 8: Commit**

```bash
git add shared/types/shipment.ts shared/parsing/headerSynonyms.ts shared/parsing/manifestParser.ts shared/parsing/manifestParser.test.ts
git commit -m "feat(parsing): add procedenceCountry (sender), stop origin/procedencia conflation"
```

---

## Task 5: Staging types + the validator

**Files:**
- Create: `shared/types/staging.ts`, `shared/parsing/validateManifest.ts`, `shared/parsing/validateManifest.test.ts`

**Interfaces:**
- Consumes: `mapRowToShipment` (Task 4), `parseNumberStrict`/`convertWeight`/`parseManifestDate` (Task 3), `resolveCountry`/`resolveCurrency` (Task 2), `resolveHeader` (`headerSynonyms`), `classifyTaxId` (`taxId`), `Shipment` type.
- Produces (in `shared/types/staging.ts`):
  ```ts
  export type RowSeverity = 'error' | 'warning';
  export type RowStatus = 'valid' | 'warning' | 'error';
  export interface RowIssue { rowIndex: number; field: string; code: string; severity: RowSeverity; message: string; rawValue?: string; }
  export interface StagingRow { rowIndex: number; status: RowStatus; idempotencyKey: string; shipment: Shipment; errors: RowIssue[]; warnings: RowIssue[]; }
  export interface IngestResult { rows: StagingRow[]; counts: { total: number; valid: number; warning: number; error: number }; unmappedHeaders: string[]; duplicateHeaders: string[]; fileRejected: boolean; }
  ```
- Produces (in `validateManifest.ts`): `validateManifest(headerRow: string[], dataRows: unknown[][], mawb: string): IngestResult`.

- [ ] **Step 1: Write the failing test**

```ts
// shared/parsing/validateManifest.test.ts
import { describe, expect, it } from 'vitest';
import { validateManifest } from './validateManifest';

const H = ['Número de guía de embarque', 'Descripción del Producto', 'Código HS', 'Número de productos',
  'Valor total declarado', 'Divisa', 'Código de país del remitente', 'ID', 'Peso', 'Unidad de peso'];
const row = (over: Partial<Record<string, unknown>> = {}) => {
  const base: Record<string, unknown> = {
    'Número de guía de embarque': 'G1', 'Descripción del Producto': 'Camisa', 'Código HS': '6109100022',
    'Número de productos': '1', 'Valor total declarado': '6.03', 'Divisa': 'Dólar estadounidense',
    'Código de país del remitente': 'CN', 'ID': 'AERA790828HBSRBR04', 'Peso': '245', 'Unidad de peso': 'gramo',
  };
  return H.map((h) => (h in over ? over[h] : base[h]));
};

describe('validateManifest', () => {
  it('accepts a clean row with a país-de-origen warning', () => {
    const r = validateManifest(H, [row()], 'MAWB');
    expect(r.counts).toEqual({ total: 1, valid: 0, warning: 1, error: 0 });
    const sr = r.rows[0];
    expect(sr.status).toBe('warning');
    expect(sr.warnings.map((w) => w.code)).toContain('origin_undeclared');
    expect(sr.shipment.procedenceCountry).toBe('CN');
    expect(sr.shipment.currency).toBe('USD');
    expect(sr.shipment.weightKg).toBeCloseTo(0.245);
    expect(sr.idempotencyKey).toBe('MAWB|G1|1|6109100022');
  });
  it('errors on a non-numeric value', () => {
    const r = validateManifest(H, [row({ 'Valor total declarado': 'N/A' })], 'M');
    expect(r.rows[0].status).toBe('error');
    expect(r.rows[0].errors.map((e) => e.code)).toContain('value_not_a_number');
  });
  it('errors on locale-ambiguous value "1,000"', () => {
    const r = validateManifest(H, [row({ 'Valor total declarado': '1,000' })], 'M');
    expect(r.rows[0].errors.map((e) => e.code)).toContain('value_ambiguous');
  });
  it('errors on unknown currency and unknown country', () => {
    const r = validateManifest(H, [row({ 'Divisa': 'Quatloos', 'Código de país del remitente': 'ZZ' })], 'M');
    const codes = r.rows[0].errors.map((e) => e.code);
    expect(codes).toContain('currency_unknown');
    expect(codes).toContain('procedence_unknown');
  });
  it('errors on unknown weight unit', () => {
    const r = validateManifest(H, [row({ 'Unidad de peso': 'cubits' })], 'M');
    expect(r.rows[0].errors.map((e) => e.code)).toContain('weight_unit_unknown');
  });
  it('errors on blank required description', () => {
    const r = validateManifest(H, [row({ 'Descripción del Producto': '' })], 'M');
    expect(r.rows[0].errors.map((e) => e.code)).toContain('description_required');
  });
  it('warns (not errors) on a missing consignee identity', () => {
    const r = validateManifest(H, [row({ 'ID': '' })], 'M');
    expect(r.rows[0].warnings.map((w) => w.code)).toContain('identity_missing');
    expect(r.rows[0].status).not.toBe('error');
  });
  it('rejects the whole file on a duplicate mapped header', () => {
    const dupH = [...H, 'ID'];
    const r = validateManifest(dupH, [[...row(), 'PERJ800101AA8']], 'M');
    expect(r.fileRejected).toBe(true);
    expect(r.duplicateHeaders).toContain('ID');
  });
  it('assigns per-line lineSeq within the same guide', () => {
    const r = validateManifest(H, [row(), row()], 'M');
    expect(r.rows[0].idempotencyKey).toBe('M|G1|1|6109100022');
    expect(r.rows[1].idempotencyKey).toBe('M|G1|2|6109100022');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- shared/parsing/validateManifest.test.ts`
Expected: FAIL ("Cannot find module './validateManifest'").

- [ ] **Step 3: Create the staging types**

```ts
// shared/types/staging.ts
import type { Shipment } from './shipment';

export type RowSeverity = 'error' | 'warning';
export type RowStatus = 'valid' | 'warning' | 'error';

export interface RowIssue {
  rowIndex: number;
  field: string;
  code: string;
  severity: RowSeverity;
  message: string;
  rawValue?: string;
}

export interface StagingRow {
  rowIndex: number;
  status: RowStatus;
  idempotencyKey: string;
  shipment: Shipment;
  errors: RowIssue[];
  warnings: RowIssue[];
}

export interface IngestResult {
  rows: StagingRow[];
  counts: { total: number; valid: number; warning: number; error: number };
  unmappedHeaders: string[];
  duplicateHeaders: string[];
  fileRejected: boolean;
}
```

- [ ] **Step 4: Implement the validator**

```ts
// shared/parsing/validateManifest.ts
import type { IngestResult, RowIssue, RowStatus, StagingRow } from '../types/staging';
import { mapRowToShipment } from './manifestParser';
import { resolveHeader } from './headerSynonyms';
import { resolveCountry, resolveCurrency } from './catalogs';
import { parseNumberStrict, convertWeight, parseManifestDate } from './normalize';

const str = (v: unknown): string => String(v ?? '').trim();

export function validateManifest(headerRow: string[], dataRows: unknown[][], mawb: string): IngestResult {
  // Duplicate mapped headers → ambiguous provenance → whole-file rejection.
  const seen = new Map<string, number>();
  const duplicateHeaders: string[] = [];
  const unmapped = new Set<string>();
  for (const h of headerRow) {
    const path = resolveHeader(h);
    if (!path) { unmapped.add(h); continue; }
    seen.set(path, (seen.get(path) ?? 0) + 1);
    if (seen.get(path) === 2) duplicateHeaders.push(h);
  }
  if (duplicateHeaders.length) {
    return { rows: [], counts: { total: 0, valid: 0, warning: 0, error: 0 }, unmappedHeaders: [...unmapped], duplicateHeaders, fileRejected: true };
  }

  const lineSeq = new Map<string, number>();
  const rows: StagingRow[] = dataRows.map((cells, rowIndex) => {
    const record: Record<string, unknown> = {};
    headerRow.forEach((h, i) => { record[h] = cells[i]; });
    const shipment = mapRowToShipment(record);
    shipment.mawbReference = mawb;

    const errors: RowIssue[] = [];
    const warnings: RowIssue[] = [];
    const err = (field: string, code: string, message: string, rawValue?: string) => errors.push({ rowIndex, field, code, severity: 'error', message, rawValue });
    const warn = (field: string, code: string, message: string, rawValue?: string) => warnings.push({ rowIndex, field, code, severity: 'warning', message, rawValue });

    const get = (path: string): string => {
      for (const h of headerRow) if (resolveHeader(h) === path) return str(record[h]);
      return '';
    };

    // Required text
    if (!str(shipment.description)) err('description', 'description_required', 'Descripción de la mercancía requerida');
    if (!str(shipment.hsCode)) err('hsCode', 'hscode_required', 'Código HS requerido');
    else if (!/^\d{8}$|^\d{10}$/.test(str(shipment.hsCode).replace(/\./g, ''))) warn('hsCode', 'hscode_format', 'Código HS debe ser de 8 o 10 dígitos', str(shipment.hsCode));
    if (!str(shipment.guideId)) err('guideId', 'guide_required', 'Número de guía requerido');

    // Required numbers (strict — no silent coercion)
    const valueRaw = get('core.customsValueUsd');
    const v = parseNumberStrict(valueRaw);
    if (!v.ok) err('customsValueUsd', v.code === 'ambiguous_locale' ? 'value_ambiguous' : 'value_not_a_number',
      v.code === 'ambiguous_locale' ? 'Valor ambiguo (separador de miles/decimal)' : 'Valor declarado no numérico', valueRaw);
    else if (v.value <= 0) err('customsValueUsd', 'value_non_positive', 'Valor debe ser > 0 (declare valor reconstruido si es muestra sin valor comercial)', valueRaw);

    const qtyRaw = get('core.quantity');
    const q = parseNumberStrict(qtyRaw);
    if (!q.ok) err('quantity', q.code === 'ambiguous_locale' ? 'quantity_ambiguous' : 'quantity_not_a_number', 'Cantidad no numérica', qtyRaw);
    else if (q.value <= 0) err('quantity', 'quantity_non_positive', 'Cantidad debe ser > 0', qtyRaw);

    // Currency
    const currencyRaw = get('core.currency');
    const cur = resolveCurrency(currencyRaw);
    if (!str(currencyRaw)) err('currency', 'currency_required', 'Moneda requerida');
    else if (!cur) err('currency', 'currency_unknown', `Moneda no reconocida: ${currencyRaw}`, currencyRaw);
    else shipment.currency = cur;

    // Procedence country (sender) — required
    const procRaw = get('core.procedenceCountry') || str(shipment.sender?.countryCode) || str(shipment.sender?.countryName);
    if (!str(procRaw)) err('procedenceCountry', 'procedence_required', 'País de procedencia requerido');
    else if (!resolveCountry(procRaw)) err('procedenceCountry', 'procedence_unknown', `País de procedencia no reconocido: ${procRaw}`, procRaw);

    // Origin country (manufactured) — WARNING at ingestion (hard-gated in Phase B)
    if (!str(shipment.originCountry)) warn('originCountry', 'origin_undeclared', 'País de origen no declarado (requerido al generar el pedimento)');

    // Weight unit (only when a weight is present)
    const weightUnitRaw = get('core.weightUnit');
    if (shipment.weight != null && str(weightUnitRaw)) {
      const w = convertWeight(shipment.weight, weightUnitRaw);
      if (!w.ok) err('weightUnit', 'weight_unit_unknown', `Unidad de peso no reconocida: ${weightUnitRaw}`, weightUnitRaw);
      else shipment.weightKg = w.kg;
    }

    // Date (only when present)
    const dateRaw = get('core.arrivalDate');
    if (str(dateRaw)) {
      const d = parseManifestDate(record[headerRow.find((h) => resolveHeader(h) === 'core.arrivalDate') ?? '']);
      if (!d.ok) err('arrivalDate', 'date_invalid', `Fecha inválida: ${dateRaw}`, dateRaw);
      else shipment.arrivalDate = d.iso;
    }

    // Consignee identity — presence required, but missing/invalid is a WARNING (generic-RFC path)
    const idRaw = str(shipment.consignee.rfc) || str(shipment.consignee.curp);
    if (!idRaw) warn('consignee.id', 'identity_missing', 'Identidad del destinatario ausente (se podrá usar RFC genérico)');

    // Idempotency key: per-line within the guide
    const guide = str(shipment.guideId);
    const next = (lineSeq.get(guide) ?? 0) + 1;
    lineSeq.set(guide, next);
    const idempotencyKey = `${mawb}|${guide}|${next}|${str(shipment.hsCode)}`;

    const status: RowStatus = errors.length ? 'error' : warnings.length ? 'warning' : 'valid';
    return { rowIndex, status, idempotencyKey, shipment, errors, warnings };
  });

  const counts = {
    total: rows.length,
    valid: rows.filter((r) => r.status === 'valid').length,
    warning: rows.filter((r) => r.status === 'warning').length,
    error: rows.filter((r) => r.status === 'error').length,
  };
  return { rows, counts, unmappedHeaders: [...unmapped], duplicateHeaders: [], fileRejected: false };
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npm test -- shared/parsing/validateManifest.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add shared/types/staging.ts shared/parsing/validateManifest.ts shared/parsing/validateManifest.test.ts
git commit -m "feat(parsing): per-row manifest validator with quarantine + idempotency key"
```

---

## Task 6: SHA-256 content hash in `saveFile`

**Files:**
- Modify: `server/src/storage/files.ts`
- Test: `server/test/storage/files.test.ts`

**Interfaces:**
- Produces: `FileMeta.contentHash: string`; `files.content_hash` populated on insert.

- [ ] **Step 1: Write the failing test**

```ts
// server/test/storage/files.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { saveFile } from '../../src/storage/files';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

beforeEach(truncateAll);

describe('saveFile', () => {
  it('stores and returns a SHA-256 content hash', async () => {
    const bytes = Buffer.from('hello manifest');
    const expected = createHash('sha256').update(bytes).digest('hex');
    const meta = await saveFile({ kind: 'manifest', originalName: 'm.xlsx', bytes, uploadedBy: null });
    expect(meta.contentHash).toBe(expected);
    const { rows } = await query('SELECT content_hash FROM files WHERE id=$1', [meta.id]);
    expect(rows[0].content_hash).toBe(expected);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix server test -- test/storage/files.test.ts`
Expected: FAIL (`contentHash` undefined).

- [ ] **Step 3: Implement**

In `server/src/storage/files.ts`: import `createHash`, add `contentHash` to `FileMeta`, compute and persist it.

```ts
import { createHash } from 'node:crypto';
// ...
export interface FileMeta { id: string; kind: FileKind; originalName: string; storagePath: string; sizeBytes: number; contentHash: string; }
```

In `saveFile`, after computing `storagePath` and before the INSERT:

```ts
  const contentHash = createHash('sha256').update(input.bytes).digest('hex');
  await writeFile(storagePath, input.bytes);
  await query(
    `INSERT INTO files (id, kind, original_name, storage_path, size_bytes, uploaded_by, content_hash) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, input.kind, input.originalName, storagePath, input.bytes.length, input.uploadedBy, contentHash],
  );
  return { id, kind: input.kind, originalName: input.originalName, storagePath, sizeBytes: input.bytes.length, contentHash };
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm --prefix server test -- test/storage/files.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/storage/files.ts server/test/storage/files.test.ts
git commit -m "feat(storage): SHA-256 content_hash on saved files"
```

---

## Task 7: Server ingest service (`XLSX.read` → validator)

**Files:**
- Create: `server/src/services/manifestIngest.ts`, `server/test/services/manifestIngest.test.ts`

**Interfaces:**
- Consumes: `validateManifest` (Task 5), `xlsx`.
- Produces: `ingestWorkbook(bytes: Buffer, mawb: string): IngestResult` — reads the first sheet as a 2-D array (header row + data rows) and validates.

- [ ] **Step 1: Write the failing test**

```ts
// server/test/services/manifestIngest.test.ts
import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { ingestWorkbook } from '../../src/services/manifestIngest';

function buildXlsx(aoa: unknown[][]): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Hoja1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

describe('ingestWorkbook', () => {
  it('reads a workbook and validates rows', () => {
    const bytes = buildXlsx([
      ['Número de guía de embarque', 'Descripción del Producto', 'Código HS', 'Número de productos', 'Valor total declarado', 'Divisa', 'Código de país del remitente'],
      ['G1', 'Camisa', '6109100022', '1', '6.03', 'Dólar estadounidense', 'CN'],
    ]);
    const r = ingestWorkbook(bytes, 'MAWB');
    expect(r.counts.total).toBe(1);
    expect(r.rows[0].shipment.guideId).toBe('G1');
    expect(r.rows[0].shipment.currency).toBe('USD');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix server test -- test/services/manifestIngest.test.ts`
Expected: FAIL ("Cannot find module").

- [ ] **Step 3: Implement**

```ts
// server/src/services/manifestIngest.ts
import * as XLSX from 'xlsx';
import { validateManifest } from '../../../shared/parsing/validateManifest';
import type { IngestResult } from '../../../shared/types/staging';

// Server-only: turn workbook bytes into (header row, data rows) and validate.
export function ingestWorkbook(bytes: Buffer, mawb: string): IngestResult {
  const wb = XLSX.read(bytes, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '', blankrows: false });
  const headerRow = (aoa[0] ?? []).map((h) => String(h ?? '').trim());
  const dataRows = aoa.slice(1);
  return validateManifest(headerRow, dataRows, mawb);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm --prefix server test -- test/services/manifestIngest.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/manifestIngest.ts server/test/services/manifestIngest.test.ts
git commit -m "feat(server): manifest ingest service (XLSX.read -> validator)"
```

---

## Task 8: Multipart upload → staging persistence

**Files:**
- Modify: `server/src/routes/manifests.ts`
- Test: `server/test/routes/manifests.test.ts` (rewrite)

**Interfaces:**
- Consumes: `ingestWorkbook` (Task 7), `saveFile` (Task 6), `encryptConsignee`, `multer`.
- Produces: `POST /api/manifests` (multipart `file` + `mawbReference` + `clientName`) → persists bronze file + silver rows; response `{ manifestId, ingestionStatus, counts, rejected, warnings, unmappedHeaders, duplicateHeaders }`.

- [ ] **Step 1: Rewrite the route test**

```ts
// server/test/routes/manifests.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import * as XLSX from 'xlsx';
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
  const { rows } = await query(`INSERT INTO users (username,password_hash,role) VALUES ('cap',$1,'capturista') RETURNING id`, [hash]);
  token = signToken({ userId: rows[0].id, role: 'capturista' });
});

function xlsxBuffer(aoa: unknown[][]): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Hoja1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}
const HEADER = ['Número de guía de embarque', 'Descripción del Producto', 'Código HS', 'Número de productos', 'Valor total declarado', 'Divisa', 'Código de país del remitente', 'ID'];
const GOOD = ['G1', 'Camisa', '6109100022', '1', '6.03', 'Dólar estadounidense', 'CN', 'AERA790828HBSRBR04'];
const BAD = ['G2', 'Camisa', '6109100022', '1', 'N/A', 'Dólar estadounidense', 'CN', 'AERA790828HBSRBR04'];

describe('POST /api/manifests (multipart staging)', () => {
  it('stages rows, quarantines bad ones, persists nothing to shipments yet', async () => {
    const res = await request(app)
      .post('/api/manifests')
      .set('Authorization', `Bearer ${token}`)
      .field('mawbReference', '369-1')
      .field('clientName', 'Cliente A')
      .attach('file', xlsxBuffer([HEADER, GOOD, BAD]), 'm.xlsx');
    expect(res.status).toBe(201);
    expect(res.body.counts).toEqual({ total: 2, valid: 0, warning: 1, error: 1 });
    expect(res.body.rejected.length).toBe(1);
    const staged = await query('SELECT count(*)::int AS n FROM manifest_staging_rows');
    expect(staged.rows[0].n).toBe(2);
    const ships = await query('SELECT count(*)::int AS n FROM shipments');
    expect(ships.rows[0].n).toBe(0); // gold is empty until promotion
    const man = await query('SELECT ingestion_status FROM manifests WHERE id=$1', [res.body.manifestId]);
    expect(man.rows[0].ingestion_status).toBe('staged');
  });

  it('rejects a non-file request', async () => {
    const res = await request(app).post('/api/manifests').set('Authorization', `Bearer ${token}`).field('mawbReference', 'x');
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix server test -- test/routes/manifests.test.ts`
Expected: FAIL (route still JSON-based).

- [ ] **Step 3: Rewrite `POST /` in `server/src/routes/manifests.ts`**

Replace the imports and the `POST '/'` handler (keep the existing `POST /:id/client` handler untouched):

```ts
import { Router } from 'express';
import multer from 'multer';
import { query } from '../db/pool';
import { requireAuth, requireRole } from '../auth/middleware';
import { recordAudit } from '../services/audit';
import { encryptConsignee } from '../crypto/fieldCrypto';
import { saveFile } from '../storage/files';
import { ingestWorkbook } from '../services/manifestIngest';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });
const MAX_ROWS = 5000; // synchronous ceiling (async deferred to Increment 2)

export const manifestsRouter = Router();

manifestsRouter.post('/', requireAuth, requireRole('admin', 'capturista'), upload.single('file'), async (req, res) => {
  const { mawbReference, clientName } = req.body ?? {};
  if (!req.file) { res.status(400).json({ error: 'file required' }); return; }
  if (!mawbReference) { res.status(400).json({ error: 'mawbReference required' }); return; }

  const result = ingestWorkbook(req.file.buffer, mawbReference);
  if (result.fileRejected) {
    res.status(422).json({ error: 'Encabezados duplicados', duplicateHeaders: result.duplicateHeaders });
    return;
  }
  if (result.counts.total > MAX_ROWS) {
    res.status(413).json({ error: `El manifiesto excede ${MAX_ROWS} filas` });
    return;
  }

  const file = await saveFile({ kind: 'manifest', originalName: req.file.originalname, bytes: req.file.buffer, uploadedBy: req.user!.userId });
  const m = await query(
    `INSERT INTO manifests (mawb_reference, client_name, created_by, ingestion_status, source_file_id, source_header, file_content_hash)
     VALUES ($1,$2,$3,'staged',$4,$5,$6) RETURNING id`,
    [mawbReference, clientName ?? null, req.user!.userId, file.id, JSON.stringify(result.rows.length ? Object.keys(result.rows[0].shipment) : []), file.contentHash],
  );
  const manifestId = m.rows[0].id;

  for (const row of result.rows) {
    const encrypted = { ...row.shipment, consignee: encryptConsignee(row.shipment.consignee) };
    await query(
      `INSERT INTO manifest_staging_rows (manifest_id, row_index, idempotency_key, data, status, errors, warnings)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [manifestId, row.rowIndex, row.idempotencyKey, JSON.stringify(encrypted), row.status, JSON.stringify(row.errors), JSON.stringify(row.warnings)],
    );
  }

  await recordAudit({ userId: req.user!.userId, action: 'INGEST_MANIFEST', entity: 'manifest', entityId: manifestId,
    after: { fileContentHash: file.contentHash, counts: result.counts }, ip: req.ip });

  res.status(201).json({
    manifestId, ingestionStatus: 'staged', counts: result.counts,
    rejected: result.rows.flatMap((r) => r.errors), warnings: result.rows.flatMap((r) => r.warnings),
    unmappedHeaders: result.unmappedHeaders, duplicateHeaders: result.duplicateHeaders,
  });
});
```

> NOTE: `source_header` stores the canonical field keys for audit reference. Persisting the literal raw header array is a Phase-A-acceptable simplification; full raw-row lineage is deferred (spec §12).

- [ ] **Step 4: Run to verify it passes**

Run: `npm --prefix server test -- test/routes/manifests.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/manifests.ts server/test/routes/manifests.test.ts
git commit -m "feat(server): multipart manifest upload -> silver staging (no auto-persist)"
```

---

## Task 9: Staging read + rejects export

**Files:**
- Modify: `server/src/routes/manifests.ts`
- Test: `server/test/routes/manifests.test.ts` (append)

**Interfaces:**
- Consumes: the staged rows from Task 8.
- Produces: `GET /api/manifests/:id/staging` → `{ rows: [{ rowIndex, status, errors, warnings }], counts }` (PII-redacted: no decrypted consignee fields returned).

- [ ] **Step 1: Append the failing test**

```ts
// server/test/routes/manifests.test.ts — append inside the describe block
  it('returns staging rows with statuses and redacts PII', async () => {
    const up = await request(app).post('/api/manifests').set('Authorization', `Bearer ${token}`)
      .field('mawbReference', '369-2').attach('file', xlsxBuffer([HEADER, GOOD, BAD]), 'm.xlsx');
    const res = await request(app).get(`/api/manifests/${up.body.manifestId}/staging`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.rows.length).toBe(2);
    expect(res.body.rows.map((r: any) => r.status).sort()).toEqual(['error', 'warning']);
    expect(JSON.stringify(res.body)).not.toContain('AERA790828HBSRBR04'); // raw PII not leaked
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix server test -- test/routes/manifests.test.ts`
Expected: FAIL (404 — route missing).

- [ ] **Step 3: Add the `GET /:id/staging` route in `manifests.ts`**

```ts
manifestsRouter.get('/:id/staging', requireAuth, requireRole('admin', 'capturista'), async (req, res) => {
  const { rows } = await query<{ row_index: number; status: string; errors: unknown; warnings: unknown }>(
    'SELECT row_index, status, errors, warnings FROM manifest_staging_rows WHERE manifest_id=$1 ORDER BY row_index', [req.params.id]);
  const counts = { total: rows.length, valid: 0, warning: 0, error: 0 };
  for (const r of rows) (counts as Record<string, number>)[r.status]++;
  res.json({
    rows: rows.map((r) => ({ rowIndex: r.row_index, status: r.status, errors: r.errors, warnings: r.warnings })),
    counts,
  });
});
```

> PII redaction: this endpoint returns only `row_index/status/errors/warnings` — never the encrypted `data` blob — so no consignee identity is exposed.

- [ ] **Step 4: Run to verify it passes**

Run: `npm --prefix server test -- test/routes/manifests.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/manifests.ts server/test/routes/manifests.test.ts
git commit -m "feat(server): GET manifest staging rows (PII-redacted)"
```

---

## Task 10: Promotion gate

**Files:**
- Modify: `server/src/routes/manifests.ts`
- Test: `server/test/routes/manifests.test.ts` (append)

**Interfaces:**
- Consumes: staged rows (Task 8), `computeLock` (`../services/manifestLock`).
- Produces: `POST /api/manifests/:id/promote` → upserts valid+warning rows into `shipments` by idempotency key, sets `risk_stale=true` + NULLs risk fields on upserted rows, flips `ingestion_status='promoted'`. Guards: must be `staged`; refuses if any `error` rows remain; refuses if zero promotable rows; 409 if `computeLock` says locked.

- [ ] **Step 1: Append the failing tests**

```ts
// server/test/routes/manifests.test.ts — append
  it('promotes valid+warning rows to shipments and is idempotent on re-upload', async () => {
    const up = await request(app).post('/api/manifests').set('Authorization', `Bearer ${token}`)
      .field('mawbReference', '369-3').attach('file', xlsxBuffer([HEADER, GOOD]), 'm.xlsx');
    const id = up.body.manifestId;
    const prom = await request(app).post(`/api/manifests/${id}/promote`).set('Authorization', `Bearer ${token}`);
    expect(prom.status).toBe(200);
    expect(prom.body.promoted).toBe(1);
    let ships = await query('SELECT count(*)::int AS n FROM shipments WHERE manifest_id=$1', [id]);
    expect(ships.rows[0].n).toBe(1);
    const man = await query('SELECT ingestion_status FROM manifests WHERE id=$1', [id]);
    expect(man.rows[0].ingestion_status).toBe('promoted');
    // second promote is rejected (state machine guard)
    const again = await request(app).post(`/api/manifests/${id}/promote`).set('Authorization', `Bearer ${token}`);
    expect(again.status).toBe(409);
  });

  it('refuses promotion while error rows remain', async () => {
    const up = await request(app).post('/api/manifests').set('Authorization', `Bearer ${token}`)
      .field('mawbReference', '369-4').attach('file', xlsxBuffer([HEADER, GOOD, BAD]), 'm.xlsx');
    const prom = await request(app).post(`/api/manifests/${up.body.manifestId}/promote`).set('Authorization', `Bearer ${token}`);
    expect(prom.status).toBe(422);
    const ships = await query('SELECT count(*)::int AS n FROM shipments WHERE manifest_id=$1', [up.body.manifestId]);
    expect(ships.rows[0].n).toBe(0);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix server test -- test/routes/manifests.test.ts`
Expected: FAIL (404 — route missing).

- [ ] **Step 3: Add the promote route in `manifests.ts`**

Add `import { computeLock } from '../services/manifestLock';` then:

```ts
manifestsRouter.post('/:id/promote', requireAuth, requireRole('admin', 'capturista'), async (req, res) => {
  const id = req.params.id;
  const man = await query<{ ingestion_status: string; file_id: string | null; prevalidation: { status?: string } | null }>(
    'SELECT ingestion_status, file_id, prevalidation FROM manifests WHERE id=$1', [id]);
  if (!man.rows.length) { res.status(404).json({ error: 'Manifest not found' }); return; }
  const m = man.rows[0];
  if (!computeLock({ prevalidation: m.prevalidation, file_id: m.file_id }).editable) { res.status(409).json({ error: 'Manifiesto bloqueado' }); return; }
  if (m.ingestion_status !== 'staged') { res.status(409).json({ error: `No se puede promover desde estado '${m.ingestion_status}'` }); return; }

  const staged = await query<{ row_index: number; idempotency_key: string; data: unknown; status: string }>(
    `SELECT row_index, idempotency_key, data, status FROM manifest_staging_rows WHERE manifest_id=$1`, [id]);
  if (staged.rows.some((r) => r.status === 'error')) { res.status(422).json({ error: 'Hay filas con errores; corríjalas antes de promover' }); return; }
  const promotable = staged.rows.filter((r) => r.status === 'valid' || r.status === 'warning');
  if (!promotable.length) { res.status(422).json({ error: 'No hay filas promovibles' }); return; }

  for (const r of promotable) {
    await query(
      `INSERT INTO shipments (id, manifest_id, data, idempotency_key)
       VALUES (gen_random_uuid(), $1, $2, $3)
       ON CONFLICT (manifest_id, idempotency_key)
       DO UPDATE SET data = EXCLUDED.data, risk_score = NULL, risk_color = NULL, risk_incidences = NULL`,
      [id, JSON.stringify(r.data), r.idempotency_key]);
  }
  await query(`UPDATE manifest_staging_rows SET promoted_at = now() WHERE manifest_id=$1 AND status IN ('valid','warning')`, [id]);
  await query(`UPDATE manifests SET ingestion_status='promoted', risk_stale=true WHERE id=$1`, [id]);
  await recordAudit({ userId: req.user!.userId, action: 'PROMOTE_MANIFEST', entity: 'manifest', entityId: id, after: { promoted: promotable.length }, ip: req.ip });

  res.json({ promoted: promotable.length });
});
```

> The UPSERT writes the encrypted `data` blob verbatim (staging already encrypted it; `encryptConsignee` is `v1:`-idempotent so no re-encrypt). NULLing risk fields invalidates any prior score; `risk_stale=true` flags re-scoring.

- [ ] **Step 4: Run to verify it passes**

Run: `npm --prefix server test -- test/routes/manifests.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/manifests.ts server/test/routes/manifests.test.ts
git commit -m "feat(server): promotion gate (idempotent upsert + risk invalidation + guards)"
```

---

## Task 11: Golden test against the real manifest

**Files:**
- Create: `shared/parsing/manifestGolden.test.ts`

**Interfaces:**
- Consumes: `ingestWorkbook` is server-only, so the golden test reads the file with `xlsx` directly and calls `validateManifest` (shared). Uses `.playwright-mcp/MANIFEST_TEST.xlsx`.

- [ ] **Step 1: Write the golden test**

```ts
// shared/parsing/manifestGolden.test.ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as XLSX from 'xlsx';
import { validateManifest } from './validateManifest';

describe('golden: real MANIFEST_TEST.xlsx', () => {
  const path = resolve(__dirname, '../../.playwright-mcp/MANIFEST_TEST.xlsx');
  const wb = XLSX.read(readFileSync(path), { type: 'buffer' });
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', blankrows: false });
  const header = (aoa[0] as unknown[]).map((h) => String(h ?? '').trim());
  const data = aoa.slice(1);

  it('ingests all 501 rows with 0 hard errors, origin warning on every row', () => {
    const r = validateManifest(header, data, 'GOLDEN');
    expect(r.fileRejected).toBe(false);
    expect(r.counts.total).toBe(501);
    expect(r.counts.error).toBe(0);
    expect(r.counts.warning).toBe(501); // every row carries the origin-undeclared warning
    expect(r.rows.every((row) => row.warnings.some((w) => w.code === 'origin_undeclared'))).toBe(true);
  });

  it('normalizes procedence/currency/weight and emits 501 distinct keys', () => {
    const r = validateManifest(header, data, 'GOLDEN');
    expect(r.rows[0].shipment.procedenceCountry).toBe('CN');
    expect(r.rows[0].shipment.currency).toBe('USD');
    expect(r.rows[0].shipment.weightKg).toBeCloseTo(0.245);
    expect(new Set(r.rows.map((row) => row.idempotencyKey)).size).toBe(501);
  });
});
```

- [ ] **Step 2: Run the golden test**

Run: `npm test -- shared/parsing/manifestGolden.test.ts`
Expected: PASS. (If `counts.error > 0`, inspect `r.rows.filter(x=>x.status==='error')[0].errors` — likely a catalog gap; extend `catalogs.ts` rather than weakening a rule.)

- [ ] **Step 3: Commit**

```bash
git add shared/parsing/manifestGolden.test.ts
git commit -m "test(parsing): golden ingest of real MANIFEST_TEST.xlsx (501 rows, 0 errors)"
```

---

## Task 12: Frontend two-step flow + cleanup

**Files:**
- Modify: `src/components/RegistroView.tsx:73-97`
- Modify: `src/context/T1Context.tsx:171`
- Delete: `src/utils/fileParser.ts`

**Interfaces:**
- Consumes: `POST /api/manifests` (multipart), `GET /:id/staging`, `POST /:id/promote`, then existing `POST /:id/risk`.

- [ ] **Step 1: Replace the upload handler in `RegistroView.tsx`**

Replace the `try` block body (lines ~73-91) so it posts the raw file via `FormData`, shows the staging report, and only runs risk after promotion. (Uses the existing `apiPost`; add a raw-fetch for multipart since `apiPost` sends JSON.)

```tsx
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('mawbReference', mawbReference);
      if (clientName) form.append('clientName', clientName);
      const token = localStorage.getItem('token'); // same source apiPost uses
      const upRes = await fetch(`${BASE}/api/manifests`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
      if (!upRes.ok) throw new Error((await upRes.json().catch(() => ({}))).error ?? 'Error al subir el manifiesto');
      const staging = await upRes.json();
      setUnmappedHeaders(staging.unmappedHeaders ?? []);
      setStaging(staging); // { manifestId, counts, rejected, warnings }

      if (staging.counts.error > 0) { setCurrent(1); return; } // stop at review; operator fixes & re-uploads

      await apiPost(`/api/manifests/${staging.manifestId}/promote`, {});
      const risk = await apiPost<RiskResponse>(`/api/manifests/${staging.manifestId}/risk`, {});
      setResult(risk);
      setCheckedCount(VALIDATION_LABELS.length);
      setCurrent(2);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ocurrió un error al procesar el manifiesto.');
      setCurrent(0);
    }
```

Add near the other `useState` hooks: `const [staging, setStaging] = useState<{ manifestId: string; counts: { total: number; valid: number; warning: number; error: number }; rejected: { rowIndex: number; field: string; message: string }[] } | null>(null);` and ensure `BASE` is imported from `../api` (same module `apiPost` lives in). Remove the now-unused `import * as XLSX from 'xlsx'` and the `XLSX.read`/`sheet_to_json` lines.

- [ ] **Step 2: Render the review step**

In the JSX, under the existing stepper, add a block shown when `staging` has errors:

```tsx
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
```

- [ ] **Step 3: Remove the `'US'` fabrication in `T1Context.tsx:171`**

Change:

```ts
      paisOrigen: validShipments[0]?.originCountry || '',
```

- [ ] **Step 4: Delete the orphan parser**

```bash
git rm src/utils/fileParser.ts
```

- [ ] **Step 5: Verify the frontend builds and existing component tests pass**

Run: `npm run lint && npm test -- src/components/RegistroView.test.tsx`
Expected: PASS (no `xlsx`/`fileParser` references remain; type-check clean).

- [ ] **Step 6: Commit**

```bash
git add src/components/RegistroView.tsx src/context/T1Context.tsx
git commit -m "feat(ui): two-step manifest upload (review -> promote); drop orphan parser + US default"
```

---

## Final verification

- [ ] **Run the full shared/frontend suite:** `npm test` → all pass.
- [ ] **Run the full server suite:** `npm --prefix server test` → all pass.
- [ ] **Type-check:** `npm run lint` → clean.
- [ ] **Manual smoke (optional):** start server + frontend, upload `.playwright-mcp/MANIFEST_TEST.xlsx`, confirm 501 rows stage with origin warnings, promote succeeds, risk runs.

---

## Self-Review (completed by plan author)

**Spec coverage:** §3 architecture → Tasks 1,6,7,8,9,10. §4 país semantics → Task 4 (+ T1Context in 12). §5 validation rules → Tasks 2,3,5. §6 data model → Task 1; idempotency key → Task 5. §7 API → Tasks 8,9,10. §8 audit → Tasks 8,10. §9 UI → Task 12. §10 cleanup → Task 12. §11 tests → every task + Task 11 golden. §12 deferrals → respected (no raw-row table, no reprocess, no warning-ack UI, MAX_ROWS ceiling instead of async). §13 risks → encryption verbatim-copy (Task 10), additive field (Task 4).

**Placeholder scan:** none — all steps carry real code/commands.

**Type consistency:** `IngestResult`/`StagingRow`/`RowIssue` defined in Task 5 and consumed identically in Tasks 7–10; `ingestWorkbook`/`validateManifest`/`mapRowToShipment`/`parseNumberStrict`/`convertWeight`/`resolveCountry`/`resolveCurrency`/`weightFactorToKg` signatures match across producer and consumer tasks; `FileMeta.contentHash` produced in Task 6 and read in Task 8.
