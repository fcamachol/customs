# Delete pedimentos from the capture wizard (steps 2–4)

**Date:** 2026-07-06
**Status:** Approved (Option A)

## Problem

Once a pedimento PDF is uploaded there is no way to remove it. Because the dedup
invariants are DB-enforced (global unique número, per-manifest guía-overlap gate reading
`pedimentos.covered_guias`), a wrong upload permanently blocks re-uploading the corrected
PDF. Users need to delete a pedimento from the capture wizard in the Capturar, Prevalidar
and Finalizar phases — any time before the pedimento is finalized (`sub_status = 'cargado'`).

## Decisions

- **Delete depth:** hard delete + audit record. Remove the `pedimentos` row, its scan rows,
  and its stored files (PDF and cached report, if any); write a `DELETE_PEDIMENTO` audit
  entry with a snapshot of the row. Deleting the row automatically frees both dedup gates.
- **Roles:** `admin` + `capturista` (same as finalize/reopen).
- **UI:** trash icon on each `PedimentoCard` header in steps 2–4 with an inline two-step
  confirm (no nested modal — the workspace intentionally removed nested modals).
- **Not deletable:** `sub_status = 'cargado'`. The API returns 409 (reopen first); the UI
  hides the trash button.

## API

`DELETE /api/pedimentos/:id` in `server/src/routes/pedimentoLifecycle.ts`, mirroring the
finalize/reopen route pattern:

1. `requireAuth`, `requireRole('admin', 'capturista')`.
2. Load `pedimentos` row joined to `manifests.created_by`; `404` if missing.
3. Ownership guard identical to finalize (`canSeeAll` check).
4. `409 { error }` if `sub_status = 'cargado'` — message tells the user to reopen first.
5. In a transaction: delete `pedimento_scans` rows for the pedimento's `file_id`, delete
   the `pedimentos` row, delete the `files` rows for `file_id` and `report_file_id` (if
   set). After commit, best-effort unlink the stored files from disk via a new
   `deleteFileById(fileId)` helper in `server/src/storage/files.ts` (DB row deleted in the
   transaction; disk unlink failures are logged, not surfaced).
6. `recordAudit({ action: 'DELETE_PEDIMENTO', entity: 'pedimento', entityId: id,
   before: { numeroPedimento, subStatus, coveredGuias, fileId, manifestId } })`.
7. Respond `200 { ok: true }`.

## Frontend

- `src/api.ts`: add `apiDelete(path)` if not present (same error-shape handling as `apiPost`).
- `PedimentoCard` (in `CaptureWorkspace.tsx`) gains an optional `onDelete?: () => Promise<void>`.
  When set, the header shows a trash icon button (right side, before the status pills, with
  `stopPropagation` so it doesn't toggle the accordion). Clicking swaps the header controls to
  an inline confirm: "¿Eliminar pedimento? **Eliminar** / Cancelar". While the DELETE is in
  flight the button shows a spinner/disabled state. Errors render as the existing red inline
  paragraph pattern under the header.
- `StackedPhase` passes `onDelete` for every card with `subStatus !== 'cargado'`, in all
  three phases (capturar / prevalidar / finalizar).
- After a successful delete: `refresh()` — the existing phase effect re-picks the active
  card, the "X de N listos" counter updates, the empty state appears if the list is now
  empty, and `onChanged` refreshes the parent queue's coverage badges.

## Testing

- **Server** (`server/src/routes/pedimentoLifecycle.delete.test.ts` or colocated with
  existing route tests, matching repo conventions): happy path removes pedimento + scans +
  files rows and writes the audit entry; same-número re-upload succeeds after delete
  (dedup freed); 409 on `cargado`; 404 on unknown id; 401/403 for unauthenticated /
  disallowed role. Fixtures must use distinct MAWB / número / guía values (DB-enforced
  uniqueness).
- **Frontend** (`CaptureWorkspace.test.tsx`): trash visible on cards in steps 2–4; hidden
  for `cargado`; confirm flow issues DELETE and refreshes the list; error path renders the
  message; accordion toggle not triggered by the trash click.

## Out of scope

- Deleting finalized (`cargado`) pedimentos (reopen first, then delete).
- Soft delete / undo.
- Deleting from step 1 (Subir) — the queue there is pre-insert client state.
