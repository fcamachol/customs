# Demo Reset — Design

**Date:** 2026-07-08
**Status:** Approved (user confirmed design in session)

## Purpose

When an instance runs as a demo, an admin can reset it to a clean database — deleting all
manifests and pedimentos — so every client demo starts from a pristine state. Simple, clean,
and impossible to trigger on a non-demo deployment.

## Safety gate

- New env var `DEMO_MODE`. The feature exists **only** when `DEMO_MODE=true`
  (string compare, same convention as `MFA_ENFORCEMENT`).
- When unset/false: the endpoint responds **404** (does not reveal its existence) and the UI
  renders nothing.
- The endpoint additionally requires role `admin` or `super_admin` — a capturista logged into
  a demo cannot reset it.
- The frontend learns the mode via a `demoMode: boolean` field added to the authenticated
  `GET /api/auth/me` response.

## Endpoint

`POST /api/admin/demo-reset` — one DB transaction:

1. Collect ids of `files` rows referenced by the pedimentos/artifacts about to be deleted
   (pedimento PDFs, generated reports/layouts) for post-commit blob cleanup.
2. `DELETE FROM manifests` — existing `ON DELETE CASCADE` FKs remove shipments, pedimentos,
   pedimento_scans, staging rows, and manifest history in the same statement.
   Manifest-derived rows **without** a cascade FK (monthly-history aggregates, risk
   incidences, orphaned `files` rows) are deleted explicitly — the implementer verifies each
   table's FK at build time.
3. Insert a `DEMO_RESET` audit event carrying the deleted counts
   (`{ manifests, pedimentos, shipments, files }`).

After commit: delete the orphaned PDF/report blobs from disk **best-effort** — failures are
logged and never fail the request, so a filesystem hiccup cannot leave the DB half-reset.

Response: `200 { deleted: { manifests, pedimentos, shipments, files } }`.

## What survives every reset

Users, clients, platforms, agentes aduanales / importadores catalogs, client header mappings,
compliance/ruleset configuration, validated RFCs, and the **audit log** (append-only hash
chain — deleting from it would break chain verification; a reset leaves a trace instead).

## UI

A "Modo demostración" card at the bottom of the Configuración view, rendered only when
`demoMode` is true **and** the user is admin/super_admin:

- Amber/red-bordered card matching the existing card kit.
- One button: **"Restablecer datos de demostración"**.
- Confirm modal: the destructive button stays disabled until the user types `BORRAR`.
- On success: toast with counts ("🔄 3 manifiestos y 5 pedimentos eliminados.") and a data
  refresh of the current view.

## Testing

- Route tests: 404 when `DEMO_MODE` unset; 403 for capturista; full cascade verified
  (manifests/shipments/pedimentos/scans gone; users/clients/catalogs/audit intact);
  `DEMO_RESET` audit event written with correct counts; file rows removed.
  Tests pin `DEMO_MODE` explicitly (same convention as `MFA_ENFORCEMENT` tests).
- Client tests: card hidden without the flag or role; type-to-confirm gate enables the
  button; success path fires the API call and toast.

## Operational notes

To demo on the production instance: set `DEMO_MODE=true` in Coolify, restart, demo, reset,
unset. A future dedicated demo app (own DB) uses this design unchanged.
