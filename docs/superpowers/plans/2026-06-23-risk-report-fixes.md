# Risk Report Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two defects in the Análisis de Riesgo: (1) `risk_color` is never persisted, so every row renders "Sin evaluar"; (2) the on-screen "País remitente" column is bound to country-of-origin instead of the sender/procedencia country.

**Architecture:** Both bugs are in the server risk/report path. Bug 1 is a key mismatch in `risk.ts` — it updates shipments `WHERE id = data.id`, but promotion inserts rows with an independent `gen_random_uuid()` PK, so the UPDATE matches zero rows. Fix: carry the table PK onto the shipment before scoring. Bug 2 is a wrong field binding in the risk-row builders; fix: read `procedenceCountry`.

**Tech Stack:** TypeScript, Node/Express, Postgres, Vitest + supertest. Server tests run against a real test DB (`TEST_DATABASE_URL`); the setup file runs migrations and `truncateAll()` resets state per test.

## Global Constraints

- Server tests run from the `server/` directory: `cd server && npx vitest run <path>` (one shared test DB, `fileParallelism: false`).
- Do not change the `shipments` table schema, the promotion insert (`manifests.ts`), or the parser — the table PK is intentionally `gen_random_uuid()`; the fix is read-side only.
- The risk scorer legitimately has a `gris` band for low-signal shipments (`shared/risk/classify.ts:22`). After Bug 1 is fixed, some rows may still be gris — that is correct behavior, not a regression. Assert on `risk_color IS NOT NULL` (persistence), never on a specific non-gris color.
- "País remitente" must read `procedenceCountry` (país de procedencia, derived from the sender country during parsing). Scope is the **on-screen risk table only** — do NOT add a column to the downloadable `Analisis_de_Riesgo.xlsx`.

---

### Task 1: Persist risk_color by the real shipment PK

**Files:**
- Modify: `server/src/routes/risk.ts:23-25` (load) and confirm `:38-41` (persist loop, unchanged)
- Test: `server/test/routes/risk.test.ts` (add one test)

**Interfaces:**
- Consumes: `scoreManifest(shipments, history, opts)` returns `ScoredShipment[]` where each item is `{ shipment: Shipment, score, band, color, incidences }` and `shipment` is the *same object* passed in (`shared/risk/classify.ts:95-106`). So `sc.shipment.id` is whatever `id` the loaded shipment carries.
- Produces: nothing new; restores the intended invariant that the persist UPDATE targets the table PK.

**Why the existing test passes but production fails:** `addShipment` in the test inserts `INSERT INTO shipments (id, ...) VALUES ($1 = s.id, ...)` — table PK equals `data.id`. Production promotion (`manifests.ts:94`) inserts `VALUES (gen_random_uuid(), ...)`, so table PK ≠ `data.id`. The new test must reproduce the production insert.

- [ ] **Step 1: Write the failing test**

Add to `server/test/routes/risk.test.ts` inside the `describe('POST /api/manifests/:id/risk', ...)` block:

```typescript
  it('persists risk_color when the table PK differs from data.id (production promotion path)', async () => {
    // Mimic production promotion: the table PK is an independent gen_random_uuid(),
    // NOT the parse-time data.id stored inside the JSONB.
    const data = {
      id: crypto.randomUUID(), mawbReference: '369-1', description: 'camisa', hsCode: '9901000100',
      quantity: 1, unit: 'PCE', customsValueUsd: 100, currency: 'USD', originCountry: 'CN', guideId: 'g1',
      consignee: { name: 'Ana', rfc: 'PERJ800101AA8', address: 'Calle 1' }, sender: { name: 'S' }, platform: { commercialName: 'P' },
    };
    await query(
      'INSERT INTO shipments (id, manifest_id, data) VALUES (gen_random_uuid(), $1, $2)',
      [manifestId, JSON.stringify(data)]);

    const res = await request(app)
      .post(`/api/manifests/${manifestId}/risk`)
      .set('Authorization', `Bearer ${token}`)
      .send({ period: '2025-02' });

    expect(res.status).toBe(200);
    const persisted = await query(
      'SELECT risk_color FROM shipments WHERE manifest_id=$1 AND risk_color IS NOT NULL', [manifestId]);
    expect(persisted.rows.length).toBe(1);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/routes/risk.test.ts -t "table PK differs"`
Expected: FAIL — `expected 1 to be ... ` / `persisted.rows.length` is `0` (UPDATE matched no rows because `WHERE id = data.id` never equals the `gen_random_uuid()` PK).

- [ ] **Step 3: Write minimal implementation**

In `server/src/routes/risk.ts`, change the load mapping (currently line 25) to carry the table PK onto the decrypted shipment so `sc.shipment.id` is the row PK:

```typescript
  const { rows } = await query<{ id: string; data: Shipment }>(
    'SELECT id, data FROM shipments WHERE manifest_id=$1', [req.params.id]);
  const shipments = rows.map((r) => ({ ...decryptShipment(r.data), id: r.id }));
```

