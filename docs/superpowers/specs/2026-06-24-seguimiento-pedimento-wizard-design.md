# Seguimiento — Pedimento Wizard + Manifest↔Pedimento Reconciliation

> Absorbs the standalone plan `docs/superpowers/plans/2026-06-22-pedimento-reconciliation.md` (written, not yet built) as its extraction/reconciliation foundation, and adds the modal capture wizard on top. Build extraction **once**; use it for both pre-fill and reconciliation.

## Context

In the Seguimiento two-tab work queue (just shipped), selecting a record renders the capture form + PDF upload **inline below the list**. The user wants this replaced with a **full-screen modal wizard** (modeled on the "Realizar registro" flow in `RegistroView.tsx`) that guides the operator through pedimento capture step by step.

The driving insight: the uploaded pedimento PDF is the source of truth for most of the data we currently ask the operator to type by hand. The pedimento PDF **has a selectable text layer** (verified with the sample in `~/Downloads`), and **page 1 alone contains 6 of the 7 import-data fields** plus everything `buildPedimento` needs. So step 1 uploads the PDF, and step 2 arrives **pre-filled from the extracted data**, editable.

Decisions made during brainstorming:
- **Full extraction + reconciliation (not a minimal extractor).** We build the extraction service **once** — the full pedimento (header + all partida lines) — and use it for both (a) the wizard pre-fill and (b) **Manifest ↔ Pedimento reconciliation**. This adopts the already-written-but-unbuilt plan `docs/superpowers/plans/2026-06-22-pedimento-reconciliation.md` as the foundation rather than building a throwaway header-only parser.
- **Extraction tiers:** deterministic **text-layer (A)** → **positional firm-up (B)** → **AI fallback (C)**, where C is gated off (`AI_PEDIMENTO_EXTRACTION=1`). The text layer is verified working on the sample; AI is opt-in for scanned pedimentos only.
- **Reconciliation is advisory** — matches by guía (`matched / mismatch / missing_in_pedimento / extra_in_pedimento`, diffs on value/name/RFC), never blocks the lock. Surfaced in **all 4 planned surfaces** (Seguimiento wizard, Consulta, detail drawer, XLSX) plus the wizard's cotejo step.
- **Lock timing:** **defer the lock to the final step.** Achieved structurally by not attaching `file_id` to the manifest until finalize — so no change to lock semantics or the two-tab logic is needed.
- **Prevalidación + cotejo:** the prevalidation step also shows the reconciliation report (build + structurally prevalidate + compare against the manifest before finalizing).
- **Pre-fill source:** the extracted **header** (pages 1–2) pre-fills the import-data form; per-partida data we already have from manifest ingestion (`shipment.data`) drives the "expected" side of reconciliation.

## Wizard steps (4, mirrors RegistroView's `Stepper`)

`['Subir pedimento', 'Datos de importación', 'Prevalidación y cotejo', 'Resultado']`

1. **Subir pedimento (PDF)** — drag/drop upload. Server runs the RF-08/RF-10 scan **and** full extraction (A→B, C-gated), persists the file blob, and returns `{ scan, extracted, reconciliation, tempFileId }` **without** setting `manifests.file_id`. `blocked` verdict stops the wizard; `clean`/`suspicious`/`unscannable` continue.
2. **Datos de importación** — the 7 fields, **pre-filled from `extracted.header`** (see field map), fully editable. Empty/low-confidence fields are flagged for the operator. Held in wizard state.
3. **Prevalidación y cotejo** — two panels:
   - **Prevalidación:** build the pedimento (`buildPedimento(shipments, opts)`) and prevalidate **without persisting**; show `APPROVED` / `REJECTED` + errors/warnings.
   - **Cotejo (reconciliation):** the `ReconciliationPanel` — pedimento vs manifest by guía (matched / mismatch / missing / extra, value/name/RFC diffs, advisory color). Advisory; does not block finalize.
   - On `REJECTED` or serious discrepancies the operator can go **Back** to step 2 (or re-upload).
4. **Resultado / Finalizar** — on confirm, the server atomically: attaches `file_id = tempFileId` + `pedimento_scan`, saves `import_data`, `pedimento` + `prevalidation`, and persists the `reconciliation` report (latest + history). The record locks (`file_id` present) and moves to the **"Con pedimento"** tab. Show the status badge + download links (PDF, report, reconciliation XLSX).

## Extraction field map (page 1, anchored text parse)

