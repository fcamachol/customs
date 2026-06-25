# Pedimento Capture Wizard UI (Phase 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the inline per-subdivisión capture form with a 4-step modal `CaptureWizard`
(Subir → Datos pre-filled from extraction → Prevalidación + cotejo → Finalizar), driven by the
`sub_status` lifecycle, with the prevalidate body **assembled server-side** from the confirmed
`import_data` + the configured entities + the row's número (Poka-Yoke — nothing structured is re-keyed
or sent by the client).

**Architecture:** The shipped lifecycle endpoints (Tasks 1–6) are the wizard's drivers. The prevalidate
endpoint stops requiring a full `pedimentoBody` and instead self-assembles `BuildOptions` from the row
(`numero_pedimento`) + the persisted `import_data` header (extended to carry `tipoCambio`/`paymentDate`)
+ the `importer_of_record`/`customs_agent` config entities. The reconciliation report (computed on
upload, Phase 3) is displayed as the cotejo panel. The frontend gets a `CaptureWizard` modal +
`ReconciliationPanel`, and `SeguimientoView` is rewired to status chips + entry buttons.

**Tech Stack:** TypeScript, React + Vitest + Tailwind (root), Express + Vitest (server), Postgres.

Spec: `docs/superpowers/specs/2026-06-24-pedimento-extraction-reconciliation-wizard-design.md`

## Global Constraints

- Both suites green at **every** commit: root `npx vitest run` AND `cd server && npm test`.
  `npm run lint` (root) + `cd server && npx tsc --noEmit` clean.
- `git add <explicit paths>` ONLY — never `git add -A`.
- Reuse existing UI: `src/components/ui/Modal.tsx`, `Stepper.tsx`, `Button`, `Field`, `Input`, `Card`
  (see `RegistroView.tsx` for the `Stepper`-driven multi-step pattern: `useState(0)` + `<Stepper steps current />`).
- Lifecycle endpoints (already shipped): `POST /api/pedimentos/:id/import-data` (capture → `capturado`),
  `POST /api/pedimentos/:id/pedimento` (prevalidate → `prevalidado`/`rechazado`),
  `POST /api/pedimentos/:id/finalize` (→ `cargado`), `POST /api/pedimentos/:id/reopen` (`rechazado`→`capturado`).
- Records detail `pedimentos[]` already carries `subStatus`, `importData`, `prevalidation`,
  `reconciliation`, `lock`, `coveredGuias`, `numeroPedimento`, `pedimentoPdf`, `scanVerdict`.
- Clean/minimal UI per project design preference (cool-neutral, flat). Test DB = `customs_test` (mock).
- The wizard is the sole capture path; the inline 7-field `PedimentoCard` form is removed.

---

### Task 1: Server-side prevalidate body assembly (+ persist tipoCambio/paymentDate on capture)

**Files:**
- Modify: `server/src/routes/importData.ts` (extend the `FIELDS` allowlist)
- Modify: `server/src/routes/pedimento.ts` (assemble `BuildOptions` server-side; drop the `pedimentoBody` requirement)
- Modify: `server/src/validation/schemas.ts` (the prevalidate route no longer validates `pedimentoBody`)
- Test: `server/test/routes/importData.test.ts`, `server/test/routes/pedimento.test.ts`

**Interfaces:**
- Consumes: `loadImporterOfRecord`/`loadCustomsAgent` (Phase 2), `buildPedimento`, `prevalidatePedimento`, `nextSubStatus`.
- Produces: `POST /api/pedimentos/:id/pedimento` takes **no body**; it assembles `BuildOptions` from the
  row's `numero_pedimento` + the persisted `import_data` + the configured entities, then builds +
  prevalidates as before (same `sub_status` transitions). `422` with a clear message when the entities
  are unconfigured or required `import_data` fields are missing.

- [ ] **Step 1: Write the failing tests**

In `server/test/routes/importData.test.ts`, assert capture now persists `tipoCambio` + `paymentDate`:

