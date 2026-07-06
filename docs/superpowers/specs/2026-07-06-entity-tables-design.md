# Multiple agentes aduanales & importadores, auto-registered from pedimentos

**Date:** 2026-07-06
**Status:** Approved

## Problem

Prevalidation requires a single configured `importer_of_record` and `customs_agent` (config
keys, super_admin-gated) and 422s when absent. The business works with **multiple** agentes
aduanales and importadores, and each pedimento already identifies its own (patente, RFC,
razones sociales). Prevalidation must resolve entities per pedimento from catalog tables that
auto-register from uploaded pedimentos.

## Data model (one migration)

- `agentes_aduanales`: `id` uuid PK default gen, `patente` text UNIQUE NOT NULL, `name` text,
  `agent_rfc` text, `agency_rfc` text, `verified` boolean NOT NULL default false,
  `created_by` uuid NULL references users, `created_at`/`updated_at` timestamptz default now().
- `importadores`: `id` uuid PK, `rfc` text UNIQUE NOT NULL, `name` text, `fiscal_address` text,
  `verified` boolean NOT NULL default false, `created_by`, `created_at`/`updated_at`.
- Data migration: if config keys `importer_of_record` / `customs_agent` hold valid values,
  insert them as `verified=true` rows (leave the config rows in place, now unused).

## Parser (shared — owned by orchestrator)

`ExtractedPedimentoHeader` gains `importerName: string | null` and
`importerAddress: string | null`; `agentRfc` (already typed) gets populated. Extraction is
best-effort on both known layouts, fixtures verbatim from the two real PDFs:

- `importerName`: line after "NOMBRE, DENOMINACION O RAZON SOCIAL:" (digit-line skipping as
  in the agente anchor).
- `importerAddress`: text after "DOMICILIO:" up to end of line(s), best-effort single line.
- `agentRfc`: the RFC-shaped token inside the agent block (after "NOMBRE O RAZ. SOC" /
  before "Clave en el RFC"), distinct from the importer RFC.

## Upload (server/src/routes/pedimentoUpload.ts)

After extraction, best-effort upsert (never fail the upload):

- `INSERT INTO agentes_aduanales (patente, name, agent_rfc) VALUES … ON CONFLICT (patente)
  DO UPDATE SET name=COALESCE(agentes_aduanales.name, EXCLUDED.name), agent_rfc=COALESCE(…)`
  — only fills missing fields, never overwrites, never flips `verified`.
- Same for `importadores` keyed by rfc (name, fiscal_address).
- Add `importerRfc` and `importerName` to the persisted `importPrefill`.

## Prevalidation (server/src/routes/pedimento.ts)

Replace `loadImporterOfRecord()/loadCustomsAgent()`:

- Resolve agente: `SELECT … FROM agentes_aduanales WHERE patente = <pedimento patente>`
  (patente from the pedimentos row's numero — `normPedimentoNumero` group — or import_data).
- Resolve importador by `import_data.importerRfc`.
- 422 only when the pedimento has no patente or no importer RFC to resolve with (message
  names what's missing).
- Unresolved row (patente/RFC not in table) should not happen post-upload (auto-registered),
  but if it happens: create it on the fly, same as upload upsert.
- Build options: use resolved fields; missing name/address/agencyRfc pass as '' — and
  `prevalidatePedimento` treats a MISSING (empty) RFC as a **warning** ("RFC del agente no
  disponible — agente sin verificar"), not an error; present-but-invalid RFCs still error.
- `verified=false` on either entity adds a prevalidation warning naming the entity.

## Catalogs API (server/src/routes/catalogs.ts)

Admin-gated (`admin` + `super_admin`):

- `GET /api/catalogs/agentes-aduanales` — list.
- `PUT /api/catalogs/agentes-aduanales/:id` — edit fields + `verified`.
- Same pair for `/api/catalogs/importadores`.
- recordAudit on edits (`UPDATE_AGENTE_ADUANAL`, `UPDATE_IMPORTADOR`).

## UI (src/components/ConfigurationView.tsx — owned by frontend agent)

Replace the two single-entity forms with two tables (agentes, importadores): columns per
schema + verified badge ("Verificado" / "Sin verificar"), inline edit, and a verify action.
Keep the clean/minimal style of the existing view.

## Testing

- Parser: new fixture-based tests (both layouts) for importerName/importerAddress/agentRfc.
- Server: migration-backed route tests — upload auto-registers both entities; second upload
  same patente doesn't duplicate or overwrite; prevalidate resolves per pedimento, warns on
  unverified, 422s only when patente/RFC unextractable; catalogs CRUD + role gates.
- UI: ConfigurationView tests for listing, editing, verifying (mocked API).

## Out of scope

- Deleting entities; merging duplicates.
- Per-client importer defaults.
- Backfilling entities from previously uploaded pedimentos.
