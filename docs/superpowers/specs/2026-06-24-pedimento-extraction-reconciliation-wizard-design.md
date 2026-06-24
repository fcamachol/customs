# Pedimento Extraction + Reconciliation + Capture Wizard (Unified) — Design

> **Status:** brainstormed & approved 2026-06-24. Supersedes the capture-step approach in
> `2026-06-24-multi-pedimento-capture-wizard-design.md` (the "slim" plan) and unifies it with
> `2026-06-24-seguimiento-pedimento-wizard-design.md` (the extraction/reconciliation design).
> Builds on the **already-shipped Tasks 1–6** of the slim plan (the `sub_status` lifecycle backbone).

## Why this exists

The slim capture-wizard plan (Tasks 1–7) shipped Tasks 1–6 — the `sub_status` state machine, the
`sub_status` column + backfill, the lifecycle-driven lock, capture→`capturado`,
prevalidate→`prevalidado`/`rechazado`, and the finalize/reopen endpoints. Its **Task 7** (the
frontend wizard) assumed a **manual 7-field capture form**, then hit a wall: the prevalidate
endpoint (`POST /api/pedimentos/:id/pedimento`) builds via `buildPedimento`, which needs a full
`BuildOptions` (structured `importer` + `agent`, `tipoCambio`, `paymentDate`, `numeroPedimento`,
customs codes, dates) — far more than the 7 fields, with no source for the rest.

The **Poka-Yoke** answer (mistake-proofing: one authoritative source per field, never re-key what
the system can know) is the architecture already specified in
`2026-06-24-seguimiento-pedimento-wizard-design.md`: **the uploaded pedimento PDF is the source of
truth.** Confirmed against a real Anexo-22 pedimento (`…6df526b6…-Pedimento.pdf`): the text layer
exposes every `BuildOptions` field. So the wizard extracts → pre-fills → reconciles, and the
operator confirms rather than types.

## How it unifies with the shipped Tasks 1–6

The shipped lifecycle **simplifies** the comprehensive design. Task 3 made the lock
`sub_status === 'cargado'` (not `file_id`), so the doc's **deferred-attach / `tempFileId`**
machinery is no longer needed — attaching the PDF on upload is safe because it no longer locks.

Lifecycle backbone (unchanged, already built):

```
pendiente ──capture──▶ capturado ──prevalidate_pass──▶ prevalidado ──finalize──▶ cargado (locked)
                  ▲           │                                  │
                  └─reopen────┴────prevalidate_block──▶ rechazado ┘
```

Wizard step → endpoint mapping (all endpoints already exist from Tasks 1–6):

| Wizard step | Endpoint (existing) | Transition |
|---|---|---|
| 1. Subir pedimento | `POST /api/manifests/:id/pedimento-pdf` (extended: scan **+ extract +** attach + persist header) | stays `pendiente`/`capturado` |
| 2. Datos de importación | `POST /api/pedimentos/:id/import-data` (Task 4), **pre-filled from extraction** | → `capturado` |
| 3. Prevalidación y cotejo | `POST /api/pedimentos/:id/pedimento` (Task 5, fed the confirmed header) **+ reconciliation** | → `prevalidado` / `rechazado` |
| 4. Finalizar | `POST /api/pedimentos/:id/finalize` (Task 6) | → `cargado` (locks) |
| (Reopen from rechazado/review) | `POST /api/pedimentos/:id/reopen` (Task 6) | `rechazado` → `capturado` |

**No rework of the lifecycle, no `tempFileId`.** New work = extraction service + reconciliation
engine + the wizard UI, layered on top.

## Field sourcing (resolves the slim plan's blocker / the comprehensive doc's finding #4)

**Decision (brainstorming 2026-06-24): stable entities are configured once; the PDF cross-checks
them.** The pedimento text layer is **column-scrambled** (labels and values land in separate
blocks), so free-text identity fields are not reliably text-extractable — *and* the
importer-of-record and customs agent are **stable per-operation entities** (one importer-of-record,
one customs agent, identical across every pedimento). Re-keying or fragile-extracting stable data is
the error source Poka-Yoke eliminates. So:

**(a) Configured-once master entities** — filled with zero per-pedimento entry:

| `BuildOptions` field | Source | Notes |
|---|---|---|
| `importer.{rfc,name,fiscalAddress}` | **`importer_of_record` config key** (super_admin-editable) | the MX importer-of-record (e.g. ADMERCE SA DE CV) |
| `agent.{patente,name,agentRfc,agencyRfc}` | **`customs_agent` config key** (super_admin-editable) | the customs broker identity (e.g. GUZMOR) |

> v1 assumption: one importer-of-record + one customs agent per deployment (global config). If a
> deployment needs per-client importers later, the key becomes a per-client lookup — out of scope now.

