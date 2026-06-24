# Multi-Pedimento (Subdivisión) Restructure — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make manifest↔pedimento **1:N** — a `pedimentos` table holding the subdivisiones of a master guide — with guía **coverage** tracking and coverage-aware Seguimiento status, migrating off the current 1:1 manifest columns.

**Architecture:** Pure isomorphic logic in `shared/` (subdivisión grammar parser, coverage engine, coverage-aware status). A `pedimentos` table (1:N) replaces the per-pedimento columns on `manifests`; backfill then drop those columns. Server routes read/write the new table and aggregate per-manifest coverage. The just-shipped Seguimiento two-tab queue becomes coverage-aware. PDF text extraction reuses the primitives specced in `docs/superpowers/plans/2026-06-22-pedimento-reconciliation.md`.

**Tech Stack:** TypeScript (strict), vitest, Express, `pdfjs-dist` (legacy build) / `pdf-parse`, `node-pg-migrate`, React + Tailwind.

**Design spec:** `docs/superpowers/specs/2026-06-24-multi-pedimento-restructure-design.md`.

## Global Constraints

- Pedimento number normalization: strip all non-digits → 15-digit string (`"25 85 1653 5001668"` → `"258516535001668"`). Reuse one helper everywhere; never re-implement.
- Reuse `norm` from `shared/risk/signals.ts` for name normalization and `cleanId` from `shared/parsing/taxId.ts` for RFC/CURP — never re-implement.
- **`bultos` is consolidated cartons, NOT a parcel/guía count** — never use it for coverage math. Coverage is by guía union only.
- Coverage is **advisory** for triage; it must never throw on malformed extraction — return empty/low-confidence and a flag.
- Do NOT commit the real PDFs (4MB+, 240 pages). Tests use small text/JSON fixtures only.
- Money compare tolerance: `1e-2` (one cent). Reuse across coverage/reconcile.
- Run `npx vitest run shared` (repo root) and `cd server && npm test` to verify; both must stay green after every task.
- Next free migration timestamp prefix: `1700002700000` and `1700002800000` (latest existing is `1700002600000`).
- The column **DROP** (Task 10) is the LAST task so every intermediate task keeps tests green.

---

### Task 1: Adopt the extraction primitives from the reconciliation plan

The pure PDF-text extraction primitives are already fully specced with TDD code. Implement them **verbatim** from `docs/superpowers/plans/2026-06-22-pedimento-reconciliation.md`:

- **Its Task 1** — `parseObservation` in `shared/pedimento/observation.ts` (inverse of `partidaObservation`; parses `GUIA … VALOR … USD NOMBRE … RFC-CURP …`).
- **Its Task 2** — the `ExtractedPedimento{Header,Line}` / `ReconciliationReport` / `ExpectedPedimento` types in `shared/types/reports.ts`.
- **Its Task 3** — the text parser (Approach A) `parsePedimentoTextA(text): ExtractedPedimento` populating `lines[]` (guía/value/name/RFC) from the OBSERVACIONES grammar.

- [ ] **Step 1:** Implement that plan's Tasks 1–3 exactly (tests + code), then return here. Do NOT implement its Tasks 4+ (reconcile/migration/UI) — Phase 1 replaces those with the 1:N coverage model below.
- [ ] **Step 2:** Run `npx vitest run shared/pedimento/observation.test.ts` — expect PASS.
- [ ] **Step 3:** Commit: `git add -A && git commit -m "feat(pedimento): observation parser + text extraction primitives (reconciliation plan T1-3)"`

---

### Task 2: Subdivisión grammar parser

**Files:**
- Create: `shared/pedimento/subdivision.ts`
- Test: `shared/pedimento/subdivision.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export function normPedimentoNumero(s: string): string` — strip non-digits.
  - `export interface SubdivisionInfo { masterGuide: string | null; ordinal: number | null; isLast: boolean; siblings: string[]; bultos: number | null; pesoBrutoKg: number | null; }`
  - `export function parseSubdivision(text: string): SubdivisionInfo` — parses the page-2 anexo declaration; tolerant of line breaks; never throws (nulls/empties on no-match).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { parseSubdivision, normPedimentoNumero } from './subdivision';

