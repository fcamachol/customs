# Multi-Pedimento Phase 1 — Back Half (REVISED, no-shortcuts full migration)

> Supersedes Tasks 7–10 of `2026-06-24-multi-pedimento-phase1.md`. Tasks 1–6 (foundation: parsers, coverage engine, types, status, `pedimentos` table, extraction service) are DONE and committed on branch `worktree-multi-pedimento-phase1`.
> REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkbox steps.

**Why revised:** the original back half (upload + records + SeguimientoView) under-scoped the migration. The columns being dropped (`manifests.{file_id, pedimento, prevalidation, pedimento_scan, import_data, import_data_version}`) are read/written by **11 server files + 3 frontend files**. A clean drop requires migrating the whole surface.

## Architecture decision (no shortcuts)

1. **All pedimento-scoped data lives on `pedimentos` rows.** No transitional dual-write to the manifest columns — each domain does a clean cutover.
2. **Reports/artifacts are per-pedimento.** Each subdivisión is its own customs submission: its own **Reporte General + Layout + pedimento PDF + `report_file_id`**, built over that pedimento's `covered_guias` shipment subset + its own `import_data`. `report_file_id` moves to the `pedimento` row.
3. **Risk stays per-manifest** (shipment-scoped, pedimento-independent). `risk_file_id`/`risk_stale` stay on `manifests`. `import_data` changes bust only the affected pedimento's report — `risk_stale` no longer keys on import_data.
4. **Clean cutover per task:** each task migrates one data domain end-to-end (writer + reader + frontend + tests in one commit) so the suite stays green at every commit. **Mock dev data** — no backfill-preservation constraints; reset `customs_test` freely.
5. **Column drop is the final task.**

## Global constraints (carry over)

- Reuse `computeCoverage`/`computeSeguimientoStatus` (`shared/pedimento/`), `normPedimentoNumero` (`shared/pedimento/subdivision.ts`), `extractPedimento` (`server/src/services/pdfExtract`), `buildReportRows` (`server/src/services/reportData.ts`), existing `saveFile`/`computeLock`.
- `git add <explicit paths>` only — never `git add -A` (worktree has symlinked node_modules + gitignored `.superpowers/`).
- Run `npx vitest run` (root) + `cd server && npm test` green after each task. `npm run lint` (root) + `cd server && npx tsc --noEmit` clean.
- Migration timestamps continue from `1700002700000_pedimentos_table` → next free is `1700002800000`.

## Consumer map (the full surface to migrate)

| File | Uses today | Cutover |
|---|---|---|
| `services/manifestLock.ts` | `computeLock({prevalidation,file_id})` | call per `pedimentos` row (signature unchanged) |
| `routes/pedimentoUpload.ts` | writes `manifests.file_id`,`pedimento_scan` | INSERT a `pedimentos` row + gates |
| `routes/records.ts` | list status, detail `pedimento/prevalidation/file_id/import_data/lock/artifacts` | list→coverage; detail→`pedimentos[]`+`coverage` |
| `routes/importData.ts` | r/w `manifests.import_data`,`import_data_version` + lock | key by `:pedimentoId` → `pedimentos` |
| `routes/pedimento.ts` | build+prevalidate → `manifests.pedimento/prevalidation` | per pedimento (over `covered_guias`) |
| `services/reportData.ts` | `buildReportRows(manifestId)` reads `m.import_data` | `buildReportRows(pedimentoId)` over its shipment subset + its `import_data` |
| `routes/reports.ts` | `GET /:id/reports.json` per manifest | per pedimento (report+layout); risk stays manifest |
| `routes/exports.ts` | `manifests.report_file_id` cache | `pedimentos.report_file_id` |
| `routes/risk.ts` | `risk_stale=(import_data changed)` | detach from import_data |
| `routes/dashboard.ts` | counts referencing pedimento cols | recompute from `pedimentos` |
| `src/components/SeguimientoView.tsx` | inline capture/upload, locked split | coverage tabs + per-pedimento upload+capture sub-list |
| `src/components/ConsultaView.tsx` | per-manifest artifacts | per-pedimento artifacts list |

---

### Task 7 — Attachment + coverage cutover (file_id, scan, lock, records)

**Files:** `routes/pedimentoUpload.ts`, `services/manifestLock.ts`, `routes/records.ts`; tests `test/routes/pedimentoUpload.test.ts`, `test/routes/records.test.ts`; frontend `src/components/SeguimientoView.tsx` + `ConsultaView.tsx` (pedimento PDF now from `pedimentos[]`); tests for both.

