# Pedimento Reconciliation Engine (Phase 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the advisory Manifest↔Pedimento reconciliation: compare the manifest's shipments
(the "expected" side, aggregated per guía) against the PDF-extracted partida lines (the "actual"
side), fold in the entity cross-check, persist the report per pedimento, and surface it on the
records detail. Advisory only — never blocks the lifecycle.

**Architecture:** Two pure functions in `shared/pedimento/reconcile.ts` — `buildExpectedFromManifest`
(group shipments by guía, sum value, one consignee/RFC per guía, flag intra-guía divergence) and
`reconcile` (match by guía → matched/mismatch/missing/extra with value/name/RFC diffs). A migration
adds `pedimentos.pedimento_reconciliation` (JSONB). The upload endpoint orchestrates: build expected
from the covered-guía subset, reconcile against the extracted lines, append the Phase-2
`crossCheckEntities` results, and persist. The records detail surfaces the stored report.

**Tech Stack:** TypeScript, Vitest (root for `shared/`, server for routes/migrations), Express,
Postgres (node-pg-migrate).

Spec: `docs/superpowers/specs/2026-06-24-pedimento-extraction-reconciliation-wizard-design.md`

## Global Constraints

- Both suites green at **every** commit: root `npx vitest run` AND `cd server && npm test`.
  `npm run lint` (root) + `cd server && npx tsc --noEmit` clean.
- `git add <explicit paths>` ONLY — never `git add -A`.
- Migration timestamps continue after `1700003000000` → next free is **`1700003100000`**.
- Reuse the EXISTING types in `shared/types/reports.ts` verbatim — do NOT redefine them:
  `ExpectedPedimento` (`{ header: Partial<ExtractedPedimentoHeader>; lines: { guia; valueUsd; consigneeName; id }[] }`),
  `FieldDiff` (`{ field; expected; actual; ok }`), `LineResult` (`{ guia; status: 'matched'|'mismatch'|'missing_in_pedimento'|'extra_in_pedimento'; diffs: FieldDiff[] }`),
  `ReconciliationReport` (`{ generatedAt; extractionMethod; usedPositional; confidence; header: FieldDiff[]; totals: FieldDiff[]; lines: LineResult[]; summary: { matched; mismatched; missingInPedimento; extraInPedimento; color: RiskResultado }; notes: string[] }`),
  `ExtractedPedimento`/`ExtractedPedimentoLine`.
- Reconciliation is **advisory** — it never changes `sub_status`, never blocks upload/finalize, and
  engine errors degrade to "no report" (stored `null`), never a 500.
- The "expected" line `id` = `consignee.curp ?? consignee.rfc ?? ''` (matches `buildPedimento`).
- Money comparison tolerance: values match when `|expected - actual| < 0.01`.
- Pure functions take no clock/IO; `generatedAt` is passed in by the caller (server stamps
  `new Date().toISOString()`), so tests are deterministic.
- Test DB = `customs_test` (mock; reset freely).

---

### Task 1: `buildExpectedFromManifest` (pure)

**Files:**
- Create: `shared/pedimento/reconcile.ts`
- Test: `shared/pedimento/reconcile.test.ts`

**Interfaces:**
- Consumes: shipment data (`{ guideId: string; customsValueUsd: number; consignee: { name: string; rfc?: string | null; curp?: string | null } }`); `ExpectedPedimento`.
- Produces: `buildExpectedFromManifest(shipments): { expected: ExpectedPedimento; warnings: string[] }`
  — one expected line per guía: `valueUsd` = sum of the guía's rows (rounded to cents), `consigneeName`/`id`
  from the first row; `warnings` flags guías whose rows carry differing consignee names or RFC/CURP.

- [ ] **Step 1: Write the failing test**

