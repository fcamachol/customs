# Pedimento Extraction Core (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the pedimento PDF parser to extract the reliably-patterned per-pedimento header
fields (`patente`, `tipoCambio`, `entryDate`, `paymentDate`) and persist them as a capture pre-fill
on the pedimento row at upload time.

**Architecture:** The uploaded pedimento PDF is the source of truth for variable per-pedimento data.
`parsePedimentoText` already extracts `numeroPedimento` / `importerRfc` / partida lines via anchored
regexes over the full text; this phase adds four more pattern-based header fields and pre-fills the
row's `import_data` from them so the capture wizard arrives populated. Stable identity entities
(importer-of-record, customs agent) are NOT parsed here — they come from config (a later phase). The
free-text PDF layer is column-scrambled, so only distinctively-patterned fields are extracted.

**Tech Stack:** TypeScript, Vitest (root for `shared/`, server for routes), Express, Postgres
(node-pg-migrate), `pdf-parse`.

Spec: `docs/superpowers/specs/2026-06-24-pedimento-extraction-reconciliation-wizard-design.md`

## Global Constraints

- Both suites green at **every** commit: root `npx vitest run` AND `cd server && npm test`.
  `npm run lint` (root) + `cd server && npx tsc --noEmit` clean.
- `git add <explicit paths>` ONLY — never `git add -A` (node_modules symlink + `.superpowers/` gitignored).
- `shared/` is imported by both root and server; a type change there must keep BOTH suites + `tsc` green.
- **Never commit a real pedimento PDF.** Test fixtures are trimmed extracted-text strings or the
  synthetic `makeTextPdf` helper only.
- Extraction is **best-effort**: a field that cannot be parsed is `null`; the upload never 500s on a
  parse miss (existing `try/catch` around `extractPedimento` in `pedimentoUpload.ts` stays).
- Dates normalize `dd/mm/yyyy` → `yyyy-mm-dd`. `tipoCambio` is a `number`.
- This phase does NOT change `sub_status`: pre-filling `import_data` at upload leaves the row
  `pendiente` (capture confirmation via `POST /import-data` is what advances it — Task 4 of the
  shipped lifecycle).

---

### Task 1: Extend `ExtractedPedimentoHeader` + update the empty-header literals

**Files:**
- Modify: `shared/types/reports.ts` (the `ExtractedPedimentoHeader` interface)
- Modify: `shared/pedimento/parsePedimentoText.ts` (the `header: { … }` returned literal)
- Modify: `server/src/routes/pedimentoUpload.ts` (the `EMPTY_EXTRACTED.header` literal)
- Test: `shared/pedimento/parsePedimentoText.test.ts` (add a defaults assertion)

**Interfaces:**
- Produces: `ExtractedPedimentoHeader` gains `patente: string | null`, `agencyRfc: string | null`,
  `entryDate: string | null`, `paymentDate: string | null`. (`agentRfc`, `customsClearanceCode`,
  `tipoCambio`, `totalBultos` already exist.)

- [ ] **Step 1: Write the failing test**

Add to `shared/pedimento/parsePedimentoText.test.ts` (the SAMPLE here has no value-cluster/dates yet,
so the new fields stay null — this pins the defaults and the type shape):

```ts
it('exposes the extended header fields, defaulting to null when absent', () => {
  const out = parsePedimentoText(SAMPLE);
  expect(out.header).toMatchObject({
    patente: null,        // SAMPLE has a numero but Task 2 wires patente; here it is still null
    agencyRfc: null,
    entryDate: null,
    paymentDate: null,
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run shared/pedimento/parsePedimentoText.test.ts`
Expected: FAIL — `header` has no `patente`/`agencyRfc`/`entryDate`/`paymentDate` keys (and `tsc` would
flag the type if compiled).

- [ ] **Step 3: Extend the type**

In `shared/types/reports.ts`, extend the interface:

```ts
export interface ExtractedPedimentoHeader {
  numeroPedimento: string | null;
  clave: string | null;
  importerRfc: string | null;
  agentRfc: string | null;
  agencyRfc: string | null;
  patente: string | null;
  customsClearanceCode: string | null;
  tipoCambio: number | null;
  entryDate: string | null;     // ISO yyyy-mm-dd
  paymentDate: string | null;   // ISO yyyy-mm-dd
  totalBultos: number | null;
}
```