Leave the persist loop unchanged — `UPDATE shipments SET ... WHERE id=$4` with `sc.shipment.id` now matches the table PK.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run test/routes/risk.test.ts`
Expected: PASS — the new test and all three existing tests (the existing ones still pass because their `data.id` happens to equal their PK).

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/risk.ts server/test/routes/risk.test.ts
git commit -m "fix(risk): persist risk_color by table PK, not data.id

Promotion inserts shipments with a gen_random_uuid() PK independent of
the parse-time data.id stored in the JSONB. risk.ts updated WHERE id =
data.id, matching zero rows, so risk_color stayed NULL and every report
rendered 'Sin evaluar'. Carry the table PK onto the shipment before
scoring so the persist UPDATE targets the right row."
```

---

### Task 2: Bind "País remitente" to procedenceCountry

**Files:**
- Modify: `server/src/services/reportData.ts:48` (on-screen bundle via `buildRiskScreenRows`)
- Modify: `server/src/routes/risk.ts:80` (immediate POST /risk response rows, for parity with the bundle)
- Test: `server/test/services/reportData.test.ts` (create)

**Interfaces:**
- Consumes: `buildRiskScreenRows(loaded: LoadedShipment[]): RiskScreenRow[]` where `LoadedShipment = { data: Shipment; risk_color: string | null; risk_incidences: string[] | null }`. `RiskScreenRow.senderCountry` is the value rendered in the on-screen "País remitente" column (`src/components/RiskResultTable.tsx:54,65`).
- Produces: `senderCountry` now sourced from `Shipment.procedenceCountry` (país de procedencia, derived from sender country in `shared/parsing/manifestParser.ts:47-49`).

**Note on legacy rows:** `procedenceCountry` is computed at ingestion. Shipments ingested before this lands still have it (the parser has computed it since the sender fields existed); if any legacy row lacks it, re-running ingestion/risk recomputes from the manifest. No data migration is in scope.

- [ ] **Step 1: Write the failing test**

Create `server/test/services/reportData.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { buildRiskScreenRows, type LoadedShipment } from '../../src/services/reportData';
import type { Shipment } from '../../../shared/types/shipment';

function shipment(overrides: Partial<Shipment>): Shipment {
  return {
    id: 'sid', mawbReference: '369-1', description: 'camisa', hsCode: '9901000100',
    quantity: 1, unit: 'PCE', customsValueUsd: 100, currency: 'USD', originCountry: '', guideId: 'g1',
    consignee: { name: 'Ana', rfc: 'PERJ800101AA8' }, sender: { name: 'S' }, platform: { commercialName: 'P' },
    ...overrides,
  } as Shipment;
}

describe('buildRiskScreenRows', () => {
  it('maps País remitente from procedenceCountry, not country of origin', () => {
    const loaded: LoadedShipment[] = [{
      data: shipment({ procedenceCountry: 'US', originCountry: 'CN', platform: { commercialName: 'P', countryOfOrigin: 'CN' } }),
      risk_color: 'verde', risk_incidences: [],
    }];
    const rows = buildRiskScreenRows(loaded);
    expect(rows[0].senderCountry).toBe('US');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/services/reportData.test.ts`
Expected: FAIL — `expected 'CN' to be 'US'` (current code reads `platform.countryOfOrigin ?? originCountry` → `'CN'`).

- [ ] **Step 3: Write minimal implementation**

In `server/src/services/reportData.ts`, change the `senderCountry` mapping in `buildRiskScreenRows` (line 48) from:

```typescript
    senderCountry: r.data.platform.countryOfOrigin ?? r.data.originCountry,
```

to:

```typescript
    senderCountry: r.data.procedenceCountry || r.data.sender.countryName || r.data.sender.countryCode || '',
```

Then, for parity, apply the same source to the POST /risk response in `server/src/routes/risk.ts` (line 80), changing:

```typescript
      senderCountry: s.shipment.platform.countryOfOrigin ?? s.shipment.originCountry,
```

to:

```typescript
      senderCountry: s.shipment.procedenceCountry || s.shipment.sender.countryName || s.shipment.sender.countryCode || '',
```

(`procedenceCountry` is primary per the chosen field source; the sender fallbacks are defensive for any row whose derived value is blank. `||` is used so empty strings fall through.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run test/services/reportData.test.ts test/routes/risk.test.ts test/routes/reports.test.ts`
Expected: PASS — new test passes; the risk and reports route tests remain green.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/reportData.ts server/src/routes/risk.ts server/test/services/reportData.test.ts
git commit -m "fix(reports): bind 'País remitente' to procedenceCountry

The on-screen risk table's 'País remitente' column read
platform.countryOfOrigin ?? originCountry — country of manufacture, not
the sender. originCountry has no header mapping so it was always blank,
leaving the column empty. Source it from procedenceCountry (país de
procedencia, derived from the sender country) instead, with sender-country
fallbacks. On-screen only; the XLSX artifact is unchanged."
```

---

## Self-Review

- **Spec coverage:** Bug 1 (risk_color persistence) → Task 1. Bug 2 (País remitente binding, on-screen only, procedenceCountry source) → Task 2. Both diagnosed defects covered; XLSX explicitly out of scope per decision.
- **Placeholder scan:** None — every step has concrete code and exact run commands.
- **Type consistency:** `LoadedShipment` and `buildRiskScreenRows` signatures match `reportData.ts`. `procedenceCountry`, `sender.countryName`, `sender.countryCode` all exist as optional `string` on the `Shipment`/`SenderData` types (`shared/types/shipment.ts:27-28,50`). `ScoredShipment.shipment` identity-preservation confirmed in `classify.ts`.