```ts
// shared/pedimento/reconcile.test.ts
import { describe, it, expect } from 'vitest';
import { buildExpectedFromManifest } from './reconcile';

const ship = (guideId: string, customsValueUsd: number, name: string, rfc: string) =>
  ({ guideId, customsValueUsd, consignee: { name, rfc, curp: null } });

describe('buildExpectedFromManifest', () => {
  it('aggregates multiple product rows of one guía into a single summed line', () => {
    const { expected } = buildExpectedFromManifest([
      ship('G1', 6.00, 'JUAN PEREZ', 'PEXJ800101AA1'),
      ship('G1', 6.50, 'JUAN PEREZ', 'PEXJ800101AA1'),
      ship('G2', 12.00, 'ANA LOPEZ', 'LOAA900202BB2'),
    ]);
    expect(expected.lines).toHaveLength(2);
    expect(expected.lines.find((l) => l.guia === 'G1')).toMatchObject({ valueUsd: 12.5, consigneeName: 'JUAN PEREZ', id: 'PEXJ800101AA1' });
    expect(expected.lines.find((l) => l.guia === 'G2')!.valueUsd).toBe(12);
  });
  it('warns when one guía spans differing consignees', () => {
    const { warnings } = buildExpectedFromManifest([
      ship('G1', 6.00, 'JUAN PEREZ', 'PEXJ800101AA1'),
      ship('G1', 6.00, 'OTRO NOMBRE', 'PEXJ800101AA1'),
    ]);
    expect(warnings.some((w) => w.includes('G1'))).toBe(true);
  });
  it('uses curp over rfc for the id when present', () => {
    const { expected } = buildExpectedFromManifest([
      { guideId: 'G3', customsValueUsd: 5, consignee: { name: 'X', rfc: 'RFC010101AAA', curp: 'CURP010101HDFAAA09' } },
    ]);
    expect(expected.lines[0].id).toBe('CURP010101HDFAAA09');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run shared/pedimento/reconcile.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// shared/pedimento/reconcile.ts
import type { ExpectedPedimento } from '../types/reports';

export interface ExpectedShipment {
  guideId: string;
  customsValueUsd: number;
  consignee: { name: string; rfc?: string | null; curp?: string | null };
}

export function buildExpectedFromManifest(shipments: ExpectedShipment[]): { expected: ExpectedPedimento; warnings: string[] } {
  const byGuia = new Map<string, { valueUsd: number; consigneeName: string; id: string; names: Set<string>; ids: Set<string> }>();
  for (const s of shipments) {
    const id = (s.consignee.curp ?? s.consignee.rfc ?? '') as string;
    const existing = byGuia.get(s.guideId);
    if (!existing) {
      byGuia.set(s.guideId, { valueUsd: s.customsValueUsd, consigneeName: s.consignee.name, id, names: new Set([s.consignee.name]), ids: new Set([id]) });
    } else {
      existing.valueUsd += s.customsValueUsd;
      existing.names.add(s.consignee.name);
      existing.ids.add(id);
    }
  }
  const warnings: string[] = [];
  const lines = [...byGuia.entries()].map(([guia, e]) => {
    if (e.names.size > 1) warnings.push(`Guía ${guia}: múltiples destinatarios en el manifiesto (${[...e.names].join(', ')})`);
    if (e.ids.size > 1) warnings.push(`Guía ${guia}: múltiples RFC/CURP en el manifiesto`);
    return { guia, valueUsd: Math.round(e.valueUsd * 100) / 100, consigneeName: e.consigneeName, id: e.id };
  });
  return { expected: { header: {}, lines }, warnings };
}
```

- [ ] **Step 4: Run to verify it passes** — `npx vitest run shared/pedimento/reconcile.test.ts` → PASS. Then root suite green.

- [ ] **Step 5: Commit**

```bash
git add shared/pedimento/reconcile.ts shared/pedimento/reconcile.test.ts
git commit -m "feat(reconcile): buildExpectedFromManifest aggregates by guía (Task 1)"
```

---

### Task 2: `reconcile` (pure)

**Files:**
- Modify: `shared/pedimento/reconcile.ts`
- Test: `shared/pedimento/reconcile.test.ts`

**Interfaces:**
- Consumes: `ExpectedPedimento` (Task 1), `ExtractedPedimento`, `ReconciliationReport`, `LineResult`, `FieldDiff`.
- Produces: `reconcile(expected, extracted, opts?: { notes?: string[]; generatedAt?: string }): ReconciliationReport`
  — match by guía; each expected guía → `matched` (all diffs ok) / `mismatch` / `missing_in_pedimento`;
  each extracted guía not expected → `extra_in_pedimento`. Per-line diffs on `valorUsd` (tolerance
  0.01), `nombre` (case-insensitive), `rfcCurp` (case-insensitive). `totals` carries a `totalValorUsd`
  diff. `summary.color`: `gris` if no extracted lines, `verde` if all matched, else `amarillo`.