```ts
it('capture persists tipoCambio and paymentDate (header fields ride along)', async () => {
  const pid = await addPedimento(manifestId, {});
  await request(app).post(`/api/pedimentos/${pid}/import-data`)
    .set('Authorization', `Bearer ${capturistaToken}`)
    .send({ patente: '1653', tipoCambio: 20.4568, paymentDate: '2025-04-05', version: 0 });
  const row = await query(`SELECT import_data FROM pedimentos WHERE id=$1`, [pid]);
  expect(row.rows[0].import_data).toMatchObject({ tipoCambio: 20.4568, paymentDate: '2025-04-05' });
});
```

In `server/test/routes/pedimento.test.ts`, rewrite the build/prevalidate tests to seed `import_data` +
config entities instead of POSTing `PEDIMENTO_BODY`:

```ts
async function setEntities() {
  await query(`INSERT INTO config (key,value) VALUES ('importer_of_record',$1) ON CONFLICT (key) DO UPDATE SET value=$1`,
    [JSON.stringify({ rfc: 'ADM130509UQ0', name: 'ADMERCE SA DE CV', fiscalAddress: 'CDMX' })]);
  await query(`INSERT INTO config (key,value) VALUES ('customs_agent',$1) ON CONFLICT (key) DO UPDATE SET value=$1`,
    [JSON.stringify({ patente: '1653', name: 'GUZMOR', agentRfc: 'GUMM710831UYA', agencyRfc: 'GLG1502247K9' })]);
}
const IMPORT_DATA = { tipoCambio: 20.45, claveAduanaEntrada: '850', claveAduanaDespacho: '850', fechaEntrada: '2025-04-04', paymentDate: '2025-04-05' };

it('prevalidación APPROVED assembles the body from import_data + config entities', async () => {
  await setEntities();
  const s1 = makeShipment('G1');
  await query('INSERT INTO shipments (id,manifest_id,data) VALUES ($1,$2,$3)', [s1.id, manifestId, JSON.stringify(s1)]);
  const pid = (await query(
    `INSERT INTO pedimentos (manifest_id, numero_pedimento, covered_guias, created_by, sub_status, import_data)
     VALUES ($1,'258516535001684',$2,$3,'capturado',$4) RETURNING id`,
    [manifestId, [s1.guideId], userId, JSON.stringify(IMPORT_DATA)])).rows[0].id;
  const res = await request(app).post(`/api/pedimentos/${pid}/pedimento`).set('Authorization', `Bearer ${token}`).send({});
  expect(res.status).toBe(201);
  expect(res.body.prevalidation.status).toBe('APPROVED');
  expect((await query(`SELECT sub_status FROM pedimentos WHERE id=$1`, [pid])).rows[0].sub_status).toBe('prevalidado');
});

it('returns 422 when the entities are not configured', async () => {
  const s1 = makeShipment('G1');
  await query('INSERT INTO shipments (id,manifest_id,data) VALUES ($1,$2,$3)', [s1.id, manifestId, JSON.stringify(s1)]);
  const pid = (await query(
    `INSERT INTO pedimentos (manifest_id, numero_pedimento, covered_guias, created_by, sub_status, import_data)
     VALUES ($1,'258516535001684',$2,$3,'capturado',$4) RETURNING id`,
    [manifestId, [s1.guideId], userId, JSON.stringify(IMPORT_DATA)])).rows[0].id;
  const res = await request(app).post(`/api/pedimentos/${pid}/pedimento`).set('Authorization', `Bearer ${token}`).send({});
  expect(res.status).toBe(422);
});
```
(Implementer: keep the existing covered_guias 400/404 and lifecycle 409 tests — they still apply; just
remove the `.send(PEDIMENTO_BODY)` body and seed `import_data` + entities + `numero_pedimento` instead.
The REJECTED test seeds a failing shipment as before.)

- [ ] **Step 2: Run to verify it fails** — `cd server && npm test -- test/routes/pedimento.test.ts test/routes/importData.test.ts`. Expected: FAIL.