**(b) Per-pedimento PDF-extracted fields** (variable; reliably pattern-matched):

| `BuildOptions` / cross-check field | Source | Notes |
|---|---|---|
| `numeroPedimento` | PDF header (already parsed) | 15 digits, spaces stripped |
| `patente` (cross-check) | **PDF número group 3** (`NUMERO_RE`) | e.g. `1653`; must match `customs_agent.patente` |
| `tipoCambio` | PDF header — first decimal token with ≥4 places | e.g. `20.45680` |
| `entryDate` / `paymentDate` | PDF `FECHAS` — the two `dd/mm/yyyy` dates in order | `04/04/2025` / `05/04/2025` → ISO |
| `importerRfc` / `agentRfc` / `agencyRfc` (cross-check) | PDF (RFC/CURP pattern matches) | cross-check vs the configured entities; flag divergence |
| `customsEntryCode` / `customsClearanceCode` | capture step (2 of the 7 fields) | PDF extraction is a later refinement |
| `tasaImportacion` | capture step (1 of the 7 fields); PDF page-2 positional extraction is a later refinement | **capture, don't calculate** (RGCE 3.7.35, PRD §10); `tasa_vigencias` stays a non-blocking warning |

- **Cross-check (Poka-Yoke).** The PDF-extracted `importerRfc` / `agentRfc` / `agencyRfc` / `patente`
  are compared against the configured master entities during reconciliation; a mismatch is flagged
  (advisory) — catching a wrong master config or a wrong PDF, without re-keying.
- **Body assembly.** The prevalidate/finalize body = importer + agent from the master config +
  `tipoCambio`/dates from extraction + customs codes/tasa from the capture step + `numeroPedimento`
  from the row. Nothing stable is re-keyed.