**Cutover (one commit, green):**
- `pedimentoUpload`: scan → `extractPedimento` → **hard-gate** parsed `masterGuide` vs `manifests.mawb_reference` (400) → reject duplicate `numero_pedimento` in this manifest's `pedimentos` (409) → `saveFile` → INSERT a `pedimentos` row (file_id, numero_pedimento, master_guide, subdivision_ordinal, is_last_subdivision, sibling_numeros, bultos, peso_bruto_kg, covered_guias, pedimento_scan). Response includes a non-blocking guía-subset warning (coveredGuias ⊄ manifest shipment guías). **Stop writing `manifests.file_id`/`pedimento_scan`.**
- `manifestLock.computeLock`: unchanged signature; callers pass a `pedimentos` row.
- `records` list `GET /`: compute `coverageStatus`/`expectedCount`/`uploadedCount` via `computeCoverage(manifest shipment guías, pedimentos rows)`. Remove the old manifest-column status derivation.
- `records` detail `GET /:id`: add `pedimentos: [{id,numeroPedimento,subdivisionOrdinal,isLast,fileId,scanVerdict,lock,coveredGuias}]` + `coverage`. Derive `artifacts.pedimentoPdf` per pedimento. (Leave legacy top-level `importData/pedimento/prevalidation` on the response for now — they still come from manifest columns, migrated in Tasks 8–9.)
- Frontend: SeguimientoView → relabeled **Pendientes/Completados** tabs filtered by `coverageStatus`, coverage chip per row, pedimentos sub-list (per-pedimento upload control + status). ConsultaView → list each pedimento's PDF.
- Tests updated to the new shapes; suite green.

---

### Task 8 — import_data cutover (per-pedimento capture)

**Files:** `routes/importData.ts` (→ `POST /api/pedimentos/:pedimentoId/import-data`, r/w `pedimentos.import_data`+version, per-pedimento `computeLock`), `routes/records.ts` (detail `pedimentos[]` include `importData`/`importDataVersion`/`lock`), `src/components/SeguimientoView.tsx` (per-pedimento capture form in the sub-list); tests `test/routes/importData.test.ts`, `records.test.ts`, `SeguimientoView.test.tsx`.

**Cutover:** import_data read/written only on `pedimentos`. Stop writing `manifests.import_data`. (Reports still read `manifests.import_data` until Task 10 — so to keep reports green, Task 10 lands before/with the report cutover; sequence Task 8 to also leave manifest.import_data readable OR do Task 8+10 reports together. Decision: **fold the report read-switch into Task 10** so import_data has exactly one reader after Task 8 — none until Task 10 — meaning Task 8 must keep `manifests.import_data` in sync is a shortcut; instead Task 8 lands together with Task 10's reportData switch as one commit if tests demand.) **Implementer note:** run `reports`/`exports` tests after Task 8; if red because `buildReportRows` reads `manifests.import_data`, pull the `reportData` import_data read-switch into this commit.

---

### Task 9 — pedimento build + prevalidación cutover

**Files:** `routes/pedimento.ts` (`POST /api/pedimentos/:pedimentoId/pedimento` or keep manifest route but operate per pedimento; build over the pedimento's `covered_guias` shipment subset; write `pedimentos.pedimento/prevalidation`), `services/manifestLock.ts` (prevalidation now per pedimento), `records.ts` detail (`pedimentos[].prevalidation`); tests `test/routes/pedimento.test.ts`, `records.test.ts`. Stop writing `manifests.pedimento/prevalidation`.

---

### Task 10 — Reports/exports per-pedimento

**Files:** `services/reportData.ts` (`buildReportRows(pedimentoId)`: shipments WHERE `guideId = ANY(covered_guias)` + `pedimentos.import_data` + client/platform overlay), `routes/reports.ts` (`GET /api/pedimentos/:pedimentoId/reports.json` for report+layout; risk endpoint stays per-manifest), `routes/exports.ts` (`pedimentos.report_file_id`; xlsx per pedimento), `routes/risk.ts` (`risk_stale` detached from import_data), `routes/dashboard.ts` (recompute), migration `1700002800000` to add `pedimentos.report_file_id`; frontend `ConsultaView.tsx`/`ReportTabs` per-pedimento artifacts; tests across `reports`/`exports`/`artifacts`/`reportPlatform`/frontend. Largest task — may split per-endpoint if review prefers.

---

### Task 11 — Drop manifest pedimento columns

**Files:** migration `1700002900000_drop_manifest_pedimento_columns.ts` (drop `file_id, pedimento, prevalidation, pedimento_scan, import_data, import_data_version`; `report_file_id` already moved in T10).
- **Step 1:** `grep -rnE "m\.(file_id|pedimento|prevalidation|pedimento_scan|import_data)\b|manifests SET (file_id|pedimento|import_data|pedimento_scan)" server/src` → expect none; fix stragglers.
- **Step 2:** write the drop migration (reversible `down` re-adds the columns).
- **Step 3:** reset `customs_test` (mock data), run `cd server && npm test` + root `npx vitest run` → both green.
- **Step 4:** commit.

## Self-review checklist (run after writing each task's code)
- Every consumer-map row migrated before Task 11.
- No `git add -A`; no node_modules/.superpowers tracked.
- Reports built over the pedimento's `covered_guias` subset (not all manifest shipments).
- Per-pedimento lock everywhere `computeLock` is called.

## Open follow-ups (Phase 2/3, unchanged)
- Per-line reconciliation field-diffs + 4 surfaces; the modal capture wizard; harden subdivisión parser on a PRIMERA sample (`5001668`).