| Target | Source anchor | Notes |
|---|---|---|
| `pedimento` (numeroPedimento) | `NUM. PEDIMENTO` | strip spaces → 15 digits |
| `patente` | `PATENTE:` (línea de captura block) | |
| `agenteAduanal` | `NOMBRE O RAZ. SOC.:` (agente block, bottom) | |
| `fechaEntrada` | `FECHAS` → `ENTRADA` | `dd/mm/yyyy` → `yyyy-mm-dd` |
| `claveAduanaEntrada` | `ADUANA E/S:` | |
| `claveAduanaDespacho` | `CLAVE DE LA SECCIÓN ADUANERA DE DESPACHO:` | |
| `cveT1` | `CVE. PEDIMENTO:` | typically `T1` |
| `tasaImportacion` | **page 2 `PARTIDAS` table → `TASA` column, IVA row** | e.g. `19.000`; uniform across partidas |

**`tasaImportacion` IS extracted from the PDF** — confirmed against the real pedimento: the marked value is the **partida-level IVA rate (`19.000`)** in the page-2 PARTIDAS table (IGI is `0`). It is **not** the page-1 pedimento-level IVA (16%), nor a config-derived global rate (33.5%). The existing `tasa_vigencias` / `checkTasaConsistency` stays only as a **non-blocking consistency warning** against the captured value. The per-partida `contribuciones` stay `[]` (regla de no contribución, enforced by the prevalidator) — the TASA column carries the rate, not a declared contribution.

Per-partida (house guide, consignee, RFC, value) is also extracted (the `ExtractedPedimentoLine[]` via the OBSERVACIONES grammar) — used for **reconciliation**, not pre-fill. The "expected" side comes from `shipment.data`.

**Graceful degradation:** if a pedimento has no text layer (pure scan), the deterministic tiers return empty/low-confidence; pre-fill is skipped (operator types fields), reconciliation reports low confidence, and the AI tier (C) can be enabled per-deployment. No silent failure.

## Implementation

This unifies two bodies of work: **(I)** the reconciliation plan (`docs/superpowers/plans/2026-06-22-pedimento-reconciliation.md`, Tasks 1–11) and **(II)** the wizard. The implementation plan will weave them; below is the integrated shape.

### From the reconciliation plan (foundation — reuse, don't redesign)

1. **Observation grammar parser** — `parseObservation` next to `partidaObservation` (`shared/pedimento/observation.ts`), the reliable per-line anchor.
2. **Extraction types** — `ExtractedPedimento{Header,Line}`, `ReconciliationReport`, etc. in `shared/types/reports.ts`. **Wizard extension:** add the pre-fill fields to `ExtractedPedimentoHeader` (`patente`, `agentName`, `entryDate`, `customsEntryCode`, plus a representative `tasaImportacion` from the partida IVA row) — they are not in the plan's header today.
3. **Extraction service** — `server/src/services/pdfExtract/` (text layer A, positional firm-up B, AI fallback C-gated) returning `ExtractedPedimento`.
4. **Reconcile engine** — `shared/pedimento/reconcile.ts` (`buildExpectedFromManifest` + `reconcile`), pure + unit-tested.
5. **Migration** — `manifests.pedimento_reconciliation` JSONB + `pedimento_reconciliations` history table.
6. **Surfaces** — auto-run on upload, manual re-run endpoint, XLSX export, and the shared **`ReconciliationPanel`** rendered in Seguimiento + Consulta + detail drawer (the 4 surfaces).

### Wizard-specific additions / changes