- **Persistence.** Extend the stored `import_data` (the pedimento row's JSONB) to carry the assembled
  header (the extracted per-pedimento fields) alongside the 7 visible fields, so prevalidate/finalize
  need no client round-trip. The configured entities are read fresh from config at build time.
- **Reconciliation "expected" side** = `buildExpectedFromManifest`, aggregating manifest rows **by
  guía** (the resolved per-guía partida model: sum `customsValueUsd`, one consignee/RFC per guía,
  flag intra-guía divergence), compared against the extracted partida lines (`ExtractedPedimentoLine[]`
  via the OBSERVACIONES grammar). **Advisory** — matched / mismatch / missing_in_pedimento /
  extra_in_pedimento with value/name/RFC diffs; never blocks the lifecycle.
- **Graceful degradation.** No text layer (pure scan) → deterministic tiers return low confidence;
  pre-fill skipped (operator types the 7 fields), reconciliation reports low confidence, AI tier (C)
  stays gated off (`AI_PEDIMENTO_EXTRACTION`). No silent failure.

## Components (isolation & interfaces)

- **`importer_of_record` + `customs_agent` config keys** — super_admin-editable via the existing
  config/catalogs mechanism (alongside `tasa_vigencias`, `denied_parties`). Zod-validated shapes
  (`importerSchema` / `agentSchema`). A small admin surface to edit them.
- **`shared/pedimento/parsePedimentoText.ts`** (extend) — pure header + line parser. Input: PDF text.
  Output: `ExtractedPedimento` with the extended header. New **pattern-based** anchors only:
  `patente` from the número (group 3); `tipoCambio` (first ≥4-decimal token); `entryDate`/`paymentDate`
  (the two `dd/mm/yyyy` dates); `agentRfc`/`agencyRfc` (RFC/CURP patterns in the agente block). No
  free-text name/address parsing (those come from config). `tasaImportacion` + customs codes stay
  capture-sourced (positional extraction is a later refinement).
- **`shared/types/reports.ts`** (extend) — `ExtractedPedimentoHeader` gains `patente`, `agencyRfc`,
  `entryDate`, `paymentDate` (slots for `agentRfc`/`customsClearanceCode`/`tipoCambio` already exist).
  Add `ReconciliationReport` / `ReconciliationLine` types.
- **`server/src/services/pdfExtract/`** (extend) — text-layer (A) → positional firm-up (B) →
  AI fallback (C, gated). Returns `ExtractedPedimento`. Already wraps `parsePedimentoText`.
- **`shared/pedimento/reconcile.ts`** (new) — `buildExpectedFromManifest(shipments)` +
  `reconcile(expected, extracted)`. Pure, unit-tested.
- **`src/components/CaptureWizard.tsx`** (new) — 4-step modal (Stepper). Props
  `{ pedimento, onClose, onChanged }`. State: file, scan, extracted, form, reconciliation,
  prevalidation. Reuses the dropzone + `ScanResultCard` + the 7-field grid + a `ReconciliationPanel`.
  Current step derived from `pedimento.subStatus`.
- **`src/components/ReconciliationPanel.tsx`** (new) — renders a `ReconciliationReport` (advisory).
- **`src/components/SeguimientoView.tsx`** (modify) — remove the inline `PedimentoCard` form; each
  subdivisión row shows a status chip (`SUB_STATUS_BADGE`) + a Capturar/Continuar/Ver button that
  opens `CaptureWizard`; auto-open after that subdivisión's PDF upload; `cargado` rows open read-only.

## Data flow

1. Operator picks a manifest → sees its subdivisión rows with status chips.
2. **Upload** a pedimento PDF → server scans (RF-08/RF-10), extracts the header + lines, attaches
   `file_id`, persists the extracted header on the row, runs reconciliation (advisory). Wizard auto-opens.
3. **Capture** step pre-filled from the extracted header; operator confirms/corrects the 7 fields →
   `POST /import-data` (persists full header) → `capturado`.
4. **Prevalidar** step → `POST /pedimento` builds from manifest partidas + confirmed header,
   structurally prevalidates → `prevalidado`/`rechazado`; the cotejo panel shows the reconciliation.
5. **Finalizar** → `POST /finalize` → `cargado` (locked). Row moves to Completados.

## Error handling

- Upload `blocked` scan verdict → 422, wizard stops at step 1 (existing behavior).
- Extraction failure / no text layer → fields blank + low-confidence flags; operator proceeds manually.
- Prevalidate from an illegal lifecycle state → 409 (Task 5 guard).
- Finalize from non-`prevalidado` → 409 (Task 6 guard). Lock on `cargado` → capture 409 (Task 3).
- Reconciliation is advisory; engine errors degrade to "no report", never block finalize.

## Testing

- **Unit (shared):** `parsePedimentoText` maps the pattern fields from text fixtures (patente 1653,
  tipoCambio 20.4568, entry 04/04/2025, pago 05/04/2025, agentRfc GUMM710831UYA, agencyRfc
  GLG1502247K9); `reconcile` returns correct matched/mismatch/missing/extra incl. a
  **multi-product-per-guía** case, and flags an importer/agent RFC cross-check mismatch.
  **Never commit a real PDF** — fixtures are trimmed extracted-text strings only.
- **Backend:** the `importer_of_record`/`customs_agent` config keys validate + reject bad shapes;
  upload endpoint extracts + persists the per-pedimento header; prevalidate assembles the body from
  config + persisted header.
- **Frontend:** `CaptureWizard` renders the 4-step stepper; step 2 pre-filled from a mocked
  `extracted` header; step 3 renders `ReconciliationPanel` from a mocked report; `cargado` →
  read-only; a `SeguimientoView` row click opens the modal; inline 7-field form is gone.
- Both suites green at every commit; `tsc --noEmit` + lint clean.

## Phasing (each phase → its own implementation plan → execution cycle, on this branch)

1. **Extraction core** — extend `ExtractedPedimentoHeader` + the parser with the **pattern-based**
   per-pedimento anchors (patente, tipoCambio, entry/payment dates, agentRfc, agencyRfc),
   unit-tested against trimmed real-text fixtures. Wire the extended header into the upload endpoint;
   persist it on the pedimento row's `import_data`.
2. **Entity master** — `importer_of_record` + `customs_agent` config keys (validated, super_admin-
   editable) + admin surface; helper that reads them for body assembly + the RFC/patente cross-check.
3. **Reconciliation engine** — `shared/pedimento/reconcile.ts` (`buildExpectedFromManifest` +
   `reconcile`, per-guía, + the entity cross-check), pure + unit-tested; run advisory on upload;
   persist the report (JSONB + history) and expose it on the records detail.
4. **Wizard UI** — `CaptureWizard` modal (4 steps) pre-filled from extraction + the configured
   entities, `ReconciliationPanel` in step 3, driving the Task 1–6 endpoints; rewire `SeguimientoView`
   (status chips + entry buttons + auto-open on upload + `cargado` read-only); remove the inline form.
   The prevalidate body is assembled server-side or client-side from config + extraction + capture.
5. *(Follow-on, optional this branch)* **Reconciliation surfaces** — `ReconciliationPanel` in
   Consulta + detail drawer, manual re-run endpoint, XLSX export.

Phases 1 and 2 are independent and could be built in either order; each is its own plan.

## Out of scope

SAT/VUCEM + FIEL/e.firma (Track 2); the autoridad export PII-masking decision
(`docs/MULTI_PEDIMENTO_PHASE1_FOLLOWUPS.md`); subdivisión-parser hardening beyond what extraction
needs. AI extraction tier (C) ships gated off.