- [ ] **Step 1: Write the failing test**

```ts
// add to shared/pedimento/reconcile.test.ts
import { reconcile } from './reconcile';
import type { ExtractedPedimento } from '../types/reports';

const extracted = (lines: { guia: string; valueUsd: number | null; consigneeName: string | null; id: string | null }[]): ExtractedPedimento => ({
  header: { numeroPedimento: null, clave: null, importerRfc: null, agentRfc: null, agencyRfc: null, patente: null, customsClearanceCode: null, tipoCambio: null, entryDate: null, paymentDate: null, totalBultos: null },
  lines, extractionMethod: 'deterministic', usedPositional: false, confidence: 0.9, warnings: [], subdivision: { masterGuide: null, ordinal: null, isLast: false, siblings: [], bultos: null, pesoBrutoKg: null }, coveredGuias: [],
});

describe('reconcile', () => {
  const expected = { header: {}, lines: [
    { guia: 'G1', valueUsd: 12.5, consigneeName: 'JUAN PEREZ', id: 'PEXJ800101AA1' },
    { guia: 'G2', valueUsd: 12,   consigneeName: 'ANA LOPEZ',  id: 'LOAA900202BB2' },
  ] };

  it('matches identical lines (case-insensitive, value within tolerance)', () => {
    const r = reconcile(expected, extracted([
      { guia: 'G1', valueUsd: 12.5, consigneeName: 'juan perez', id: 'pexj800101aa1' },
      { guia: 'G2', valueUsd: 12.0, consigneeName: 'ANA LOPEZ', id: 'LOAA900202BB2' },
    ]), { generatedAt: '2026-06-24T00:00:00Z' });
    expect(r.summary).toMatchObject({ matched: 2, mismatched: 0, missingInPedimento: 0, extraInPedimento: 0, color: 'verde' });
  });
  it('flags a value mismatch', () => {
    const r = reconcile(expected, extracted([
      { guia: 'G1', valueUsd: 99, consigneeName: 'JUAN PEREZ', id: 'PEXJ800101AA1' },
      { guia: 'G2', valueUsd: 12, consigneeName: 'ANA LOPEZ', id: 'LOAA900202BB2' },
    ]));
    expect(r.summary.mismatched).toBe(1);
    expect(r.summary.color).toBe('amarillo');
    const g1 = r.lines.find((l) => l.guia === 'G1')!;
    expect(g1.status).toBe('mismatch');
    expect(g1.diffs.find((d) => d.field === 'valorUsd')!.ok).toBe(false);
  });
  it('flags missing (in manifest, not in pedimento) and extra (in pedimento, not in manifest)', () => {
    const r = reconcile(expected, extracted([
      { guia: 'G1', valueUsd: 12.5, consigneeName: 'JUAN PEREZ', id: 'PEXJ800101AA1' },
      { guia: 'G9', valueUsd: 5, consigneeName: 'EXTRA', id: 'X' },
    ]));
    expect(r.summary.missingInPedimento).toBe(1); // G2
    expect(r.summary.extraInPedimento).toBe(1);   // G9
  });
  it('gris when the pedimento has no extracted lines', () => {
    const r = reconcile(expected, extracted([]));
    expect(r.summary.color).toBe('gris');
  });
  it('carries notes through', () => {
    const r = reconcile(expected, extracted([]), { notes: ['nota X'] });
    expect(r.notes).toContain('nota X');
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run shared/pedimento/reconcile.test.ts` → FAIL (`reconcile` undefined).

- [ ] **Step 3: Implement** (append to `shared/pedimento/reconcile.ts`)