- [ ] **Step 3: Extend the import_data allowlist**

In `server/src/routes/importData.ts`, add to the `FIELDS` array: `'tipoCambio'`, `'paymentDate'`
(so the capture step preserves the extracted header values pre-filled at upload).

- [ ] **Step 4: Self-assemble in the prevalidate route**

In `server/src/routes/pedimento.ts`:
- Remove `validate({ body: pedimentoBody })` from the route middleware (the route no longer reads `req.body`).
- Extend the row SELECT to include `numero_pedimento, import_data` (alongside `manifest_id, covered_guias, sub_status`).
- Import `loadImporterOfRecord`, `loadCustomsAgent` from `'../services/entityMaster'`.
- Replace `buildPedimento(subset.map((s) => s.data), req.body)` with an assembled `BuildOptions`:

```ts
  const [importer, agent] = await Promise.all([loadImporterOfRecord(), loadCustomsAgent()]);
  if (!importer || !agent) {
    res.status(422).json({ error: 'Configure el importador de registro y el agente aduanal antes de prevalidar.' });
    return;
  }
  const d = (row.import_data ?? {}) as Record<string, unknown>;
  const missing = ['tipoCambio', 'claveAduanaEntrada', 'claveAduanaDespacho', 'fechaEntrada', 'paymentDate']
    .filter((k) => d[k] == null || d[k] === '');
  if (!row.numero_pedimento || missing.length) {
    res.status(422).json({ error: `Faltan datos para prevalidar: ${[...(row.numero_pedimento ? [] : ['número de pedimento']), ...missing].join(', ')}.` });
    return;
  }
  const opts = {
    numeroPedimento: row.numero_pedimento,
    importer, agent,
    tipoCambio: Number(d.tipoCambio),
    customsEntryCode: String(d.claveAduanaEntrada),
    customsClearanceCode: String(d.claveAduanaDespacho),
    entryDate: String(d.fechaEntrada),
    paymentDate: String(d.paymentDate),
  };
  const ped = buildPedimento(subset.map((s) => s.data), opts);
```
Keep the rest (prevalidate, the lifecycle `nextSubStatus` guard, the UPDATE) unchanged.

- [ ] **Step 5: Run to verify it passes + both suites** — focused then `cd server && npm test` + root `npx vitest run` + tsc + lint. Reset `customs_test` if needed.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/importData.ts server/src/routes/pedimento.ts server/src/validation/schemas.ts server/test/routes/importData.test.ts server/test/routes/pedimento.test.ts
git commit -m "feat(pedimento): prevalidate self-assembles body from import_data + config entities (Task 1)"
```

---

### Task 2: `ReconciliationPanel` component

**Files:**
- Create: `src/components/ReconciliationPanel.tsx`
- Test: `src/components/ReconciliationPanel.test.tsx`

**Interfaces:**
- Consumes: a `ReconciliationReport` (the shape surfaced on `pedimento.reconciliation`).
- Produces: `<ReconciliationPanel report={...} />` — a presentational, read-only panel.

This is an interface-level task. Render, scaled to clean/minimal:
- A summary header with the `summary.color` (verde/amarillo/rojo/gris) as a status pill + the counts
  (`matched` / `mismatched` / `missingInPedimento` / `extraInPedimento`).
- A list of `lines` with their `status` and, for mismatches, the failing `diffs` (`field`,
  `expected`, `actual`). Keep large lists bounded (show mismatches/missing/extra first; the design
  notes never render thousands of matched rows — show the matched count, list only the exceptions).
- The `notes[]` (cross-check + intra-guía warnings) below.
- A `report == null` guard → a muted "Sin cotejo disponible" message.

- [ ] **Step 1: Write the failing test** — `ReconciliationPanel.test.tsx`: a report with 1 matched +
  1 mismatch renders the summary counts, the mismatch line with its `valorUsd` expected/actual, and a
  note; a `null` report renders the empty message. Use plain render (no API mocks needed — pure props).
- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/components/ReconciliationPanel.test.tsx`. FAIL.
- [ ] **Step 3: Implement** `ReconciliationPanel.tsx` per the contract.
- [ ] **Step 4: Run to verify it passes** — the file, then root suite + lint + tsc.
- [ ] **Step 5: Commit**

