# Multi-Pedimento (Subdivisión) Restructure — 1:N manifest↔pedimento + coverage

## Context

A manifest (one master air-waybill) can be cleared as **several pedimentos** — *subdivisiones* of the master guide under Art. 65 RLA. The sample pedimento confirms it: it is the *"SEGUNDA SUBDIVISION DE LA GUIA MASTER NO. 369-94268462 … SE RELACIONA CON LOS PEDIMENTOS 25 85 1653 5001668 Y 25 85 1653 5001685"* — i.e. master `369-94268462` → at least 3 pedimentos (`5001668`, `5001684`, `5001685`).

Today pedimento data is stored **strictly 1:1** as columns on `manifests` (`pedimento`, `prevalidation`, `import_data`, `import_data_version`, `file_id`, `pedimento_scan`). This restructure makes it **1:N** and adds **coverage** tracking.

**Why this comes first:** the capture **wizard** and **full reconciliation** (separate later phases) must be 1:N-native. Building them against the 1:1 model guarantees immediate rework, so we restructure the data model + status + lock first.

Decisions locked in brainstorming:
- **1:N restructure first**, then full reconciliation (Phase 2), then the capture wizard (Phase 3).
- **Hybrid completeness:** guía **coverage is authoritative**; the parsed sibling list (`SE RELACIONA CON` + ordinal) drives "N of M" UX and early missing-subdivisión detection; bultos/master-guide cross-checks; coverage-only fallback if the free-text parse fails.

## Scope

**In (this phase):**
- `pedimentos` table (1:N) + additive migration + backfill of existing 1:1 data.
- Extraction of the **coverage subset** from a pedimento PDF: master guide, per-partida guías (OBSERVACIONES grammar), subdivisión ordinal + sibling pedimento numbers + bultos (anexo parser), `numeroPedimento`.
- Pedimento↔manifest linking by master guide.
- **Coverage engine** (which guías each pedimento covers; union vs the manifest; gaps/overlaps).
- **Coverage-aware status** (replaces the just-shipped binary) + Seguimiento two-tab update.
- **Per-pedimento lock**; manifest-level "finalized" = all expected subdivisiones done + full coverage.

**Out (later phases):** full per-line reconciliation field-diffs (value/name/RFC) + the 4 surfaces (Phase 2); the modal capture wizard with pre-fill/prevalidate/finalize (Phase 3). Both consume this phase's model + extraction service.

## Data model

New table (additive):
```
pedimentos(
  id uuid pk,
  manifest_id uuid fk → manifests on delete cascade,
  numero_pedimento text,            -- 15-digit, from the PDF
  master_guide text,                -- from the PDF; cross-checked vs manifest.mawb_reference
  subdivision_ordinal int null,     -- 1,2,3… parsed from "PRIMERA/SEGUNDA/TERCERA…"
  is_last_subdivision bool null,    -- parsed "Y ULTIMA" → total count = ordinal
  sibling_numeros text[] null,      -- parsed "SE RELACIONA CON LOS PEDIMENTOS …"
  bultos int null,                  -- consolidated cartons (NOT parcel count)
  peso_bruto_kg numeric null,       -- this subdivisión's gross weight
  file_id uuid fk → files,
  pedimento jsonb,                  -- built Pedimento (header + partidas)
  prevalidation jsonb,
  pedimento_scan jsonb,
  import_data jsonb,
  import_data_version int default 0,
  covered_guias text[],             -- guías this pedimento declares (from OBSERVACIONES)
  reconciliation jsonb,             -- per-pedimento report (Phase 2)
  created_by uuid fk → users,
  created_at timestamptz default now()
)
```
- **Linking (defense in depth):** a pedimento is uploaded under the **explicitly selected** manifest/record (intent), **and** the parsed `master_guide` must **match the manifest's `mawb_reference` — a hard gate** (reject on mismatch). Two further guards: reject a **duplicate** `numero_pedimento` already attached to the manifest, and **warn** if the pedimento's `covered_guias` aren't a subset of the manifest's guías. Explicit selection + automated gate together minimize wrong-attachment errors.
- **Migration/backfill (superseded — see revised back half):** create `pedimentos` + backfill **one row per manifest** that has pedimento data (additive, no drops). The **column drop happens LAST**, after every consumer (11 server + 3 frontend files) is migrated to `pedimentos` via a clean per-domain cutover — NOT in the backfill migration. *(The earlier "single-step drop in the same migration" idea was dropped once the full consumer surface was mapped: a same-migration drop would break the reports/exports/risk layer mid-migration. Dev data is mock, so no data-preservation constraint.)* Manifest keeps `mawb_reference` (master guide) + shipments. See `docs/superpowers/plans/2026-06-24-multi-pedimento-phase1-backhalf.md`.
- **Reports/artifacts are per-pedimento** (decided during execution): each subdivisión is its own customs submission — its own Reporte General + Layout + pedimento PDF + `report_file_id` (which moves to the `pedimento` row), built over that pedimento's `covered_guias` shipment subset + its own `import_data`. **Risk stays per-manifest** (shipment-scoped). Detailed in the revised back-half plan.

