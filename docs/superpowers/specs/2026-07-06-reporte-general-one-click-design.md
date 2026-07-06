# Reporte General — one-click generation

**Date:** 2026-07-06
**Status:** Approved

## Problem

The Reporte General page (`src/components/ReporteGeneralView.tsx`) makes the user re-enter
data the system already has:

- Two form cards — "Datos del Remitente" (5 fields) and "Datos de la Plataforma" (4 fields) —
  are dead code: their state is collected but never sent. The server builds those report blocks
  from the clients catalog (`clientOverlay` in `server/src/services/reportData.ts`).
- Cliente/plataforma must be re-picked on every visit even when the manifest already has
  `client_id`/`platform_id` set (via `POST /api/manifests/:id/client`).
- The report rows themselves need no input at all: `import_data` is auto-prefilled from the
  pedimento PDF on upload (`server/src/routes/pedimentoUpload.ts`), and risk, shipments,
  validated RFCs, and the client overlay are all server-side.

## Goal

Happy path: **search → click record → click "Generar Reporte"**. Dropdowns appear only for a
manifest that has never been associated with a platform.

## Changes

### Backend

`GET /api/records/:id` (`server/src/routes/records.ts`) additionally returns `clientId` and
`platformId` from the manifests row. No other endpoint changes.

### Frontend — `ReporteGeneralView.tsx`

1. **Remove** the "Datos del Remitente" and "Datos de la Plataforma" cards and all their state.
2. **On record select**, fetch the record detail:
   - Manifest already associated (`clientId` + `platformId` present) → render a read-only
     summary ("Cliente: X · Plataforma: Y") with a "Cambiar" link that reveals the dropdowns.
     "Generar Reporte" is enabled immediately.
   - Not associated → show the cascading Cliente/Plataforma dropdowns as today, pre-selecting
     the catalog client whose name matches the manifest's `clientName` (best-effort).
3. **"Generar Reporte"** only POSTs `/api/manifests/:id/client` when the user changed the
   association; then downloads `report.xlsx` per pedimento exactly as today.

### Out of scope

Capture workspace, report builder, report/layout endpoints, Consulta view. The report content
is already correct and prefilled; this change is purely about removing redundant input.

## Testing

- `ReporteGeneralView.test.tsx`:
  - Pre-associated manifest → summary line shown, no dropdown interaction needed, download
    fires without the client POST.
  - Unassociated manifest → dropdowns appear, name-match preselect works, POST fires before
    download.
  - Dead Remitente/Plataforma forms are gone.
- `records.test.ts`: detail response includes `clientId`/`platformId`.