```ts
import type { ExtractedPedimento, ReconciliationReport, LineResult, FieldDiff } from '../types/reports';

const norm = (s: string | null | undefined) => (s ?? '').trim().toUpperCase();

function numDiff(field: string, expected: number | null, actual: number | null): FieldDiff {
  const ok = expected != null && actual != null && Math.abs(expected - actual) < 0.01;
  return { field, expected, actual, ok };
}
function strDiff(field: string, expected: string | null, actual: string | null): FieldDiff {
  return { field, expected, actual, ok: norm(expected) === norm(actual) };
}

export function reconcile(
  expected: ExpectedPedimento,
  extracted: ExtractedPedimento,
  opts: { notes?: string[]; generatedAt?: string } = {},
): ReconciliationReport {
  const actualByGuia = new Map(extracted.lines.map((l) => [l.guia, l]));
  const expectedGuias = new Set(expected.lines.map((l) => l.guia));
  const lines: LineResult[] = [];

  for (const exp of expected.lines) {
    const act = actualByGuia.get(exp.guia);
    if (!act) { lines.push({ guia: exp.guia, status: 'missing_in_pedimento', diffs: [] }); continue; }
    const diffs: FieldDiff[] = [
      numDiff('valorUsd', exp.valueUsd, act.valueUsd),
      strDiff('nombre', exp.consigneeName, act.consigneeName),
      strDiff('rfcCurp', exp.id, act.id),
    ];
    lines.push({ guia: exp.guia, status: diffs.every((d) => d.ok) ? 'matched' : 'mismatch', diffs });
  }
  for (const act of extracted.lines) {
    if (!expectedGuias.has(act.guia)) lines.push({ guia: act.guia, status: 'extra_in_pedimento', diffs: [] });
  }

  const summary = {
    matched: lines.filter((l) => l.status === 'matched').length,
    mismatched: lines.filter((l) => l.status === 'mismatch').length,
    missingInPedimento: lines.filter((l) => l.status === 'missing_in_pedimento').length,
    extraInPedimento: lines.filter((l) => l.status === 'extra_in_pedimento').length,
    color: 'verde' as ReconciliationReport['summary']['color'],
  };
  if (extracted.lines.length === 0) summary.color = 'gris';
  else if (summary.mismatched || summary.missingInPedimento || summary.extraInPedimento) summary.color = 'amarillo';

  const expTotal = Math.round(expected.lines.reduce((a, l) => a + l.valueUsd, 0) * 100) / 100;
  const actTotal = Math.round(extracted.lines.reduce((a, l) => a + (l.valueUsd ?? 0), 0) * 100) / 100;

  return {
    generatedAt: opts.generatedAt ?? '',
    extractionMethod: extracted.extractionMethod,
    usedPositional: extracted.usedPositional,
    confidence: extracted.confidence,
    header: [],
    totals: [numDiff('totalValorUsd', expTotal, actTotal)],
    lines,
    summary,
    notes: opts.notes ?? [],
  };
}
```

- [ ] **Step 4: Run to verify it passes** — focused test PASS, then root `npx vitest run` + `cd server && npm test` (no new server import yet) + tsc.

- [ ] **Step 5: Commit**

```bash
git add shared/pedimento/reconcile.ts shared/pedimento/reconcile.test.ts
git commit -m "feat(reconcile): per-guía reconcile with diffs + summary (Task 2)"
```

---

### Task 3: `pedimento_reconciliation` column + records surfacing

**Files:**
- Create: `server/migrations/1700003100000_pedimento_reconciliation.ts`
- Modify: `server/src/routes/records.ts` (`PEDIMENTO_COLS` + the detail `pedimentos[]` mapping)
- Test: `server/test/routes/records.test.ts` (extend)

**Interfaces:**
- Produces: `pedimentos.pedimento_reconciliation` (JSONB, nullable); records detail
  `pedimentos[].reconciliation` = the stored `ReconciliationReport | null`.

- [ ] **Step 1: Write the failing test**

In `server/test/routes/records.test.ts`, extend the detail test: seed a pedimento with a
`pedimento_reconciliation` JSONB value and assert it surfaces as `reconciliation` on the detail row.