- [ ] **Step 4: Add the new keys (= null) to both empty-header literals**

In `shared/pedimento/parsePedimentoText.ts`, the returned `header` object — add the new keys defaulting
to `null` (keep the existing fields):

```ts
    header: {
      numeroPedimento, clave, importerRfc,
      agentRfc: null, agencyRfc: null, patente: null,
      customsClearanceCode: null, tipoCambio: null,
      entryDate: null, paymentDate: null, totalBultos: null,
    },
```

In `server/src/routes/pedimentoUpload.ts`, the `EMPTY_EXTRACTED.header` literal — same new keys = null:

```ts
  header: { numeroPedimento: null, clave: null, importerRfc: null, agentRfc: null, agencyRfc: null,
    patente: null, customsClearanceCode: null, tipoCambio: null, entryDate: null, paymentDate: null,
    totalBultos: null },
```

- [ ] **Step 5: Run to verify it passes + both suites + tsc**

Run: `npx vitest run shared/pedimento/parsePedimentoText.test.ts` → PASS.
Then: `npx vitest run` (root) + `cd server && npm test` + `cd server && npx tsc --noEmit` → all green/clean.

- [ ] **Step 6: Commit**

```bash
git add shared/types/reports.ts shared/pedimento/parsePedimentoText.ts server/src/routes/pedimentoUpload.ts shared/pedimento/parsePedimentoText.test.ts
git commit -m "feat(extract): extend ExtractedPedimentoHeader with patente/agencyRfc/entryDate/paymentDate (Task 1)"
```

---

### Task 2: Parse `patente` (from the número) + `tipoCambio`

**Files:**
- Modify: `shared/pedimento/parsePedimentoText.ts`
- Test: `shared/pedimento/parsePedimentoText.test.ts`

**Interfaces:**
- Consumes: `ExtractedPedimentoHeader` (Task 1), the existing `NUMERO_RE` match.
- Produces: `header.patente` (the 4-digit patente group of the número, e.g. `'1653'`),
  `header.tipoCambio` (the first decimal token with ≥4 decimal places, e.g. `20.4568`).

- [ ] **Step 1: Write the failing test**

Extend the SAMPLE in `shared/pedimento/parsePedimentoText.test.ts` to include the real header value
cluster (these lines do not match the OBSERVACIONES grammar, so `lines` is unaffected):

```ts
// add inside the SAMPLE template string, after the `T1` line:
// DESTINO/ORIGEN: TIPO CAMBIO: PESO BRUTO: ADUANA E/S:
// 9 20.45680 808.000 850
```

Then add:

```ts
it('extracts patente from the numero and tipoCambio from the value cluster', () => {
  const out = parsePedimentoText(SAMPLE);
  expect(out.header.patente).toBe('1653');     // group 3 of "25 85 1653 5001684"
  expect(out.header.tipoCambio).toBe(20.4568); // Number("20.45680")
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run shared/pedimento/parsePedimentoText.test.ts`
Expected: FAIL — `patente`/`tipoCambio` are `null`.

- [ ] **Step 3: Implement**

In `shared/pedimento/parsePedimentoText.ts`, after the existing `const num = t.match(NUMERO_RE);`:

```ts
  // Patente is the 4-digit group of the pedimento number ("25 85 1653 5001684" → "1653").
  const patente = num ? num[3] : null;
  // Tipo de cambio: the first decimal token with ≥4 decimals (e.g. "20.45680"). The peso bruto in
  // the same cluster carries ≤3 decimals, so ≥4 isolates the exchange rate. Best-effort.
  const tcMatch = t.match(/\b\d{1,3}\.\d{4,6}\b/);
  const tipoCambio = tcMatch ? Number(tcMatch[0]) : null;
```

Set them in the returned `header` (replace the `patente: null` and `tipoCambio: null` defaults):

```ts
      patente,
      tipoCambio,
```

- [ ] **Step 4: Run to verify it passes** — `npx vitest run shared/pedimento/parsePedimentoText.test.ts` → PASS. Then root suite green.

- [ ] **Step 5: Commit**