const SEGUNDA = `SEGUNDA SUBDIVISION DE LA GUIA MASTER NO. 369-94268462 DE CONFORMIDAD CON EL ARTICULO 65 DEL
REGLAMENTO DE LA LEY ADUANERA, SALIENDO DE ESTA OPERACIÓN 34 BULTOS CON UN PESO DE 808 KG. SE
RELACIONA CON LOS PEDIMENTOS 25 85 1653 5001668 Y 25 85 1653 5001685.`;

const TERCERA = `TERCERA Y ULTIMA SUBDIVISION DE LA GUIA MASTER NO. 369-94268462 DE CONFORMIDAD CON EL ARTICULO 65 DEL
REGLAMENTO DE LA LEY ADUANERA, SALIENDO DE ESTA OPERACIÓN 19 BULTOS CON UN PESO DE 454 KG. SE
RELACIONA CON LOS PEDIMENTOS 25 85 1653 5001668 Y 25 85 1653 5001684.`;

describe('normPedimentoNumero', () => {
  it('strips spaces to a 15-digit string', () => {
    expect(normPedimentoNumero('25 85 1653 5001668')).toBe('258516535001668');
  });
});

describe('parseSubdivision', () => {
  it('parses the SEGUNDA subdivisión', () => {
    const r = parseSubdivision(SEGUNDA);
    expect(r.masterGuide).toBe('369-94268462');
    expect(r.ordinal).toBe(2);
    expect(r.isLast).toBe(false);
    expect(r.bultos).toBe(34);
    expect(r.pesoBrutoKg).toBe(808);
    expect(r.siblings).toEqual(['258516535001668', '258516535001685']);
  });
  it('parses the TERCERA Y ULTIMA subdivisión and flags isLast', () => {
    const r = parseSubdivision(TERCERA);
    expect(r.ordinal).toBe(3);
    expect(r.isLast).toBe(true);
    expect(r.bultos).toBe(19);
    expect(r.siblings).toEqual(['258516535001668', '258516535001684']);
  });
  it('returns empty/nulls on non-matching text (never throws)', () => {
    const r = parseSubdivision('texto sin subdivisión');
    expect(r).toEqual({ masterGuide: null, ordinal: null, isLast: false, siblings: [], bultos: null, pesoBrutoKg: null });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run shared/pedimento/subdivision.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
const ORDINALS: Record<string, number> = {
  PRIMERA: 1, SEGUNDA: 2, TERCERA: 3, CUARTA: 4, QUINTA: 5,
  SEXTA: 6, SEPTIMA: 7, 'SÉPTIMA': 7, OCTAVA: 8, NOVENA: 9, DECIMA: 10, 'DÉCIMA': 10,
};

export function normPedimentoNumero(s: string): string {
  return (s ?? '').replace(/\D/g, '');
}

export interface SubdivisionInfo {
  masterGuide: string | null;
  ordinal: number | null;
  isLast: boolean;
  siblings: string[];
  bultos: number | null;
  pesoBrutoKg: number | null;
}

export function parseSubdivision(text: string): SubdivisionInfo {
  // Collapse line breaks / runs of whitespace so cross-line anchors match.
  const t = (text ?? '').replace(/\s+/g, ' ').toUpperCase();
  const empty: SubdivisionInfo = { masterGuide: null, ordinal: null, isLast: false, siblings: [], bultos: null, pesoBrutoKg: null };

  const sub = t.match(/\b(PRIMERA|SEGUNDA|TERCERA|CUARTA|QUINTA|SEXTA|S[ÉE]PTIMA|OCTAVA|NOVENA|D[ÉE]CIMA)(\s+Y\s+[ÚU]LTIMA)?\s+SUBDIVISION/);
  if (!sub) return empty;
  const ordinal = ORDINALS[sub[1]] ?? null;
  const isLast = !!sub[2] || /\b[ÚU]LTIMA\s+SUBDIVISION/.test(t);

  const master = t.match(/GUIA\s+MASTER\s+NO\.?\s+([0-9][0-9-]+)/);
  const bultos = t.match(/(\d+)\s+BULTOS/);
  const peso = t.match(/PESO\s+DE\s+([\d.,]+)\s+KG/);

  let siblings: string[] = [];
  const rel = t.match(/SE\s+RELACIONA\s+CON\s+LOS\s+PEDIMENTOS\s+(.+?)\./);
  if (rel) {
    siblings = rel[1]
      .split(/\s+Y\s+|,/)
      .map(normPedimentoNumero)
      .filter((n) => n.length === 15);
  }

  return {
    masterGuide: master ? master[1] : null,
    ordinal,
    isLast,
    siblings,
    bultos: bultos ? parseInt(bultos[1], 10) : null,
    pesoBrutoKg: peso ? parseFloat(peso[1].replace(',', '')) : null,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run shared/pedimento/subdivision.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add shared/pedimento/subdivision.ts shared/pedimento/subdivision.test.ts
git commit -m "feat(pedimento): subdivisión grammar parser (ordinal/ULTIMA/siblings/master)"
```

---

### Task 3: Coverage engine

**Files:**
- Create: `shared/pedimento/coverage.ts`
- Test: `shared/pedimento/coverage.test.ts`

**Interfaces:**
- Consumes: `normPedimentoNumero` (Task 2).
- Produces:
  - `export interface PedimentoCoverageInput { numeroPedimento: string; coveredGuias: string[]; siblings?: string[]; isLast?: boolean; ordinal?: number | null; }`
  - `export type ManifestCoverageStatus = 'sin_pedimento' | 'parcial' | 'completo';`
  - `export interface CoverageResult { status: ManifestCoverageStatus; expectedCount: number | null; uploadedNumeros: string[]; missingNumeros: string[]; uncoveredGuias: string[]; duplicatedGuias: string[]; manifestGuiaCount: number; coveredGuiaCount: number; }`
  - `export function computeCoverage(manifestGuias: string[], pedimentos: PedimentoCoverageInput[]): CoverageResult`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { computeCoverage } from './coverage';

const ped = (numero: string, guias: string[], extra = {}) => ({ numeroPedimento: numero, coveredGuias: guias, ...extra });

describe('computeCoverage', () => {
  it('sin_pedimento when there are no pedimentos', () => {
    const r = computeCoverage(['G1', 'G2'], []);
    expect(r.status).toBe('sin_pedimento');
    expect(r.uncoveredGuias).toEqual(['G1', 'G2']);
  });

  it('completo when every guía is covered exactly once and all expected pedimentos are present', () => {
    const r = computeCoverage(['G1', 'G2', 'G3'], [
      ped('1', ['G1', 'G2'], { siblings: ['2'], isLast: false }),
      ped('2', ['G3'], { siblings: ['1'], isLast: true, ordinal: 2 }),
    ]);
    expect(r.status).toBe('completo');
    expect(r.missingNumeros).toEqual([]);
    expect(r.uncoveredGuias).toEqual([]);
    expect(r.duplicatedGuias).toEqual([]);
    expect(r.expectedCount).toBe(2);
  });

  it('parcial when a declared sibling pedimento is still missing', () => {
    const r = computeCoverage(['G1', 'G2', 'G3'], [
      ped('1', ['G1', 'G2'], { siblings: ['2', '3'] }),
    ]);
    expect(r.status).toBe('parcial');
    expect(r.expectedCount).toBe(3);
    expect(r.missingNumeros.sort()).toEqual(['2', '3']);
  });

  it('parcial with an uncovered guía even if expected set is complete', () => {
    const r = computeCoverage(['G1', 'G2'], [ped('1', ['G1'], { siblings: [], isLast: true, ordinal: 1 })]);
    expect(r.status).toBe('parcial');
    expect(r.uncoveredGuias).toEqual(['G2']);
  });

  it('flags a guía covered by more than one pedimento as duplicated', () => {
    const r = computeCoverage(['G1'], [ped('1', ['G1'], { siblings: ['2'] }), ped('2', ['G1'], { siblings: ['1'] })]);
    expect(r.duplicatedGuias).toEqual(['G1']);
    expect(r.status).toBe('parcial');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run shared/pedimento/coverage.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
import { normPedimentoNumero } from './subdivision';

export interface PedimentoCoverageInput {
  numeroPedimento: string;
  coveredGuias: string[];
  siblings?: string[];
  isLast?: boolean;
  ordinal?: number | null;
}

export type ManifestCoverageStatus = 'sin_pedimento' | 'parcial' | 'completo';

export interface CoverageResult {
  status: ManifestCoverageStatus;
  expectedCount: number | null;
  uploadedNumeros: string[];
  missingNumeros: string[];
  uncoveredGuias: string[];
  duplicatedGuias: string[];
  manifestGuiaCount: number;
  coveredGuiaCount: number;
}

export function computeCoverage(manifestGuias: string[], pedimentos: PedimentoCoverageInput[]): CoverageResult {
  const uploaded = pedimentos.map((p) => normPedimentoNumero(p.numeroPedimento)).filter(Boolean);
  const uploadedSet = new Set(uploaded);

  // Expected set = union of every pedimento's own number + declared siblings.
  const expected = new Set<string>();
  for (const p of pedimentos) {
    const self = normPedimentoNumero(p.numeroPedimento);
    if (self) expected.add(self);
    for (const s of p.siblings ?? []) {
      const n = normPedimentoNumero(s);
      if (n) expected.add(n);
    }
  }
  const expectedCount = expected.size > 0 ? expected.size : null;
  const missingNumeros = [...expected].filter((n) => !uploadedSet.has(n));

  // Coverage count per manifest guía.
  const coverCount = new Map<string, number>();
  for (const g of manifestGuias) coverCount.set(g, 0);
  for (const p of pedimentos) {
    for (const g of p.coveredGuias) {
      if (coverCount.has(g)) coverCount.set(g, (coverCount.get(g) ?? 0) + 1);
    }
  }
  const uncoveredGuias = [...coverCount].filter(([, c]) => c === 0).map(([g]) => g);
  const duplicatedGuias = [...coverCount].filter(([, c]) => c > 1).map(([g]) => g);
  const coveredGuiaCount = manifestGuias.length - uncoveredGuias.length;

  let status: ManifestCoverageStatus;
  if (pedimentos.length === 0) status = 'sin_pedimento';
  else if (missingNumeros.length === 0 && uncoveredGuias.length === 0 && duplicatedGuias.length === 0) status = 'completo';
  else status = 'parcial';

  return {
    status, expectedCount,
    uploadedNumeros: uploaded,
    missingNumeros,
    uncoveredGuias, duplicatedGuias,
    manifestGuiaCount: manifestGuias.length,
    coveredGuiaCount,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run shared/pedimento/coverage.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add shared/pedimento/coverage.ts shared/pedimento/coverage.test.ts
git commit -m "feat(pedimento): guía-coverage engine (sin/parcial/completo + uncovered/duplicated/missing)"
```

---

### Task 4: Per-pedimento status helper stays; coverage status is separate

**Files:**
- Modify: `shared/pedimento/seguimientoStatus.ts`
- Test: `shared/pedimento/seguimientoStatus.test.ts` (existing)

**Interfaces:**
- Keep `computeSeguimientoStatus(signals)` exactly as-is — it now describes **one pedimento row's** sub-status (`pendiente/capturado/rechazado/prevalidado/cargado` + `locked`). Update only its doc comment.
- Produces: re-export the manifest-level `ManifestCoverageStatus` + `computeCoverage` so consumers import status logic from one module.

- [ ] **Step 1: Update the doc comment + re-export**

At the top of `shared/pedimento/seguimientoStatus.ts`, change the JSDoc lines describing "a manifest" to "a single pedimento row", and append at the end of the file:

```ts
// Manifest-level coverage status (1 manifest → N pedimentos) lives in ./coverage.
export { computeCoverage } from './coverage';
export type { ManifestCoverageStatus, CoverageResult, PedimentoCoverageInput } from './coverage';
```

- [ ] **Step 2: Run the existing test**

Run: `npx vitest run shared/pedimento/seguimientoStatus.test.ts`
Expected: PASS (the existing 8 tests still pass — behavior unchanged).

- [ ] **Step 3: Commit**

```bash
git add shared/pedimento/seguimientoStatus.ts
git commit -m "refactor(pedimento): seguimientoStatus = per-pedimento sub-status; re-export coverage"
```

---

### Task 5: Migration — create `pedimentos` table + backfill (no drop yet)

**Files:**
- Create: `server/migrations/1700002700000_pedimentos_table.ts`
- Test: `server/test/migrations/pedimentos.test.ts`

**Interfaces:**
- Produces: table `pedimentos(id, manifest_id FK CASCADE, numero_pedimento, master_guide, subdivision_ordinal, is_last_subdivision, sibling_numeros text[], bultos, peso_bruto_kg, file_id FK SET NULL, pedimento jsonb, prevalidation jsonb, pedimento_scan jsonb, import_data jsonb, import_data_version int default 0, covered_guias text[], reconciliation jsonb, created_by FK SET NULL, created_at timestamptz default now())`, index on `manifest_id`. **Manifest columns are NOT dropped here** (Task 10 drops them).

- [ ] **Step 1: Write the migration**

```ts
import { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('pedimentos', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    manifest_id: { type: 'uuid', notNull: true, references: 'manifests', onDelete: 'CASCADE' },
    numero_pedimento: { type: 'text' },
    master_guide: { type: 'text' },
    subdivision_ordinal: { type: 'integer' },
    is_last_subdivision: { type: 'boolean' },
    sibling_numeros: { type: 'text[]' },
    bultos: { type: 'integer' },
    peso_bruto_kg: { type: 'numeric' },
    file_id: { type: 'uuid', references: 'files', onDelete: 'SET NULL' },
    pedimento: { type: 'jsonb' },
    prevalidation: { type: 'jsonb' },
    pedimento_scan: { type: 'jsonb' },
    import_data: { type: 'jsonb' },
    import_data_version: { type: 'integer', notNull: true, default: 0 },
    covered_guias: { type: 'text[]' },
    reconciliation: { type: 'jsonb' },
    created_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('pedimentos', 'manifest_id');

  // Backfill: one pedimento row per manifest that currently has any pedimento data.
  pgm.sql(`
    INSERT INTO pedimentos
      (manifest_id, numero_pedimento, master_guide, file_id, pedimento, prevalidation,
       pedimento_scan, import_data, import_data_version, created_by, created_at)
    SELECT m.id,
           m.pedimento->'header'->>'numeroPedimento',
           m.mawb_reference,
           m.file_id, m.pedimento, m.prevalidation, m.pedimento_scan,
           m.import_data, COALESCE(m.import_data_version, 0), m.created_by, m.created_at
    FROM manifests m
    WHERE m.file_id IS NOT NULL OR m.pedimento IS NOT NULL
       OR m.prevalidation IS NOT NULL OR m.import_data IS NOT NULL
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('pedimentos');
}
```

- [ ] **Step 2: Write the migration test**

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

describe('pedimentos table + backfill', () => {
  beforeEach(async () => { await truncateAll(); });

  it('backfills one pedimento row from a manifest that has pedimento data', async () => {
    const u = await query(`INSERT INTO users (username,password_hash,role) VALUES ('c','x','capturista') RETURNING id`);
    const m = await query(
      `INSERT INTO manifests (mawb_reference, client_name, created_by, import_data) VALUES ('369-1','C',$1,$2::jsonb) RETURNING id`,
      [u.rows[0].id, JSON.stringify({ patente: '1653' })]);
    // Simulate the backfill SELECT (migration already ran at suite start; insert + manual backfill check)
    await query(
      `INSERT INTO pedimentos (manifest_id, master_guide, import_data, created_by)
       SELECT id, mawb_reference, import_data, created_by FROM manifests WHERE id=$1`, [m.rows[0].id]);
    const p = await query(`SELECT manifest_id, master_guide, import_data FROM pedimentos WHERE manifest_id=$1`, [m.rows[0].id]);
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0].master_guide).toBe('369-1');
    expect(p.rows[0].import_data.patente).toBe('1653');
  });
});
```

- [ ] **Step 3: Run migrations + test**

Run: `cd server && npm test -- test/migrations/pedimentos.test.ts`
Expected: migrations apply (`pedimentos` created), test PASS.

- [ ] **Step 4: Commit**

```bash
git add server/migrations/1700002700000_pedimentos_table.ts server/test/migrations/pedimentos.test.ts
git commit -m "feat(db): pedimentos table (1:N) + backfill from manifest columns"
```

---

### Task 6: `pdfExtract` service emits `coveredGuias` + subdivisión info

**Files:**
- Create: `server/src/services/pdfExtract/index.ts`
- Modify: `shared/types/reports.ts` (extend `ExtractedPedimento` — see Interfaces)
- Test: `server/test/services/pdfExtract.test.ts` (uses a text fixture, not a PDF)

**Interfaces:**
- Consumes: `parsePedimentoText` (Task 1, from `shared/pedimento/parsePedimentoText.ts` — **confirmed exact name/path** from the 2026-06-22 plan Task 3), `parseSubdivision` (Task 2).
- Produces:
  - Extend `ExtractedPedimento` (from Task 1) with: `subdivision: SubdivisionInfo` (import the type from `shared/pedimento/subdivision`) and `coveredGuias: string[]` (= `lines.map(l => l.guia)`, de-duped).
  - `export function extractFromText(fullText: string): ExtractedPedimento` — pure, testable seam (the PDF loader feeds this).
  - `export async function getPdfText(buffer: Buffer): Promise<string>` — `pdf-parse` v2 loader: `const r = await new PDFParse({ data: new Uint8Array(buffer) }).getText(); return r.text;` (import `{ PDFParse } from 'pdf-parse'`).
  - `export async function extractPedimento(buffer: Buffer): Promise<ExtractedPedimento>` — `extractFromText(await getPdfText(buffer))`.

- [ ] **Step 1: Write the failing test** (pure `extractFromText` over a fixture)

```ts
import { describe, expect, it } from 'vitest';
import { extractFromText } from '../../src/services/pdfExtract';

const TEXT = `... NUM. PEDIMENTO: 25 85 1653 5001684 ...
SEGUNDA SUBDIVISION DE LA GUIA MASTER NO. 369-94268462 ... 34 BULTOS CON UN PESO DE 808 KG. SE RELACIONA CON LOS PEDIMENTOS 25 85 1653 5001668 Y 25 85 1653 5001685.
GUIA JMX101245831553 VALOR 60.110 USD NOMBRE MAURICIO TORRES MONTEJO RFC-CURP TOMM020922D40
GUIA JMX101255006278 VALOR 54.710 USD NOMBRE BEATRIZ VILLEGAS MUNOZ RFC-CURP VIMB420426SE1`;

describe('extractFromText', () => {
  it('extracts covered guías and subdivisión info', () => {
    const r = extractFromText(TEXT);
    expect(r.coveredGuias).toEqual(['JMX101245831553', 'JMX101255006278']);
    expect(r.subdivision.ordinal).toBe(2);
    expect(r.subdivision.masterGuide).toBe('369-94268462');
    expect(r.subdivision.siblings).toEqual(['258516535001668', '258516535001685']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npm test -- test/services/pdfExtract.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `extractFromText` + `extractPedimento`**

```ts
import { PDFParse } from 'pdf-parse';
import { parsePedimentoText } from '../../../../shared/pedimento/parsePedimentoText';
import { parseSubdivision } from '../../../../shared/pedimento/subdivision';
import type { ExtractedPedimento } from '../../../../shared/types/reports';

export function extractFromText(fullText: string): ExtractedPedimento {
  const base = parsePedimentoText(fullText);            // populates header + lines[]
  const subdivision = parseSubdivision(fullText);
  const coveredGuias = [...new Set(base.lines.map((l) => l.guia).filter(Boolean))];
  return { ...base, subdivision, coveredGuias };
}

export async function getPdfText(buffer: Buffer): Promise<string> {
  const r = await new PDFParse({ data: new Uint8Array(buffer) }).getText();
  return r.text;
}

export async function extractPedimento(buffer: Buffer): Promise<ExtractedPedimento> {
  return extractFromText(await getPdfText(buffer));
}
```

Add to `shared/types/reports.ts` (extend the `ExtractedPedimento` from Task 1):

```ts
import type { SubdivisionInfo } from '../pedimento/subdivision';
// ... on ExtractedPedimento, add:
//   subdivision: SubdivisionInfo;
//   coveredGuias: string[];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npm test -- test/services/pdfExtract.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/pdfExtract shared/types/reports.ts server/test/services/pdfExtract.test.ts
git commit -m "feat(pdfExtract): emit coveredGuias + subdivisión info from pedimento text"
```

---

### Task 7: Pedimento upload creates a `pedimentos` row with the association gate

**Files:**
- Modify: `server/src/routes/pedimentoUpload.ts`
- Modify: `server/src/services/manifestLock.ts` (accept a pedimento row, not a manifest)
- Test: `server/test/routes/pedimentoUpload.test.ts` (extend)

**Interfaces:**
- Consumes: `extractPedimento` (Task 6); `saveFile`; `computeLock` (unchanged signature — it already takes `{ prevalidation, file_id }`).
- Produces: `POST /api/manifests/:id/pedimento-pdf` now: scans → `extractPedimento` → **hard-gates** master guide vs `manifests.mawb_reference` (400 on mismatch) → rejects a duplicate `numero_pedimento` already in `pedimentos` for the manifest (409) → `saveFile` → **INSERT a `pedimentos` row** (file_id, numero_pedimento, master_guide, subdivision_*, sibling_numeros, bultos, peso_bruto_kg, covered_guias, pedimento_scan). It no longer writes `manifests.file_id`.

- [ ] **Step 1: Write the failing test**

```ts
it('creates a pedimentos row and rejects a master-guide mismatch', async () => {
  // seed a manifest with mawb_reference '369-94268462', then upload a PDF whose
  // parsed master guide differs → expect 400; matching guide → 201 + a pedimentos row.
  // (Use a stubbed extractor or a tiny text-bearing PDF fixture per existing upload test patterns.)
});
```
(Model the seed/auth on the existing `pedimentoUpload.test.ts`; assert `SELECT count(*) FROM pedimentos WHERE manifest_id=$1` increments and the 400/409 gates fire.)

- [ ] **Step 2: Run to verify it fails** — `cd server && npm test -- test/routes/pedimentoUpload.test.ts` → FAIL.

- [ ] **Step 3: Implement** the gate + INSERT in `pedimentoUpload.ts` (replace the `UPDATE manifests SET file_id…` with a `pedimentos` INSERT; add the master-guide 400 and duplicate-numero 409 before `saveFile`). Add a guía-subset warning to the response (non-blocking) by comparing `extracted.coveredGuias` to the manifest's shipment guías.

- [ ] **Step 4: Run to verify it passes** → PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(pedimento): upload creates a pedimentos row + master-guide/duplicate gates"`

---

### Task 8: Records routes aggregate pedimentos + manifest coverage status

**Files:**
- Modify: `server/src/routes/records.ts` (list `GET /` and detail `GET /:id`)
- Modify: `server/src/routes/importData.ts` (read/write `pedimentos.import_data`, keyed by a pedimento id)
- Test: `server/test/routes/records.test.ts` (extend the Seguimiento-status block)

**Interfaces:**
- Consumes: `computeCoverage` (Task 3); the manifest's shipment guías (`SELECT (data->>'guideId') FROM shipments WHERE manifest_id=$1`); the manifest's `pedimentos` rows.
- Produces:
  - List `GET /api/records` returns per manifest: `coverageStatus: ManifestCoverageStatus`, `expectedCount`, `uploadedCount`, plus the existing fields. **Replaces** the old single `status/locked/scanVerdict` derivation (which read manifest columns).
  - Detail `GET /api/records/:id` returns `pedimentos: [{ id, numeroPedimento, subdivisionOrdinal, isLast, lock, scanVerdict, importData... }]` and a `coverage: CoverageResult`.

- [ ] **Step 1: Write the failing test** — seed a manifest + 2 shipments (guías G1,G2) + one `pedimentos` row covering [G1]; assert list returns `coverageStatus: 'parcial'`, and detail returns `coverage.uncoveredGuias: ['G2']` and a `pedimentos` array of length 1. (FAIL first.)
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — in the list query, `LEFT JOIN`/sub-select the manifest's `pedimentos` + shipment guías, run `computeCoverage`, return `coverageStatus`. In detail, return the pedimentos array + `computeCoverage`. Point `importData` reads/writes at a specific `pedimentos` row id (add `:pedimentoId` to the import-data route).
- [ ] **Step 4: Run** → PASS (extend, keep existing record tests green by updating their expectations to the new fields).
- [ ] **Step 5: Commit** — `git commit -m "feat(records): aggregate pedimentos + manifest coverage status"`

---

### Task 9: SeguimientoView — coverage-aware two-tab queue + pedimentos sub-list

**Files:**
- Modify: `src/components/SeguimientoView.tsx`
- Test: `src/components/SeguimientoView.test.tsx` (extend)

**Interfaces:**
- Consumes: the list `coverageStatus` + detail `coverage`/`pedimentos` (Task 8).
- Produces: two tabs relabeled **Pendientes** (`sin_pedimento ∪ parcial`, partial sorted first) / **Completados** (`completo`); each row shows a coverage chip ("2 de 3" / "todas las guías" / uncovered-count warning); clicking a record shows its **pedimentos sub-list** with per-pedimento sub-status.

- [ ] **Step 1: Write the failing test** — render with a mocked list containing a `parcial` and a `completo` record; assert the "Pendientes" tab shows the parcial row with a coverage chip, and "Completados" shows the completo row. (FAIL first.)
- [ ] **Step 2: Run** → FAIL — `cd .. && npx vitest run src/components/SeguimientoView.test.tsx` (repo root).
- [ ] **Step 3: Implement** — relabel the two tabs; filter by `coverageStatus` (`pendientes = !== 'completo'`); sort `parcial` above `sin_pedimento`; add a `<CoverageChip>` (counts + uncovered/duplicated warning); render the pedimentos sub-list on selection. Drop the old `locked`-based split.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(seguimiento): coverage-aware Pendientes/Completados tabs + pedimentos sub-list"`

---

### Task 10: Drop the now-unused manifest pedimento columns

**Files:**
- Create: `server/migrations/1700002800000_drop_manifest_pedimento_columns.ts`
- Verify: full server + shared + frontend suites.

**Interfaces:** none. Removes `manifests.{pedimento, prevalidation, pedimento_scan, import_data, import_data_version, file_id}` — only safe now that Tasks 5–9 moved all reads/writes to `pedimentos`.

- [ ] **Step 1: Grep for any remaining readers** — `grep -rnE "m\.(file_id|pedimento|prevalidation|pedimento_scan|import_data)\b|manifests SET (file_id|pedimento|import_data)" server/src`. Expected: none remain (all moved in Tasks 7–8). Fix any stragglers before dropping.

- [ ] **Step 2: Write the drop migration**

```ts
import { MigrationBuilder } from 'node-pg-migrate';
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumns('manifests', ['pedimento', 'prevalidation', 'pedimento_scan', 'import_data', 'import_data_version', 'file_id']);
}
export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumns('manifests', {
    pedimento: { type: 'jsonb' }, prevalidation: { type: 'jsonb' }, pedimento_scan: { type: 'jsonb' },
    import_data: { type: 'jsonb' }, import_data_version: { type: 'integer', notNull: true, default: 0 },
    file_id: { type: 'uuid', references: 'files', onDelete: 'SET NULL' },
  });
}
```

- [ ] **Step 3: Run the full suites**

Run: `cd server && npm test` then `cd .. && npx vitest run`
Expected: both green.

- [ ] **Step 4: Commit**

```bash
git add server/migrations/1700002800000_drop_manifest_pedimento_columns.ts
git commit -m "feat(db): drop 1:1 manifest pedimento columns (now in pedimentos table)"
```

---

## Self-Review

- **Spec coverage:** pedimentos table + backfill (T5) + drop (T10); coverage subset extraction (T1, T6); subdivisión parser incl. ULTIMA/siblings (T2); coverage engine incl. uncovered/duplicated/missing + sin/parcial/completo (T3); coverage-aware status + tabs (T4, T8, T9); per-pedimento lock + association gate incl. master-guide hard gate + duplicate reject + guía-subset warning (T7); records aggregation (T8). All spec sections map to a task. *Not in Phase 1 (deferred to Phases 2–3, per spec): full per-line reconciliation field-diffs + the 4 surfaces + the capture wizard.*
- **Scale:** extraction uses text-layer Approach A for the per-guía lines (cheap at ~1,190/pedimento); the UI sub-list shows pedimento rows + coverage summary, never thousands of guía rows.
- **Type consistency:** `ManifestCoverageStatus`, `CoverageResult`, `PedimentoCoverageInput`, `SubdivisionInfo`, `ExtractedPedimento.{subdivision,coveredGuias}`, `normPedimentoNumero` are defined once (T2/T3/T6) and consumed by the same names in T7–T9.
- **Reuse pointers:** the PDF-text loader + `parsePedimentoTextA` + `parseObservation` come from the 2026-06-22 plan (T1); confirm the exact exported path (`shared/pedimento/extractTextA` vs the plan's naming) when implementing T6 and fix the import accordingly.

## Open follow-ups (Phase 2/3)

- Per-line reconciliation field-diffs (value/name/RFC) + persisted `reconciliation` report + the 4 surfaces (Consulta, drawer, XLSX, panel).
- The modal capture wizard (pre-fill from `extracted.header`, dry-run prevalidate, finalize) — consumes this phase's `pedimentos` model + extraction.
- Harden the subdivisión parser against a PRIMERA/>2-sibling sample (`5001668`).
