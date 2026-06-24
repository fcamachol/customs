# Multi-Pedimento Phase 1 — Follow-ups

Tracking doc for non-blocking items deferred from the per-pedimento (subdivisión)
restructure (merged to `main` 2026-06-24, merge commit `d5fc654`). All items below were
reviewed and triaged as **acceptable-as-follow-up** by the final whole-branch review; none
block the merge. Phase 1 is complete and both suites are green.

## Decisions made at merge (recorded, no action this phase)

- **autoridad file-export PII masking** — *Decision: file follow-up ticket (this doc).*
  The xlsx file exports (`GET /api/pedimentos/:id/layout.xlsx`, `report.xlsx`) serve
  **unredacted** consignee PII to the read-only `autoridad` role, while the JSON report
  endpoint (`/api/pedimentos/:id/reports.json`) masks PII for `autoridad` unless explicitly
  revealed. This asymmetry is **pre-existing** (identical to the pre-migration manifest-level
  handlers) — the migration only moved the handlers, it did not change who-sees-what. The
  per-pedimento reshuffle made the "JSON masks / file does not" inconsistency more conspicuous
  (the two now sit one route-prefix apart). **Open question for compliance:** should file
  exports also redact PII for `autoridad` (matching the JSON endpoint), or is the file-export
  path a deliberate higher-trust carve-out? Fix, if chosen, is to apply the same `redactRows`
  + `reveal`-query gating to the xlsx handlers in `server/src/routes/exports.ts`.

- **Subdivisión upload-zone UX** — *Decision: keep always-open (no change).*
  The manifest's "Agregar pedimento PDF" upload zone stays available regardless of any
  sibling subdivisión's prevalidation/APPROVED state — correct for the 1:N model (a sibling
  being APPROVED should not block adding the next subdivisión). Each pedimento's own capture
  form locks correctly once its PDF is attached. No code change; recorded for clarity.

## Reviewer-triaged acceptable follow-ups (quality/hardening)

- **EXPORT_LAYOUT / EXPORT_REPORT audits** are awaited-before-send but not *fail-closed*
  (no try/catch + `next`), matching the pre-existing `risk.xlsx` pattern. The higher-value
  per-pedimento **JSON** PII endpoint *is* fail-closed. (`server/src/routes/exports.ts`)
- **Theoretical TOCTOU** in `reports.ts` per-pedimento lock-select: pedimento deleted between
  access-resolve and lock-select → `computeLock(undefined)` → default editable lock, no crash,
  no leak. Practically unreachable.
- **`PedimentoCard` version state** (`src/components/SeguimientoView.tsx`) uses lazy `useState`
  init from props; could drift from prop on refresh. Masked today because `loadDetail` rebuilds
  `pedimentos[]` and the cards remount. Harden with a `key={p.id}` reset or `useEffect` sync.
- **Missing tests** (both low-risk, code paths already exercised indirectly):
  - frontend test for the `tasaWarning` banner display (backend proves the field is returned).
  - `pedimento.test.ts` case for `covered_guias` non-empty but no matching shipment (→ 400;
    funnels through the same `if (!subset.length)` guard as the tested empty/null cases).
- **Duplicate null-numero pedimentos rows**: two unparseable PDFs each insert a row with
  `numero_pedimento = NULL` (no data loss; tied to PDF-parse reliability — Phase 2/3 hardening).
- **Dead-type already removed** during final fixes; noting that `computeSeguimientoStatus` was
  removed (replaced by `computeCoverage`); `SeguimientoScanVerdict` type retained.

## Phase 2/3 (carried over from the original plan — unchanged)

- Per-line reconciliation field-diffs + the 4 surfaces.
- The modal capture wizard (the new capture UX; `import_data` already moved to `pedimentos`).
- Harden the subdivisión parser against a PRIMERA sample (`5001668`).