```bash
git add shared/pedimento/parsePedimentoText.ts shared/pedimento/parsePedimentoText.test.ts
git commit -m "feat(extract): parse patente + tipoCambio from pedimento header (Task 2)"
```

---

### Task 3: Parse `entryDate` + `paymentDate`

**Files:**
- Modify: `shared/pedimento/parsePedimentoText.ts`
- Test: `shared/pedimento/parsePedimentoText.test.ts`

**Interfaces:**
- Consumes: `ExtractedPedimentoHeader` (Task 1).
- Produces: `header.entryDate` / `header.paymentDate` — ISO `yyyy-mm-dd`. The Anexo-22 `FECHAS` block
  lists ENTRADA before PAGO, so the **first** `dd/mm/yyyy` on the page is the entry date and the
  **second** is the payment date.

- [ ] **Step 1: Write the failing test**

Extend the SAMPLE to include the two dates (again, non-OBSERVACIONES lines):

```ts
// add inside SAMPLE, after the value cluster:
// FECHAS
// 04/04/2025
// 05/04/2025
```

Then:

```ts
it('extracts entry and payment dates (first=entrada, second=pago) as ISO', () => {
  const out = parsePedimentoText(SAMPLE);
  expect(out.header.entryDate).toBe('2025-04-04');
  expect(out.header.paymentDate).toBe('2025-04-05');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run shared/pedimento/parsePedimentoText.test.ts`
Expected: FAIL — both dates `null`.

- [ ] **Step 3: Implement**

In `shared/pedimento/parsePedimentoText.ts`, add near the other header parses:

```ts
  // FECHAS block: first dd/mm/yyyy = ENTRADA, second = PAGO. Normalize to ISO. Best-effort.
  const isoDates = [...t.matchAll(/\b(\d{2})\/(\d{2})\/(\d{4})\b/g)].map((m) => `${m[3]}-${m[2]}-${m[1]}`);
  const entryDate = isoDates[0] ?? null;
  const paymentDate = isoDates[1] ?? null;
```

Set them in the returned `header` (replace the `entryDate: null` / `paymentDate: null` defaults):

```ts
      entryDate,
      paymentDate,
```

- [ ] **Step 4: Run to verify it passes** — focused test PASS, then root suite green.

- [ ] **Step 5: Commit**

```bash
git add shared/pedimento/parsePedimentoText.ts shared/pedimento/parsePedimentoText.test.ts
git commit -m "feat(extract): parse entry/payment dates to ISO (Task 3)"
```

---

### Task 4: Persist the extracted header as an `import_data` pre-fill at upload

**Files:**
- Modify: `server/src/routes/pedimentoUpload.ts` (the `INSERT INTO pedimentos … ` statement)
- Test: `server/test/routes/pedimentoUpload.test.ts`

**Interfaces:**
- Consumes: `extracted.header` (Tasks 1–3).
- Produces: on a successful upload, the new pedimento row's `import_data` JSONB carries the extracted
  pre-fill — `{ cveT1, patente, fechaEntrada, tipoCambio, paymentDate }` (only the non-null fields);
  `null` if nothing was extracted. `sub_status` stays `pendiente` (pre-fill ≠ capture).

- [ ] **Step 1: Write the failing test**

In `server/test/routes/pedimentoUpload.test.ts`, extend the `pedimentoPdf` helper so a real-parseable
PDF carries the value cluster + dates, and assert the persisted pre-fill:

```ts
// extend pedimentoPdf() to embed the header cluster + fechas so extractPedimento populates them:
function pedimentoPdf(numero: string): Buffer {
  return makeTextPdf([
    `NUM. PEDIMENTO: ${numero}`,
    'SEGUNDA SUBDIVISION DE LA GUIA MASTER NO. 369-94268462',
    '34 BULTOS CON UN PESO DE 808 KG.',
    'DESTINO/ORIGEN: TIPO CAMBIO: PESO BRUTO: ADUANA E/S:',
    '9 20.45680 808.000 850',
    'FECHAS',
    '04/04/2025',
    '05/04/2025',
  ]);
}

it('pre-fills import_data on the new pedimento row from the extracted header', async () => {
  const res = await request(app)
    .post(`/api/manifests/${manifestId}/pedimento-pdf`)
    .set('Authorization', `Bearer ${token}`)
    .attach('file', pedimentoPdf('25 85 1653 5001684'), { filename: 'pedimento.pdf', contentType: 'application/pdf' });
  expect(res.status).toBe(201);
  const row = await query<{ import_data: Record<string, unknown> | null; sub_status: string }>(
    `SELECT import_data, sub_status FROM pedimentos WHERE id=$1`, [res.body.pedimentoId]);
  expect(row.rows[0].import_data).toMatchObject({
    patente: '1653', cveT1: 'T1', fechaEntrada: '2025-04-04', tipoCambio: 20.4568, paymentDate: '2025-04-05',
  });
  expect(row.rows[0].sub_status).toBe('pendiente'); // pre-fill does not advance the lifecycle
});
```