7. **Scan + extract + reconcile endpoint (no attach)** — extend `pedimentoUpload.ts` (or `POST /api/manifests/:id/pedimento-pdf/scan`): validate PDF → `scanPedimentoPdf` → `extractPedimento` → `reconcile` → `saveFile(blob)`, return `{ scan, extracted, reconciliation, tempFileId }`. **Does not** set `manifests.file_id` (deferred lock). `blocked` → 422. *(In normal non-wizard upload, reconciliation still auto-runs per the plan; the wizard variant just withholds the attach.)*
8. **Prevalidate dry-run** — `POST /api/manifests/:id/pedimento/prevalidate` (or `?dryRun=1`): build + prevalidate, return without persisting.
9. **Finalize endpoint** — `POST /api/manifests/:id/pedimento/finalize` (transactional): set `file_id = tempFileId` + `pedimento_scan`, write `import_data`, `pedimento` + `prevalidation`, persist `pedimento_reconciliation` (+ history row), audit. Validates `tempFileId` is a `pedimento_pdf` file. `computeLock` then returns locked — unchanged semantics. *(Alternative — client orchestration of existing endpoints — rejected; one transactional endpoint avoids partial-finalize states.)*
10. **Modal size** — `Modal.tsx` add `size?: 'lg' | 'xl' | 'full'` (default `lg`) → `max-w-lg` / `max-w-4xl` / `max-w-6xl`.
11. **`PedimentoWizard.tsx`** — `useState(0)` + `Stepper` (RegistroView pattern). Props `{ recordId, open, onClose, onFinalized }`. State: file, scan, extracted, reconciliation, form, tempFileId, prevalidation. Reuses the dropzone + `ScanResultCard` (extracted from current `SeguimientoView`), the 7-field form grid, and the shared `ReconciliationPanel` in step 3.
12. **`SeguimientoView.tsx`** — row click in either tab opens `<PedimentoWizard>` (modal) instead of the inline cards; remove inline Block-2/Block-3. **"Con pedimento"** rows open the wizard in read-only/review mode (captured data + scan + reconciliation panel + PDF download). `onFinalized` → `loadList()`. Keep the two-tab queue + search as-is.

## Files

- **Reuse/extend (reconciliation plan):** `shared/pedimento/observation.ts` (+parser), `shared/types/reports.ts` (types; extend header), `server/src/services/pdfExtract/*`, `shared/pedimento/reconcile.ts`, migration `*_pedimento_reconciliation.ts`, `src/components/ReconciliationPanel.tsx`, XLSX export + endpoints.
- **New:** `src/components/PedimentoWizard.tsx`
- **Modify:** `server/src/routes/pedimentoUpload.ts` (scan+extract+reconcile, no-attach), `server/src/routes/pedimento.ts` (dry-run + finalize), `src/components/ui/Modal.tsx` (size), `src/components/SeguimientoView.tsx` (open wizard; drop inline cards)

## Verification

1. **Unit:** `parseObservation` round-trips + parses real lines; `parsePedimentoText`/extractor maps every header field (patente 1653, agente, fecha→2025-04-04, aduana 850, tasa 19.000) from the sample's extracted-text fixture; `reconcile` returns correct matched/mismatch/missing/extra on crafted inputs. (Fixtures only — never commit the 4MB PDF.)
2. **Backend:** scan+extract+reconcile returns `{scan, extracted, reconciliation, tempFileId}` and leaves `manifests.file_id` null; dry-run prevalidate doesn't persist; finalize sets file_id + import_data + pedimento + reconciliation and locks the record. Manual re-run + XLSX endpoints covered.
3. **Frontend:** `PedimentoWizard` renders the 4-step Stepper; step 2 pre-filled from a mocked `extracted.header`; step 3 renders `ReconciliationPanel` from a mocked report; a `SeguimientoView` row click opens the modal.
4. **End-to-end (browser):** Seguimiento → click a pending record → upload the sample pedimento → step 2 pre-filled (patente 1653, agente "MIGUEL ANDRES GUZMAN MORENO", fecha 2025-04-04, aduana 850, tasa 19.000) → step 3 shows prevalidación verdict **and** the cotejo (e.g. all guías matched, or flagged value/name diffs) → finalize → record moves to "Con pedimento"; reconciliation also visible in Consulta + drawer + downloadable XLSX.

## Re-check findings — corrections to the existing plan (must fix before building)

Pressure-testing the 2026-06-22 reconciliation plan against the real `MANIFEST_TEST.xlsx` surfaced a correctness bug and open questions:

1. **🔴 Reconcile aggregation bug.** `buildExpectedFromManifest` maps **one expected line per shipment** (`shipments.map(...)`), and `reconcile` keys actuals by **bare guía** (`new Map(actual.lines.map(l => [l.guia, l]))`). But one guía spans **multiple manifest rows** — in the fixture, guía `JMX600026618783` has 4 product rows (same consignee). So on real data: duplicate-guía expected lines all compare against one collapsed actual, per-product value (≈$6) vs the parcel total, and `partidaCount` 4-vs-1 — **all false mismatches**. The plan's tests only use one-product-per-guía ships, so the bug is latent.
   - **Fix depends on the true pedimento partida model (see open question).** If the pedimento aggregates per guía: `buildExpectedFromManifest` must **group by guía and sum `customsValueUsd`** (single consignee/RFC per guía; flag if they differ within a guía). If the pedimento keeps per-product lines: matching needs a **composite key** (guía + value/description), not bare guía. Either way the current bare-guía map is wrong for multi-product parcels. Add a multi-product-per-guía test.