```ts
it('surfaces pedimento_reconciliation on the detail row', async () => {
  // seed a manifest + pedimento with a reconciliation report (use the file's existing seed helpers)
  const report = { summary: { color: 'verde', matched: 1, mismatched: 0, missingInPedimento: 0, extraInPedimento: 0 }, lines: [], header: [], totals: [], notes: [], generatedAt: 'x', extractionMethod: 'deterministic', usedPositional: false, confidence: 0.9 };
  // … insert pedimento with pedimento_reconciliation = report (mirror how the test seeds other jsonb cols) …
  const res = await request(app).get(`/api/records/${manifestId}`).set('Authorization', `Bearer ${token}`);
  expect(res.body.pedimentos[0].reconciliation).toMatchObject({ summary: { color: 'verde' } });
});
```
(Implementer: follow the existing records.test seed pattern — it already inserts pedimento rows with
jsonb columns like `prevalidation`/`import_data`. Add `pedimento_reconciliation` to that INSERT.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npm test -- test/routes/records.test.ts`
Expected: FAIL — column does not exist / `reconciliation` undefined.

- [ ] **Step 3: Write the migration**

```ts
// server/migrations/1700003100000_pedimento_reconciliation.ts
import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('pedimentos', { pedimento_reconciliation: { type: 'jsonb' } });
}
export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn('pedimentos', 'pedimento_reconciliation');
}
```

- [ ] **Step 4: Surface it on records detail**

In `server/src/routes/records.ts`: add `pedimento_reconciliation` to `PEDIMENTO_COLS`, and add
`reconciliation: p.pedimento_reconciliation ?? null` to each `pedimentos[]` entry in the detail handler.

- [ ] **Step 5: Run to verify it passes** — `cd server && npm test -- test/routes/records.test.ts` → PASS (reset `customs_test` if needed to apply the migration). Then `cd server && npm test` + root `npx vitest run` + tsc.

- [ ] **Step 6: Commit**

```bash
git add server/migrations/1700003100000_pedimento_reconciliation.ts server/src/routes/records.ts server/test/routes/records.test.ts
git commit -m "feat(reconcile): pedimento_reconciliation column + records surface (Task 3)"
```

---

### Task 4: Run reconciliation on upload (orchestration + entity cross-check)

**Files:**
- Modify: `server/src/routes/pedimentoUpload.ts`
- Test: `server/test/routes/pedimentoUpload.test.ts`

**Interfaces:**
- Consumes: `buildExpectedFromManifest` + `reconcile` (Tasks 1–2), `loadShipments`,
  `loadImporterOfRecord`/`loadCustomsAgent` + `crossCheckEntities` (Phase 2), `extracted` (already in scope).
- Produces: on a successful upload with parseable extraction, the new pedimento row's
  `pedimento_reconciliation` holds the report (with entity-cross-check FieldDiffs folded into
  `header` and intra-guía + mismatch notes in `notes`); `null` when extraction was unparseable.

- [ ] **Step 1: Write the failing test**

In `server/test/routes/pedimentoUpload.test.ts`, seed shipments on the manifest whose guías match the
`pedimentoPdf` fixture's covered guías, then assert the persisted reconciliation. (The existing
`pedimentoPdf` helper embeds OBSERVACIONES lines via `makeTextPdf`; reuse/extend it so the extracted
lines line up with seeded shipments. If the fixture has no partida lines, assert the report exists with
`summary.color` set and `missingInPedimento` reflecting the seeded-but-absent guías.)

```ts
it('persists a reconciliation report on upload when extraction yields data', async () => {
  // seed a shipment with guideId matching a covered guía in the fixture (follow existing shipment-seed helpers)
  // … insert shipment(s) …
  const res = await request(app).post(`/api/manifests/${manifestId}/pedimento-pdf`)
    .set('Authorization', `Bearer ${token}`)
    .attach('file', pedimentoPdf('25 85 1653 5001684'), { filename: 'pedimento.pdf', contentType: 'application/pdf' });
  expect(res.status).toBe(201);
  const row = await query<{ pedimento_reconciliation: { summary?: { color?: string } } | null }>(
    `SELECT pedimento_reconciliation FROM pedimentos WHERE id=$1`, [res.body.pedimentoId]);
  expect(row.rows[0].pedimento_reconciliation).not.toBeNull();
  expect(row.rows[0].pedimento_reconciliation!.summary!.color).toBeTruthy();
});
```
(Implementer: the exact assertion depends on what the fixture's extracted lines vs seeded shipments
produce — assert the report is non-null with a `summary.color` and the right counts for your seed.
If seeding shipments is heavy, a minimal assertion that the report persists and is shaped correctly is
acceptable; the pure reconcile logic is already exhaustively tested in Task 2.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npm test -- test/routes/pedimentoUpload.test.ts`
Expected: FAIL — `pedimento_reconciliation` is null (no orchestration yet).

- [ ] **Step 3: Implement the orchestration**

In `server/src/routes/pedimentoUpload.ts`, add imports:

```ts
import { buildExpectedFromManifest, reconcile } from '../../../shared/pedimento/reconcile';
import { crossCheckEntities } from '../../../shared/pedimento/entityCrossCheck';
import { loadImporterOfRecord, loadCustomsAgent } from '../services/entityMaster';
```

Build the report before the INSERT (after `extracted` is resolved and `manifestGuias` available; you
already call `loadShipments` for the stray-guía check — reuse those loaded shipments). Best-effort,
never throws:

```ts
  // Advisory reconciliation: expected (manifest, covered-guía subset) vs extracted (PDF). Best-effort.
  let reconciliation = null as import('../../../shared/types/reports').ReconciliationReport | null;
  try {
    if (extracted.lines.length > 0 || extracted.coveredGuias.length > 0) {
      const covered = new Set(extracted.coveredGuias);
      const subset = (await loadShipments(req.params.id))
        .map((s) => s.data)
        .filter((d) => covered.size === 0 || covered.has(d.guideId));
      const { expected, warnings } = buildExpectedFromManifest(
        subset.map((d) => ({ guideId: d.guideId, customsValueUsd: d.customsValueUsd, consignee: { name: d.consignee.name, rfc: d.consignee.rfc, curp: d.consignee.curp } })));
      const [importer, agent] = await Promise.all([loadImporterOfRecord(), loadCustomsAgent()]);
      const xc = crossCheckEntities(extracted.header, importer, agent);
      const notes = [...warnings];
      if (xc.importerRfcMismatch) notes.push('RFC del importador en el PDF no coincide con el importador de registro.');
      if (xc.patenteMismatch) notes.push('La patente del PDF no coincide con el agente aduanal configurado.');
      const report = reconcile(expected, extracted, { notes, generatedAt: new Date().toISOString() });
      report.header = [
        { field: 'importerRfc', expected: importer?.rfc ?? null, actual: extracted.header.importerRfc, ok: !xc.importerRfcMismatch },
        { field: 'patente', expected: agent?.patente ?? null, actual: extracted.header.patente, ok: !xc.patenteMismatch },
      ];
      reconciliation = report;
    }
  } catch {
    reconciliation = null; // advisory — never block the upload
  }
```

> NOTE: reuse the `loadShipments(req.params.id)` you already call for the stray-guía check rather than
> calling it twice — lift it to one call and use it for both. Keep one round-trip.

Add `pedimento_reconciliation` to the INSERT as the next placeholder (the INSERT currently ends at
`import_data` = `$13`; add `pedimento_reconciliation` = `$14`):

```ts
       (… existing columns …, import_data, pedimento_reconciliation)
     VALUES ($1,…,$13,$14) …
```
with the value `reconciliation ? JSON.stringify(reconciliation) : null` appended to the params array.

- [ ] **Step 4: Run to verify it passes** — focused test PASS, then `cd server && npm test` + root `npx vitest run` + `npm run lint` + tsc.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/pedimentoUpload.ts server/test/routes/pedimentoUpload.test.ts
git commit -m "feat(reconcile): run advisory reconciliation + entity cross-check on upload (Task 4)"
```

---

## Self-Review (completed)

- **Spec coverage (Phase 3):** `buildExpectedFromManifest` per-guía aggregation + intra-guía warning
  (T1); `reconcile` matched/mismatch/missing/extra + diffs + color + totals (T2); persistence column +
  records surfacing (T3); run-on-upload orchestration with the Phase-2 entity cross-check folded in (T4).
- **Placeholder scan:** pure/backend tasks carry complete code; the two endpoint tests (T3/T4) describe
  the seed precisely and defer only to the file's existing seed helpers (concrete, not vague).
- **Type consistency:** reuses the existing `shared/types/reports.ts` types verbatim; `reconcile`'s
  `opts.generatedAt`/`notes` and `header` mutation match `ReconciliationReport`. `crossCheckEntities`
  (Phase 2) and `loadImporterOfRecord`/`loadCustomsAgent` (Phase 2) consumed by their real signatures.

## Out of scope (later phases)

The wizard UI + cotejo panel (Phase 4); reconciliation surfaces in Consulta/drawer + XLSX export +
manual re-run endpoint + a history table (Phase 5). PDF positional extraction of partida `tasa` and
free-text fields (later refinement). The reconciliation report is recomputed on each upload; there is
no re-run endpoint yet.