```bash
git add src/components/ReconciliationPanel.tsx src/components/ReconciliationPanel.test.tsx
git commit -m "feat(pedimento): ReconciliationPanel renders the cotejo report (Task 2)"
```

---

### Task 3: `CaptureWizard` modal (4 steps)

**Files:**
- Create: `src/components/CaptureWizard.tsx`
- Test: `src/components/CaptureWizard.test.tsx`

**Interfaces:**
- Consumes: a `PedimentoItem` (records-detail row incl. `subStatus`/`importData`/`prevalidation`/`reconciliation`/`lock`),
  `apiPost`, `apiDownload`; the lifecycle endpoints; `ReconciliationPanel` (Task 2).
- Produces: `<CaptureWizard pedimento={...} onClose={() => {}} onChanged={() => {}} />` — a `Modal`
  (`size="xl"` or the largest available; add a size to `Modal.tsx` only if needed) with a `Stepper`.

Interface-level task — component structure + behaviors + test assertions; make the clean/minimal
styling choices, consistent with `RegistroView`'s Stepper flow.

**Contract:**
- Steps: `['Revisar', 'Capturar', 'Prevalidar', 'Finalizar']`. The starting/active step derives from
  `pedimento.subStatus`: `pendiente`→Revisar/Capturar, `capturado`→Prevalidar, `prevalidado`→Finalizar,
  `rechazado`→show prevalidation errors + a **Reabrir** action (`POST .../reopen`, → Capturar),
  `cargado`→read-only summary (locked), no mutating actions.
- **Revisar:** read-only `numeroPedimento`, `subdivisionOrdinal`/`isLast`, `coveredGuias` count, PDF download.
- **Capturar:** the 7 import-data fields (reuse the field set + §10 `tasaWarning` + optimistic
  `version` handling from the former `PedimentoCard`), pre-filled from `pedimento.importData`. Save →
  `POST /import-data`; on success `onChanged()` + advance.
- **Prevalidar:** a button → `POST /pedimentos/:id/pedimento` (no body — server assembles). Render
  `prevalidation.status` + `errors`/`warnings`. Show `<ReconciliationPanel report={pedimento.reconciliation} />`
  (the cotejo, computed on upload). APPROVED → advance to Finalizar; REJECTED → show errors + Reabrir.
  A `422` (entities unconfigured / missing data) surfaces its error message inline.
- **Finalizar:** summary + confirm → `POST .../finalize`; on success `onChanged()` + close.

- [ ] **Step 1: Write failing tests** — `CaptureWizard.test.tsx` (mock `../api`): (a) a `pendiente`
  pedimento renders Revisar→Capturar and saving calls `/import-data` + `onChanged`; (b) a `capturado`
  pedimento Prevalidar calls `/pedimentos/:id/pedimento` and an APPROVED mock advances to Finalizar +
  renders the `ReconciliationPanel`; (c) a `prevalidado` pedimento Finalizar calls `/finalize` + `onClose`;
  (d) a `cargado` pedimento is read-only (no Save/Finalizar/Prevalidar buttons).
- [ ] **Step 2: Run to verify they fail** — `npx vitest run src/components/CaptureWizard.test.tsx`. FAIL.
- [ ] **Step 3: Implement** `CaptureWizard.tsx` per the contract (add a `Modal` size only if required).
- [ ] **Step 4: Run to verify they pass** — the file, then root suite + lint + tsc.
- [ ] **Step 5: Commit**

```bash
git add src/components/CaptureWizard.tsx src/components/CaptureWizard.test.tsx
# include src/components/ui/Modal.tsx + its test if you added a size
git commit -m "feat(pedimento): 4-step CaptureWizard modal (Task 3)"
```