## Coverage model

- Each shipment carries a guía (`guideId`); each pedimento declares a set of `covered_guias` (from its partidas' OBSERVACIONES grammar).
- **Coverage map:** for each manifest guía → the set of pedimentos covering it. **Complete** when every manifest guía is covered by **exactly one** pedimento. Flags: `uncovered` (0 pedimentos) and `duplicated` (>1). *(Empirically validated: two real subdivisiones of master `369-94268462` cover fully disjoint guía sets — 1189 and 1187 guías, zero overlap.)*
- **Hybrid completeness:**
  - *Authoritative* = guía coverage (every guía covered exactly once).
  - *Expected set* = `{self ∪ sibling_numeros}` from the parsed ordinal + `SE RELACIONA CON` list, plus the **`ULTIMA` marker** ("TERCERA Y ULTIMA SUBDIVISION" ⇒ total = 3). Enables "subdivisión 2 de 3 — falta 5001668" and early detection; sibling sets are **mutually consistent across uploaded pedimentos** (both samples agree on {5001668, 5001684, 5001685}) — union/cross-validate them.
  - *Cross-checks:* master guide matches the MWB; sibling-set consistency; (optional) Σ pedimento `pesoBrutoKg` ≈ manifest total weight.
  - **⚠️ Do NOT use bultos as a parcel/guía count** — `bultos` = consolidated cartons (34 / 19), not parcels (1189 / 1187 guías). Coverage is by guía union only.
  - *Fallback:* if the anexo parse fails (template variance / no text layer), use coverage-only — lose "N of M" labeling, keep authoritative completeness.

## Status (replaces the binary)

The just-shipped `shared/pedimento/seguimientoStatus.ts` becomes **manifest-level + coverage-aware**:
- `sin_pedimento` — 0 pedimentos.
- `parcial` — ≥1 pedimento but coverage incomplete (uncovered guías) or expected set incomplete.
- `completo` — all expected subdivisiones uploaded **and** full single coverage.
- Each pedimento keeps a per-row sub-status (`pendiente/capturado/rechazado/prevalidado/cargado`).
- **Two-tab queue (relabeled):** **"Pendientes"** = `sin_pedimento ∪ parcial` (work remaining), **"Completados"** = `completo`. ("Sin/Con pedimento" is retired — partial *has* pedimentos but still belongs in the work lane.) Rows show a **coverage meter / "2 de 3" chip** + an uncovered/duplicated warning; **partial sorts above untouched** (closer to done = more urgent). A 3rd "Parcial" tab was rejected — it fragments the "what do I still owe?" queue.
- **Master-detail:** clicking a record opens its **pedimentos sub-list** (master → N subdivisiones) with the coverage state. Tabs filter the queue; the per-record view is where the 1:N is surfaced.
- Update `SeguimientoView.tsx`, the records list/detail status fields, and the helper's tests.

## Scale & performance (from real samples)

Each pedimento is **~1,190 parcels across ~240 pages**; a manifest is **~3,500+ guías** across its subdivisiones.
- **Extraction:** parse the **OBSERVACIONES grammar (text-layer, Approach A)** for the per-guía lines (guía/value/name/RFC) — cheap, sufficient for coverage + line reconciliation. Reserve the heavy **positional pass (B)** for the few header/table fields (tasa, fracción) only. Run extraction server-side on upload behind a spinner; cache the parsed result on the pedimento row (don't re-parse the PDF for every read).
- **Reconciliation:** set-based over thousands of guías — fine; build a `Map` keyed by guía once.
- **UI:** never render ~1,190 rows. `ReconciliationPanel` shows a **summary (counts + color)** and only **exceptions** (mismatch / uncovered / duplicated), paginated/filterable. Full detail goes to the XLSX export.

## Lock

`computeLock` moves **per-pedimento** (its own `file_id`/`prevalidation`). A pedimento's `import_data` is editable until that pedimento is finalized. Manifest-level "finalized" = all expected subdivisiones finalized + full coverage.

## Files

- **shared:** `pedimento/seguimientoStatus.ts` (coverage-aware + tests), new `pedimento/coverage.ts` (+tests), `pedimento/observation.ts` (+`parseObservation`), new `pedimento/subdivision.ts` (anexo parser: ordinal/siblings/master/bultos, +tests), types in `types/reports.ts`.
- **server:** migration `*_pedimentos_table.ts` (+ backfill) and a later column-drop migration; `services/pdfExtract/*` (coverage subset); routes — `records.ts` (list/detail aggregate pedimentos + coverage status), pedimento upload creates/updates a **pedimento row** (not manifest columns), `manifestLock.ts` per-pedimento.
- **src:** `SeguimientoView.tsx` (coverage meter + status), records types.
- **reports:** note that report builders must aggregate across pedimentos (wired in a later phase).

## Verification

1. **Migration:** backfill creates exactly one pedimento row per manifest that had pedimento data; no data loss; reads switch over; existing records-route + reports tests stay green.
2. **Unit — coverage:** `coverage.ts` over crafted inputs: full single coverage → complete; an uncovered guía → parcial; a guía in two pedimentos → duplicated flag.
3. **Unit — subdivisión parser:** against the sample's extracted-text fixture — ordinal `SEGUNDA`, siblings `[5001668, 5001685]`, master `369-94268462`, bultos `34`; tolerant of `, `/` Y ` separators and >2 siblings; returns nulls (not throw) on non-matching text.
4. **Unit — status:** `seguimientoStatus` returns sin/parcial/completo correctly from a pedimento set + coverage.
5. **Backend:** records list returns the manifest-level coverage status + per-pedimento rows; uploading a 2nd pedimento to a manifest yields `parcial` until coverage completes.
6. **Frontend:** Seguimiento two-tab shows a partial manifest with a "2 de 3" coverage badge; clicking shows its pedimentos.

## Resolved

1. **Tabs:** 2 tabs, relabeled **Pendientes** (sin + parcial) / **Completados**, with coverage chip + partial-sorts-first + per-record pedimentos sub-list. No 3rd tab.
2. **Column drop:** ~~single-step~~ **SUPERSEDED** — additive backfill first, then drop the columns as the **final** task after all 11 server + 3 frontend consumers are migrated (clean per-domain cutover). A same-migration drop would break the reports/exports/risk layer mid-migration. See the revised back-half plan.
3. **Upload association:** explicit manifest selection **+ hard master-guide match gate** + duplicate-`numeroPedimento` reject + guía-subset warning.

## Validated against real samples (2026-06-24)

Two subdivisiones of master `369-94268462` (`5001684` SEGUNDA, `5001685` TERCERA Y ULTIMA) confirmed:
- Disjoint guía coverage (1189 + 1187 guías, zero overlap) → coverage-by-guía model holds.
- One partida per guía (parcel value) → `buildExpectedFromManifest` aggregates manifest rows by guía. **(Earlier open question resolved.)**
- Robust expected-set signals: ordinal + `Y ULTIMA` + mutually-consistent sibling lists.
- `bultos` is cartons, not parcels → removed from cross-checks.

## Still open (not blocking design)

- Hardening the anexo parser for **>2-sibling separators** and PRIMERA/CUARTA+ ordinals would benefit from one more sample (e.g. pedimento `5001668`, the PRIMERA we don't have). Working grammar is defined from the two samples; treat with a confidence flag + coverage-only fallback.
