# Multi-Pedimento Phase 3 — Capture Wizard Design

> Phase 3 of the multi-pedimento (subdivisión) restructure. Consumes the Phase 1
> `pedimentos` (1:N) model + extraction service. Phase 2 (full per-line reconciliation
> field-diffs + the 4 surfaces) remains deferred and is **out of scope** here.

## Goal

Replace the flat inline per-subdivisión import-data form (`PedimentoCard` in
`src/components/SeguimientoView.tsx`) with a guided **modal capture wizard** that walks each
subdivisión through **pre-fill → capture → structural prevalidate → finalize**, backed by an
explicit, persisted lifecycle state machine.

## Scope

**In:**
- A persisted per-subdivisión lifecycle status with a guarded state machine.
- A 4-step modal wizard (single capture path) that drives those transitions.
- A correction to Phase 1 lock semantics so an uploaded source PDF no longer locks capture.

**Out (unchanged / later phases):**
- Full per-line reconciliation field-diffs (value/name/RFC) + the 4 surfaces — **Phase 2**.
- Real SAT/VUCEM transmission / FIEL·e.firma signing — externally blocked (F16 Track 2).
  `finalize`/`cargado` is an **operator attestation**, not a legal submission.
- Subdivisión-parser hardening against the PRIMERA sample (`5001668`) — separate follow-up.

## Lifecycle model (the foundation)

### Persisted state machine

Add column `pedimentos.sub_status` — enum `pendiente | capturado | prevalidado | cargado |
rechazado`, default `pendiente`. The **wizard is the sole writer**. A shared helper
(`shared/pedimento/subStatus.ts`) defines the allowed-transition table + guards and is reused by
every server writer so no route can bypass them.

| Transition | Trigger | Guard |
|---|---|---|
| `pendiente \| prevalidado \| rechazado → capturado` | import-data saved (a re-save from `prevalidado`/`rechazado` invalidates the prior prevalidación) | import-data non-empty; current status not `cargado` |
| `capturado → prevalidado` | dry-run prevalidación returns APPROVED | `prevalidation.status === 'APPROVED'` |
| `capturado \| prevalidado → rechazado` | prevalidación returns blocking errors | prevalidación ran and is non-APPROVED-blocking |
| `prevalidado → cargado` | operator clicks **Finalizar** | current status is `prevalidado` |
| `rechazado → capturado` | operator **Reopen**s to edit (no data change) | current status is `rechazado` |

`cargado` is terminal (locked); no transition leaves it.

Notes:
- A re-save of import-data while `prevalidado`/`rechazado` returns the row to `capturado`
  (data changed → prevalidación no longer authoritative). `cargado` is terminal (locked).
- "Dry-run" prevalidación **persists** the built pedimento + prevalidación result (as the Phase 1
  Task 9 route already does); "dry-run" means *non-final / reopenable*, not uncommitted.

### Backfill

Existing `pedimentos` rows get an initial `sub_status` derived from current signals:
prevalidación APPROVED → `prevalidado`; else import_data present → `capturado`; else `pendiente`.
(Mock dev data; `customs_test` may be reset freely.)

### Lock fix (Phase 1 correction)

In the Phase 1 model the pedimento PDF **creates** the subdivisión row (`file_id` set at
creation), so the current `computeLock` `file_id` arm locks import-data capture immediately after
upload — incompatible with a capture-after-upload wizard. The meaning of `file_id` flipped: it is
now the **source** document, not an end-of-flow finalization signal.

Revision: `computeLock` drops the `file_id` arm. Editing is **lifecycle-driven** — editable
unless `sub_status === 'cargado'`. (Prevalidación-APPROVED no longer hard-locks on its own; the
wizard reaches `cargado` via Finalizar, which is the lock point.) Update the callers — records
detail per-row lock, the capture-route guard, reports/exports lock, the promote gate — and migrate
the one Task 8 test that asserts the old "PDF attached → locked" behavior.

## Backend

Minimal new surface — extend existing routes, add two small endpoints. All transitions go through
the shared state-machine helper; all mutating routes keep `requireRole('admin','capturista')`,
audit, and per-row access checks consistent with Phase 1.

- **Capture** `POST /api/pedimentos/:id/import-data` (extend Task 8) — on save advance
  `pendiente|rechazado → capturado`; a re-save from `prevalidado` returns to `capturado`.
- **Prevalidate** `POST /api/pedimentos/:id/pedimento` (extend Task 9) — builds over the
  subdivisión's `covered_guias` subset; APPROVED → `prevalidado`, blocking → `rechazado`.
- **Finalize** `POST /api/pedimentos/:id/finalize` (new) — guard `prevalidado` → set `cargado` +
  lock; audit `FINALIZE_PEDIMENTO`.
- **Reopen** `POST /api/pedimentos/:id/reopen` (new) — guard `rechazado` → `capturado`; audit
  `REOPEN_PEDIMENTO`. (`cargado` is terminal — no reopen.)
- **`computeLock` revision** — as above; signature takes the pedimento row incl. `sub_status`.
- Records list/detail expose `subStatus` per subdivisión for the work queue.

## Frontend

**Modal wizard** (`src/components/`) replaces the inline `PedimentoCard` form — 4 steps with a
progress header, clean/minimal styling (cool-neutral, flat, per project design preference):

1. **Revisar extracción** — read-only parsed data: número, subdivisión ordinal / última, guías
   cubiertas, master guide.
2. **Capturar datos** — the 7 import-data fields (tasa, fecha entrada, clave T1, agente, patente,
   aduana entrada, aduana despacho), pre-filled from extraction where `parsePedimentoText` provides
   a value, else from prior import_data; preserves the §10 `tasaWarning` display + optimistic
   version handling. Save → `capturado`.
3. **Prevalidar** — run prevalidación; show APPROVED / WARNINGS / errores → `prevalidado` or
   `rechazado`; Reopen path from `rechazado`.
4. **Finalizar** — summary + confirm → `cargado`.

**Entry** — each subdivisión row gets a **Capturar / Continuar** button (label by `sub_status`);
the wizard **auto-opens after that subdivisión's PDF upload**. A **status chip** per subdivisión
appears across the work queue; Seguimiento **Completados = `cargado`**, Pendientes = the rest.

## Testing & constraints

- State-machine guard unit tests (every allowed + rejected transition).
- Endpoint tests: each transition, guard rejections, `computeLock` revision, finalize/reopen.
- Backfill-migration test (each derivation branch).
- Wizard component tests (step navigation, pre-fill, status advance, lock-disabled terminal state).
- Both suites green at **every** commit (root `npx vitest run` + `cd server && npm test`); lint +
  `tsc --noEmit` clean. Clean per-domain commits, `git add <explicit paths>` only. Migration
  timestamp continues after `1700002900000` → next free `1700003000000`.

## Open follow-ups (not this phase)

- Phase 2: per-line reconciliation field-diffs + the 4 surfaces.
- SAT/VUCEM transmission + FIEL·e.firma (F16 Track 2, externally blocked).
- Subdivisión-parser hardening (PRIMERA sample `5001668`).
- autoridad file-export PII masking decision (tracked in `docs/MULTI_PEDIMENTO_PHASE1_FOLLOWUPS.md`).
