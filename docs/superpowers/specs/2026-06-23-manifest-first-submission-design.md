# Manifest-first submission flow — design

**Date:** 2026-06-23
**Branch:** feat/t1-compliance-sprint
**Scope:** `RegistroView` submission UX + a reusable quick-add client modal. No backend changes.

## Problem

Today `RegistroView` opens with one form: the operator manually types the **MAWB**
and a free-text **client name**, picks a file, and a single submit runs the whole
pipeline (upload → promote → risk).

Two problems:

1. The MAWB is **already in the file** (the `MWB` column, mapped to `core.mawb`).
   Typing it by hand is redundant and error-prone. In the real fixture
   (`MANIFEST_TEST.xlsx`) every one of the 500 rows carries the same value
   (`369-94705516`), so it can be extracted reliably.
2. The client is captured as **free text** even though clients are real entities
   (`clients` table, `GET/POST /api/catalogs/clients`, `POST /api/manifests/:id/client`).
   Free text means no link to the client overlay that feeds the ANAM report, and
   typos fragment the records list.

## Goal

Reorder the flow to be manifest-first: **upload → auto-extract MAWB (editable) →
pick a registered client (required) → run analysis**. Let the operator add a new
client inline via a modal without leaving the screen.

## Decisions (confirmed with user)

- **MAWB:** editable, pre-filled with the extracted value. Operator may override.
- **Client:** required before analysis can run.
- **Quick-add modal:** carries the **full set of ANAM-relevant client fields**
  (see below), `name` required, the rest optional — matching the existing
  `POST /api/catalogs/clients` validation. "Full client" admin management stays in
  Configuración → Clientes; there are no client fields beyond the ANAM set.

## Step sequence (new)

`RegistroView` Stepper becomes 4 steps:

| # | Step | Content |
|---|------|---------|
| 0 | **Cargar manifiesto** | File drop only. On file select, parse the workbook in-browser and extract the MAWB. |
| 1 | **Datos del manifiesto** *(new)* | Editable MAWB (pre-filled) + client dropdown + "+ Agregar cliente". "Realizar análisis" button. |
| 2 | **Análisis de riesgo** | Existing 7-validation checklist animation. |
| 3 | **Resultado** | Existing risk summary + table. |

### Step 0 → MAWB extraction (client-side)

`xlsx` is already a frontend dependency and `shared/` is already imported from the
frontend (`src/types/t1.ts`). New helper:

```
extractMawb(file: File): Promise<{ mawb: string | null; ambiguous: boolean }>
```

- Read the first sheet, take the header row, find the column where
  `resolveHeader(header) === 'core.mawb'` (reuses `shared/parsing/headerSynonyms`).
- Collect distinct non-empty values from that column.
  - exactly 1 → `{ mawb, ambiguous: false }`
  - 0 (no column / empty) → `{ mawb: null, ambiguous: false }`
  - >1 distinct → `{ mawb: null, ambiguous: true }`
- On `null`, the MAWB field stays empty and editable; on `ambiguous`, show a small
  hint that the file has multiple MWB values and the operator should confirm.

The `File` object is held in component state and only uploaded at final submit.
Because nothing is staged until submit, editing the MAWB is free (no re-staging).

### Step 1 → client picker + modal

- Dropdown sourced from `GET /api/catalogs/clients` (loaded on entering the view).
- "+ Agregar cliente" opens the modal. On successful create, refresh the list and
  auto-select the new client.
- "Realizar análisis" is **disabled** until both a non-empty MAWB and a selected
  client id are present.

## Server interaction on submit (existing endpoints, unchanged)

1. `POST /api/manifests` — FormData `{ file, mawbReference: <confirmed>, clientName: <selected client's name> }` → `{ manifestId, counts, ... }`.
   - `clientName` is still sent because `records.ts` and report search read the
     free-text `client_name` column for display/search.
2. `POST /api/manifests/:id/client` — `{ clientId }` → sets `client_id` and busts the
   report cache (`report_file_id = NULL`). This is the FK link the ANAM overlay uses.
3. `POST /api/manifests/:id/promote`, then `POST /api/manifests/:id/risk` → result.

If staging returns rows with errors (`counts.error > 0`), stop at the review step
exactly as today (operator fixes and re-uploads).

## Quick-add client modal — fields (ANAM data dependency)

The ANAM report (`shared/export/reportBuilder.ts`) consumes these client fields.
The modal must collect all of them; only `name` is required.

| Modal field | Client field | ANAM report column |
|---|---|---|
| Nombre / razón social * | `name` | Remitente Nombre/razón social |
| Id fiscal (RFC) | `tax_id` | Remitente Id fiscal |
| Domicilio | `address` | Remitente Domicilio |
| Teléfono | `phone` | Remitente Teléfono |
| Correo | `email` | Remitente Correo |
| Plataforma — Nombre comercial | `platform.commercialName` | Plataforma Nombre comercial |
| Plataforma — País de origen | `platform.countryOfOrigin` | Plataforma País de origen |
| Plataforma — Razón social | `platform.legalName` | Plataforma Razón social |
| Plataforma — Correo | `platform.email` | Plataforma Correo |

`*` required. POSTs to `POST /api/catalogs/clients` with the same body shape the
Configuración → Clientes form already uses.

## New / changed units

- `src/components/ui/Modal.tsx` *(new)* — small reusable overlay (no modal primitive
  exists yet). Backdrop, centered panel, `Esc`/backdrop close, focus on open.
  Exported from `src/components/ui/index.ts`.
- `src/lib/extractMawb.ts` *(new)* — the extraction helper above. Pure-ish; takes a
  `File`, returns the result object. Independently unit-testable.
- `src/components/AddClientModal.tsx` *(new)* — the ANAM client form inside `Modal`,
  POSTs and returns the created client to the caller.
- `src/components/RegistroView.tsx` *(changed)* — 4-step flow, extraction on file
  select, client dropdown + modal wiring, two-call submit (manifest then client),
  required-field gating.

## Error handling

- Extraction failure (corrupt file / parse throw) → treat as `mawb: null`, surface
  the existing "selecciona un archivo válido" path; operator can still type the MAWB.
- Client create error (duplicate / validation) → toast error, keep the modal open.
- Manifest staging errors → unchanged behavior (review step with rejected rows).
- Client-link call failure after a successful upload → surface the error and keep the
  operator on step 1 so they can retry the link before analysis.

## Testing

- `src/lib/extractMawb.test.ts` *(new)* — uniform single value, missing column,
  multiple distinct values (ambiguous), empty/garbage input.
- `src/components/RegistroView.test.tsx` *(update)* — extraction pre-fill on file
  select, analysis button disabled until MAWB + client set, modal create → auto-select,
  the two-call submit ordering (manifest → client → promote → risk).

## Out of scope / YAGNI

- No backend changes. Server-side MAWB derivation, schema changes, and joining
  `clients` in `records.ts` are explicitly not part of this work.
- Full client administration (edit/delete, richer fields) remains in Configuración.