---

### Task 4: Rewire `SeguimientoView` to the wizard

**Files:**
- Modify: `src/components/SeguimientoView.tsx` (remove the inline `PedimentoCard` form body; add status chip + entry button per row; auto-open after upload; `cargado` read-only)
- Test: `src/components/SeguimientoView.test.tsx` (update)

**Interfaces:**
- Consumes: `CaptureWizard` (Task 3); the existing records-detail `pedimentos[]` (now incl. `subStatus`/`reconciliation`).
- Produces: a single capture path; no inline 7-field form remains.

Interface-level cutover. Per-subdivisión row shows: número/subdivisión, a **status chip**
(`SUB_STATUS_BADGE[subStatus]` — define the badge map: pendiente/capturado/prevalidado/cargado/rechazado
with clean colors), the PDF download, and a **Capturar / Continuar / Ver** button (label by `subStatus`:
pendiente/capturado→"Capturar", prevalidado→"Continuar", cargado→"Ver", rechazado→"Revisar") that opens
`CaptureWizard` for that row. After a successful pedimento-PDF upload (existing handler), auto-open the
wizard for the newly created subdivisión (use the returned `pedimentoId` → reload detail → open it).
`onChanged` refreshes the sub-list + work-queue. Remove `PedimentoCard`'s `<form>` entirely. Keep the
two-tab work queue (Pendientes/Completados) coverage-based as today (the records list carries no
per-row `subStatus`; coverage stays the queue signal — see spec).

- [ ] **Step 1: Write failing tests** — `SeguimientoView.test.tsx`: the inline 7-field form is gone
  (no `Guardar datos` button, no inline `Patente` input on the row); a subdivisión row shows its status
  chip + a Capturar button that opens the `CaptureWizard` modal. Reuse the existing `makeDetail` mock
  (extend it with `subStatus`/`reconciliation`).
- [ ] **Step 2: Run to verify they fail** — `npx vitest run src/components/SeguimientoView.test.tsx`. FAIL.
- [ ] **Step 3: Implement** the rewire.
- [ ] **Step 4: Run to verify they pass** — the two component files, then BOTH full suites + `npm run lint` + `cd server && npx tsc --noEmit`.
- [ ] **Step 5: Commit**

```bash
git add src/components/SeguimientoView.tsx src/components/SeguimientoView.test.tsx
git commit -m "feat(pedimento): SeguimientoView opens CaptureWizard, drops inline form (Task 4)"
```

---

## Self-Review (completed)

- **Spec coverage (Phase 4):** server-side body assembly from config + extraction + capture (T1);
  cotejo panel (T2); 4-step wizard driven by `sub_status` with pre-fill + prevalidar + cotejo +
  finalize (T3); `SeguimientoView` rewire — status chips, entry/auto-open, `cargado` read-only,
  inline-form removal (T4). All Phase-4 spec bullets map to a task.
- **Placeholder scan:** T1 carries concrete assembly code + tests; T2–T4 are explicit interface-level
  UI tasks (contracts + behaviors + test assertions) per the established back-half style.
- **Type consistency:** the prevalidate route's assembled `BuildOptions` matches `buildPedimento`'s
  signature; `loadImporterOfRecord`/`loadCustomsAgent` (Phase 2) and the `import_data` field names
  (`claveAduanaEntrada`/`claveAduanaDespacho`/`fechaEntrada`/`tipoCambio`/`paymentDate`) are consistent
  with the importData `FIELDS` allowlist and the capture form. `pedimento.reconciliation` (Phase 3)
  feeds `ReconciliationPanel`.

## Out of scope (later phases)

Reconciliation surfaces beyond the wizard (Consulta/drawer/XLSX/re-run endpoint) + a reconciliation
history table (Phase 5). PDF positional extraction of tasa/customs codes (later refinement — they stay
operator-entered in Capturar). SAT/VUCEM + FIEL (Track 2).
