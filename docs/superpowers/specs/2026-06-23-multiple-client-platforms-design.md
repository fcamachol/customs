# Design: Multiple platforms per client

**Date:** 2026-06-23
**Status:** Approved (design)

## Problem

A client today owns **exactly one** platform, embedded as a `jsonb` column on `clients`
(`{ commercialName, countryOfOrigin, legalName, email }`). The business needs a client to own
**several** platforms, and each manifest's Reporte General must be generated against **one**
specific platform of that client.

## Architectural framing

The Reporte General has a single fixed "Plataforma" block (4 columns —
`shared/export/reportBuilder.ts:88-95`). A manifest binds to one client
(`manifests.client_id`). The report output therefore stays **single-platform**.

"Multiple platforms per client" resolves to:

> A client **owns a list** of platforms (master data); each manifest **explicitly selects one**
> of that client's platforms (cascading client → platform pick). The report is fed the selected
> platform and its layout is unchanged.

Decision: **normalized join table** (not a jsonb array) — a manifest needs a *stable* platform
identity to reference (FK + referential integrity), and platform CRUD/audit/query stay clean.

Note: the client-level platform in `clients.platform` is stored **plaintext** today (the F20a
field encryption applies only to *shipment* platforms inside `import_data`). This design mirrors
that — client-platform rows are plaintext. Encrypting the platform email at rest is an explicit
out-of-scope follow-up.

## Data model

New table — one client → many platforms:

```
client_platforms
  id                uuid pk        default gen_random_uuid()
  client_id         uuid not null  references clients(id) ON DELETE CASCADE
  commercial_name   text
  country_of_origin text
  legal_name        text
  email             text
  created_by        uuid           references users(id) ON DELETE SET NULL
  created_at        timestamptz not null default now()
  -- index on (client_id)
```

`manifests` gains:

```
platform_id  uuid  references client_platforms(id) ON DELETE SET NULL   -- nullable
```

### Migration / backfill

1. Create `client_platforms` and add `manifests.platform_id` (nullable).
2. Backfill: for every client whose `clients.platform` jsonb is non-empty, insert one
   `client_platforms` row from it (`commercialName→commercial_name`, etc.).
3. Keep the legacy `clients.platform` column **in place, untouched**, for one release as a safety
   net. A later, separate migration drops it.
4. No manifest backfill: `platform_id` starts null and the report falls back to a blank Plataforma
   block (identical to a client with no platform today).

## API

All platform-mutating routes get zod schemas (`server/src/validation/schemas.ts`) and audit
entries.

- `GET /api/catalogs/clients` — each client gains `platforms: ClientPlatform[]` (grouped join).
- `POST   /api/catalogs/clients/:id/platforms`       — add platform (admin, capturista).
- `PUT    /api/catalogs/clients/:id/platforms/:pid`  — edit platform (admin, capturista).
- `DELETE /api/catalogs/clients/:id/platforms/:pid`  — remove platform (admin).
  Audit actions: `CREATE_CLIENT_PLATFORM`, `UPDATE_CLIENT_PLATFORM`, `DELETE_CLIENT_PLATFORM`.
- `POST /api/catalogs/clients` optionally accepts a `platform` object → creates the client **and**
  one initial `client_platforms` row atomically (this is the AddClientModal path). It no longer
  writes the jsonb column.
- `PUT /api/catalogs/clients/:id` updates client scalar fields **only**; it stops accepting a
  `platform` object. All platform edits go through the dedicated platform endpoints below — this
  removes the "which platform?" ambiguity once a client owns several.
- `POST /api/manifests/:id/client` accepts `{ clientId, platformId }` **together**. Server
  validates `platformId` belongs to `clientId` (400 otherwise). Both persist on the manifest and
  setting either busts the cached report (`report_file_id = NULL`), as the existing client bind
  already does.

## Report flow (output unchanged)

`buildReportRowsForManifest` (`server/src/services/reportData.ts`) changes its join from
`c.platform` to:

```sql
LEFT JOIN client_platforms p ON p.id = m.platform_id
```

and feeds `p`'s four fields into the report builder's existing single-`platform` input.
`platform_id` null → Plataforma block blank. `shared/export/reportBuilder.ts` is **untouched**.

## UI

- **ConfigurationView → Clientes tab:** each client row expands to show its platforms (commercial
  name, país de origen, razón social, correo) with inline add / edit / remove. Client data and
  platform data live together in the Clientes section.
- **AddClientModal:** creates the client with **one** initial platform (the current single-platform
  form). Additional platforms are managed afterward from the Clientes tab — keeps the modal simple.
- **ReporteGeneralView (and any other manifest-bind point):** cascading two-step pick —
  1. **Client select** → on change, loads that client's `platforms[]`.
  2. **Platform select** → options are *only* the chosen client's platforms; disabled until a
     client is picked; resets when the client changes.
  3. Report generation requires both; both are sent to `POST /manifests/:id/client`.

## Testing

- Migration backfill: existing jsonb platform → exactly one `client_platforms` row.
- Platform CRUD routes: auth/role gating, zod validation, audit entries.
- Manifest bind: rejects a `platformId` not owned by `clientId`; accepts a valid pair; busts cache.
- `buildReportRowsForManifest`: selected platform overlays the 4 cells; null `platform_id` → blank
  block.
- Frontend: Clientes tab add/edit/remove platform; ReporteGeneral cascading select requires a pick
  and resets platform when client changes.

## Out of scope (later)

- Encrypting the client-platform `email` at rest (mirrors today's plaintext behavior).
- Dropping the legacy `clients.platform` column (separate migration, one release later).