2. **🟠 `buildPedimento` mirrors the same assumption** — it maps 1 partida per shipment (`shipments.map`). If real T1 pedimentos aggregate one partida per guía (generic fraction 99010001, summed value), the prevalidación step builds a structurally different pedimento than the one uploaded. Verify/align before relying on the prevalidación + cotejo comparison.

3. **🟠 `tasaImportacion` extraction needs the positional pass (Approach B).** The value lives in the page-2 PARTIDAS **table** (TASA column), not in the OBSERVACIONES grammar line that Approach A parses. So the header extension that captures `tasaImportacion` depends on B succeeding; under text-only/AI fallback it may be absent → leave blank + vigencia hint. Assumes a uniform rate across partidas (flag if mixed).

4. **🟡 `finalize` needs full `BuildOptions`, not just the 7 import-data fields.** `buildPedimento` requires `numeroPedimento`, `importer`, `agent`, `tipoCambio`, customs codes, and dates — sourced from extraction + the form. The finalize endpoint must assemble these (the `pedimento`/`t1` form fields aren't persisted by `/import-data` today), so the wizard must carry the extracted header through to finalize.

## Resolved — partida model + multi-pedimento

**One partida per guía** (parcel value), confirmed against two real subdivisiones (`5001684`, `5001685`): ~1189/1187 guías ≈ partida counts, fully disjoint between pedimentos. So `buildExpectedFromManifest` **aggregates manifest rows by guía** (sum value, one consignee/RFC per guía), and `reconcile` keys by guía against one partida per guía.

Also confirmed: **a manifest has N pedimentos (subdivisiones)** — see the dedicated restructure spec `2026-06-24-multi-pedimento-restructure-design.md`, which is **Phase 1** and precedes this wizard. Reconciliation here runs **per pedimento** (its subset of guías) and rolls up to manifest-level **coverage**. Scale is real (~1,190 guías/pedimento, ~3,500/manifest) — see that spec's Scale section (summary + exceptions UI; never render all rows).

## Suggested phasing (the implementation plan can sequence these)

- **Phase 1 — Extraction + reconciliation core:** observation parser, types, `pdfExtract` (A+B), `reconcile`, migration, auto-run on upload. (Largely the existing plan, Tasks 1–8.)
- **Phase 2 — Surfaces:** `ReconciliationPanel` in Consulta + drawer, manual re-run, XLSX. (Plan Tasks 9–12.)
- **Phase 3 — Wizard:** Modal size, `PedimentoWizard`, deferred-attach scan endpoint, dry-run prevalidate, finalize, `SeguimientoView` rewire — consuming the Phase-1 extraction header (pre-fill) + Phase-2 panel (cotejo).

## Resolved — `tasaImportacion` (T1)

Researched against RGCE 3.7.35 + the real pedimento + the `MANIFEST_TEST.xlsx` fixture (which carries **no** tax column).

**Rule (RGCE 3.7.35 "tasa global"):** the rate is determined by origin + value band + date vigencia — non-treaty (e.g. China) was 19% and became **33.5% on 15 Aug 2025** (4ta RM RGCE 2025); T-MEC: ≤$50 exempt, $50–117 = 17%, >$117 = 19%. The sample pedimento (04/04/2025, China) shows **19%**, consistent with the pre-Aug-2025 non-treaty rate.

**Design decision — capture, do not calculate.** Per PRD §10 (and the compliance audit that flags `src/engine/taxCalculator.ts` as a CRITICAL violation for deriving the rate from origin), the system must **read `tasaImportacion` from the pedimento**, not compute it from country. So:
- **Pre-fill** = the **partida IVA rate** from the page-2 PARTIDAS table (e.g. `19.000`). Extracted from the PDF.
- `tasa_vigencias` / `checkTasaConsistency` stays **only** as a non-blocking consistency warning (does the captured rate match what we'd expect for the date+origin?). Never auto-sets the value.
- **Edge case:** if partidas carry differing rates (mixed value bands), surface a warning rather than silently taking the first — the report's single "Tasa global o cuota aplicada" assumes a uniform rate, which holds for the simplified T1 procedure.
- **Fallback** (no text layer / tasa not found): leave blank and let the vigencia warning suggest the expected rate; operator types it.