(If the existing upload tests assert nothing about `import_data`, they stay green — this only adds a column.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npm test -- test/routes/pedimentoUpload.test.ts`
Expected: FAIL — `import_data` is `null` (the INSERT never set it).

- [ ] **Step 3: Implement**

In `server/src/routes/pedimentoUpload.ts`, build the pre-fill object from the extracted header just
before the `INSERT`, then add `import_data` to the statement. Insert after the `extracted` is resolved
(and after the gates), before `saveFile`:

```ts
  // Pre-fill the capture form from the extracted header (best-effort). Store only the non-null
  // fields; null when nothing was extracted, so an unparseable PDF leaves import_data NULL.
  const h = extracted.header;
  const prefillEntries: [string, unknown][] = [
    ['cveT1', h.clave], ['patente', h.patente], ['fechaEntrada', h.entryDate],
    ['tipoCambio', h.tipoCambio], ['paymentDate', h.paymentDate],
  ].filter(([, v]) => v != null) as [string, unknown][];
  const importPrefill = prefillEntries.length ? Object.fromEntries(prefillEntries) : null;
```

Then change the `INSERT INTO pedimentos (…) VALUES (…)` to add the `import_data` column. The current
statement has 12 columns / `$1..$12`; add `import_data` as the 13th:

```ts
  const ins = await query<{ id: string }>(
    `INSERT INTO pedimentos
       (manifest_id, numero_pedimento, master_guide, subdivision_ordinal, is_last_subdivision,
        sibling_numeros, bultos, peso_bruto_kg, covered_guias, file_id, pedimento_scan, created_by,
        import_data)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [
      req.params.id, numeroPedimento, subdivision.masterGuide, subdivision.ordinal,
      subdivision.isLast, subdivision.siblings, subdivision.bultos, subdivision.pesoBrutoKg,
      extracted.coveredGuias, meta.id, JSON.stringify(scan), req.user!.userId,
      importPrefill ? JSON.stringify(importPrefill) : null,
    ],
  );
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npm test -- test/routes/pedimentoUpload.test.ts` → PASS.
Then: `cd server && npm test` + root `npx vitest run` + `cd server && npx tsc --noEmit` → all green/clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/pedimentoUpload.ts server/test/routes/pedimentoUpload.test.ts
git commit -m "feat(extract): pre-fill import_data from extracted header at upload (Task 4)"
```

---

## Self-Review (completed)

- **Spec coverage (Phase 1 only):** extend `ExtractedPedimentoHeader` (T1); parser pattern fields
  patente/tipoCambio (T2) + entry/payment dates (T3); wire into upload + persist pre-fill (T4). The
  spec's "agentRfc/agencyRfc cross-check" extraction is intentionally deferred to the reconciliation
  phase (those entities come from config); customs codes + tasa stay capture-sourced per the spec.
- **Placeholder scan:** every code step carries the actual code; no TBD/TODO.
- **Type consistency:** `ExtractedPedimentoHeader` fields defined in T1 are used verbatim in T2–T4;
  the `import_data` pre-fill keys (`cveT1`, `patente`, `fechaEntrada`, `tipoCambio`, `paymentDate`)
  match the capture form's field names in `src/components/SeguimientoView.tsx`.

## Out of scope (later phases)

Entity master (`importer_of_record` / `customs_agent` config + cross-check); reconciliation engine;
the capture wizard UI; PDF positional extraction (Approach B) of tasa / customs codes / free-text
identity fields; AI extraction tier (C). See the spec's Phasing section.
