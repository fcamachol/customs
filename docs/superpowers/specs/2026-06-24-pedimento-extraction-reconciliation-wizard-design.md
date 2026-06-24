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

The extraction service produces the full header; the wizard pre-fills from it; the
prevalidate/finalize body is assembled from it.

| `BuildOptions` field | Source | Notes |
|---|---|---|
| `numeroPedimento` | PDF header (already parsed) | 15 digits, spaces stripped |
| `agent.patente` | **PDF number group 3** (`NUMERO_RE`) | e.g. `1653` — free from the already-parsed number |
| `agent.name` / `agentRfc` / `agencyRfc` | PDF agente-aduanal block | new anchors |
| `importer.rfc` / `name` / `fiscalAddress` | PDF importador block (RFC, razón social, domicilio) | new anchors |
| `tipoCambio` | PDF header `TIPO CAMBIO` | e.g. `20.45680` |
| `customsEntryCode` / `customsClearanceCode` | PDF `ADUANA E/S` / `SECCIÓN ADUANERA DE DESPACHO` | |
| `entryDate` / `paymentDate` | PDF `FECHAS` → `ENTRADA` / `PAGO` | `dd/mm/yyyy` → ISO; e.g. `04/04/2025` / `05/04/2025` |
| `tasaImportacion` | PDF page-2 PARTIDAS → IVA `TASA` row | positional pass (Approach B); vigencia warning only — **capture, don't calculate** (RGCE 3.7.35, PRD §10) |

- **Persistence.** Extend the stored `import_data` (the pedimento row's JSONB) to carry the full
  confirmed header (importer/agent objects, tipoCambio, paymentDate, numeroPedimento) alongside the
  7 visible fields, so prevalidate/finalize don't lose it and need no client round-trip of the
  header. The 7 fields stay the editable surface; the rest ride along.
- **Reconciliation "expected" side** = `buildExpectedFromManifest`, aggregating manifest rows **by
  guía** (the resolved per-guía partida model: sum `customsValueUsd`, one consignee/RFC per guía,
  flag intra-guía divergence), compared against the extracted partida lines (`ExtractedPedimentoLine[]`
  via the OBSERVACIONES grammar). **Advisory** — matched / mismatch / missing_in_pedimento /
  extra_in_pedimento with value/name/RFC diffs; never blocks the lifecycle.
- **Graceful degradation.** No text layer (pure scan) → deterministic tiers return low confidence;
  pre-fill skipped (operator types the 7 fields), reconciliation reports low confidence, AI tier (C)
  stays gated off (`AI_PEDIMENTO_EXTRACTION`). No silent failure.

## Components (isolation & interfaces)

- **`shared/pedimento/parsePedimentoText.ts`** (extend) — pure header + line parser. Input: PDF text.
  Output: `ExtractedPedimento` with the extended header. New anchors for agente/importador/fechas/
  tipoCambio/aduana; `patente` from the number; `tasaImportacion` via the positional pass.
- **`shared/types/reports.ts`** (extend) — `ExtractedPedimentoHeader` gains `patente`, `agentName`,
  `agencyRfc`, `importerName`, `importerAddress`, `entryDate`, `paymentDate`, `customsEntryCode`,
  `tipoCambio` (slots for `agentRfc`/`customsClearanceCode`/`tipoCambio` already exist),
  `tasaImportacion`. Add `ReconciliationReport` / `ReconciliationLine` types.
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

- **Unit (shared):** `parsePedimentoText` maps every header field from text fixtures (patente 1653,
  agente, tipoCambio 20.4568, entry 04/04/2025, pago 05/04/2025, aduana 850, tasa 19.000);
  `reconcile` returns correct matched/mismatch/missing/extra incl. a **multi-product-per-guía** case.
  **Never commit a real PDF** — fixtures are trimmed extracted-text strings only.
- **Backend:** upload endpoint returns scan + extracted + reconciliation and attaches `file_id`;
  prevalidate consumes the persisted header; import_data persists the full header.
- **Frontend:** `CaptureWizard` renders the 4-step stepper; step 2 pre-filled from a mocked
  `extracted` header; step 3 renders `ReconciliationPanel` from a mocked report; `cargado` →
  read-only; a `SeguimientoView` row click opens the modal; inline 7-field form is gone.
- Both suites green at every commit; `tsc --noEmit` + lint clean.

## Phasing (each phase → its own implementation plan → execution cycle, on this branch)

1. **Extraction core** — extend `ExtractedPedimentoHeader` + the parser (header anchors A +
   positional firm-up B for tasa), unit-tested against text fixtures. Wire `extractPedimento` into
   the upload endpoint; persist the extracted header on the pedimento row.
2. **Reconciliation engine** — `shared/pedimento/reconcile.ts` (`buildExpectedFromManifest` +
   `reconcile`, per-guía), pure + unit-tested; run advisory on upload; persist the report (JSONB +
   history) and expose it on the records detail.
3. **Wizard UI** — `CaptureWizard` modal (4 steps) pre-filled from extraction, `ReconciliationPanel`
   in step 3, driving the Task 1–6 endpoints; rewire `SeguimientoView` (status chips + entry
   buttons + auto-open on upload + `cargado` read-only); remove the inline form.
4. *(Follow-on, optional this branch)* **Reconciliation surfaces** — `ReconciliationPanel` in
   Consulta + detail drawer, manual re-run endpoint, XLSX export.

## Out of scope

SAT/VUCEM + FIEL/e.firma (Track 2); the autoridad export PII-masking decision
(`docs/MULTI_PEDIMENTO_PHASE1_FOLLOWUPS.md`); subdivisión-parser hardening beyond what extraction
needs. AI extraction tier (C) ships gated off.
