# Phase A — Manifest Ingestion Data Integrity (Increment 1: Staging Core)

**Date:** 2026-06-22
**Status:** Design — awaiting review
**Scope:** Manifest upload → validation → staging → promotion. First of four phases remediating the validation-engine audit (`docs/validation_engine_top_tier_audit.md`). Phases B (prevalidation), C (risk robustness), D (Level 3–5) follow as separate spec→plan cycles.

---

## 1. Problem

Today's manifest upload (`src/components/RegistroView.tsx` → `POST /api/manifests` → `shared/parsing/manifestParser.ts`) is a single-shot parse-and-persist:

- The .xlsx is read **client-side**; the server never sees the original file or the true header row.
- `parseNumber` **silently coerces** bad numbers (`"N/A"`, `"abc"`, `"---"`) to `0`; there is **no row-level error reporting**. Garbage rows become clean-looking shipments full of zeros.
- Every row is persisted regardless of validity; the only downstream guard is pedimento prevalidation, far too late.
- Country/currency are not normalized; **`originCountry` is empty for all real courier-manifest rows** (verified against `.playwright-mcp/MANIFEST_TEST.xlsx`, 501 rows).
- Country semantics are legally wrong (see §4): one `originCountry` is copied into both `paisVendedor` and `paisOrigenDestino` (`shared/pedimento/buildPedimento.ts:26`), and is sourced from a `'pais de procedencia'` header — conflating país de origen, procedencia, and vendedor. Silent `'US'` fallbacks fabricate origin (`src/utils/fileParser.ts:117`, `src/context/T1Context.tsx:171`).
- Re-uploading a corrected file duplicates the manifest and shipments (non-idempotent).
- An orphan second parser (`src/utils/fileParser.ts`, zero importers) carries its own silent-failure logic.

For an enterprise customs (aduana) platform whose output is a legal declaration, source data must be defensible, reconstructable, and never silently corrupted.

## 2. Goal

Replace single-shot ingestion with a **bronze → silver → gold staging pipeline**, parsed server-side, with per-row validation, a promotion gate, and idempotent re-upload — establishing clean, auditable input for downstream prevalidation/pedimento/risk.

## 3. Architecture

Medallion-style staging (industry standard for defensible ingestion):

- **Bronze (immutable landing):** the **original uploaded file**, stored via the existing `saveFile({ kind: 'manifest' })` and a SHA-256 content hash; `manifests.file_id` (already present, unused) is populated. The true header row is captured. Parsing moves **server-side** (`XLSX.read`), making the server the single source of truth — the file can be re-parsed later when catalogs/rules change.
- **Silver (validated working layer):** a new `manifest_staging_rows` table — typed/normalized fields, per-row `status` (`valid | warning | error`), structured `errors`/`warnings`, an `idempotency_key`, and **encrypted PII** (reusing `encryptConsignee`). Bad numbers become **errors**, never silent `0`. Invalid rows are quarantined, not dropped, not promoted.
- **Gold (promoted declaration):** a new `POST /api/manifests/:id/promote` endpoint upserts `valid` (and acknowledged-`warning`) rows into `shipments` keyed by `idempotency_key`. Risk scoring + prevalidation run on gold **only**, after promotion.

### Parsing location
**Server-side via multipart upload.** The client uploads the raw file (`multipart/form-data`); the server runs `XLSX.read`. This mirrors the existing pedimento path (`server/src/routes/pedimentoUpload.ts`: `multer.memoryStorage`, MIME/size guards, `saveFile`). Benefits: true header row visible (enables duplicate-header detection, impossible today), no trust in client transforms (OWASP), reproducible source artifact. Client-side parsing may remain only as an optional instant preview — never the data path.

### Behavior change (explicit)
Upload becomes **two steps**: (1) upload → server validates → returns a per-row report; (2) operator reviews/fixes rejects → **promote**. Risk scoring no longer runs automatically inside upload (today's `RegistroView.tsx:79-86` two-call sequence is replaced by upload → review → promote → risk).

## 4. Country semantics fix (legal correctness)

Per Anexo 22 / RGCE, these are **three distinct declared data** and must not be conflated:

| Concept | Definition | Source in manifest |
|---|---|---|
| **País de origen** (P. O/D) | where goods were **manufactured** | a true origin datum — **NOT** derivable from shipper |
| **País de procedencia** | where goods **shipped from** | sender/remitente country (`sender.countryCode`) |
| **País vendedor** (P. V/C) | the **seller's** country | platform/seller country |

Decisions:
- **Stop deriving origin from sender country.** No `país del remitente` column maps to origin.
- **Split the pedimento fields:** `buildPedimento.ts:26` must source `paisOrigenDestino` and `paisVendedor` from different, correctly-typed inputs (touches Phase B build; in Phase A we fix the **types/mapping** and stop the conflation at the shipment level).
- **Rename `Shipment.originCountry`** → introduce explicit fields: `originCountry` (país de origen, manufactured), `procedenceCountry` (sender), and keep seller/platform country distinct. Map sender columns → `procedenceCountry`, consignee columns → destination, platform → seller.
- **Missing true origin = hard row error** (`país de origen no declarado`). The row is quarantined and cannot be promoted until a declared origin is supplied. **No fabrication** — remove the `'US'` defaults in `fileParser.ts` (deleted) and `T1Context.tsx:171`.

## 5. Validation rules (silver layer)

Each rule emits a structured result `{ rowIndex, field, code, severity, message, rawValue }`.

- **Numbers** — `parseNumber` returns a discriminated result (`{ ok: true, value } | { ok: false, code }`) instead of silent `0`. Non-finite / non-numeric in a required numeric field (`customsValueUsd`, `quantity`) → **error**. (Locale-ambiguous strings like `"1,000"` are flagged but full handling is Phase C.)
- **Required fields** (blank → **error**): `description`, `hsCode`, `quantity > 0`, `customsValueUsd > 0`, consignee identity (`ID` → rfc/curp), `guideId`, sender country (procedencia), `currency`, declared origin (see §4).
- **Country** — prefer the ISO **code** column; fall back to mapping the Spanish/English name via a static ISO-3166 catalog; unknown → **error**.
- **Currency** — `"Dólar estadounidense"` → `USD` via static ISO-4217 name map; unknown → **error**.
- **Dates** — parse `arrivalDate` from Excel serial numbers and common string formats → ISO `YYYY-MM-DD`; invalid → **error**.
- **Weight units** — extend `toKg` to `mg/g/kg/t/lb/oz`; unknown unit → **error**.
- **Duplicate headers** — a duplicated *mapped* header makes column provenance ambiguous → **upload-level error** (whole file rejected before row processing).
- **Unmapped headers** — reported (non-blocking), as today.

Catalogs live as static shared data: `shared/parsing/catalogs.ts` (ISO-3166 codes + name→code, ISO-4217 codes + name→code, unit→kg factors). No DB coupling in Phase A (per decision: code-with-name-fallback, not DB-driven).

## 6. Data model / migrations

1. `ALTER TABLE files ADD COLUMN content_hash text;` — populate SHA-256 in `saveFile`.
2. `ALTER TABLE manifests ADD COLUMN ingestion_status text NOT NULL DEFAULT 'draft' CHECK (ingestion_status IN ('draft','staged','promoted','locked')), ADD COLUMN source_header jsonb, ADD COLUMN file_content_hash text;` — populate `file_id` on upload.
3. `CREATE TABLE manifest_staging_rows (id uuid PK, manifest_id uuid FK→manifests, row_index int, idempotency_key text, data jsonb /* PII-encrypted */, status text CHECK (status IN ('valid','warning','error')), errors jsonb, warnings jsonb, promoted_at timestamptz, created_at timestamptz default now(), UNIQUE (manifest_id, idempotency_key));`
4. `ALTER TABLE shipments ADD COLUMN idempotency_key text;` + `UNIQUE (manifest_id, idempotency_key)` so promotion is an UPSERT, not blind INSERT.

**Idempotency key:** `sha256(mawbReference + '|' + guideId + '|' + normalized(consignee.rfc || consignee.name) + '|' + clientOrderId)`. Re-uploading a corrected file recomputes the same keys → staging UPSERT patches the previously-rejected rows instead of duplicating.

## 7. API contract

- `POST /api/manifests` — now `multipart/form-data` with `file` + `mawbReference` + `clientName`. Server: MIME/size guard → `saveFile({kind:'manifest'})` + content hash → `XLSX.read` → validate → write silver rows. Response:
  ```
  { manifestId, ingestionStatus, counts: { total, valid, warning, error },
    rejected: RowError[], warnings: RowWarning[], unmappedHeaders, duplicateHeaders }
  ```
- `GET /api/manifests/:id/staging` — paged silver rows + status for the review UI; downloadable "rejects + error column" export.
- `POST /api/manifests/:id/promote` — refuses if any `error` rows remain (or warnings unacknowledged); UPSERTs valid rows → `shipments` by idempotency key; sets `ingestion_status='promoted'`; emits audit. Risk scoring runs after this.

## 8. Audit events

Via existing `recordAudit` (hash-chained, `stableStringify`): `INGEST_MANIFEST` (file_content_hash, counts by status), `PROMOTE_MANIFEST` (promoted count), `QUARANTINE_ROWS` (error count). Slots into the existing chain unchanged.

## 9. UI (`RegistroView.tsx`)

- Upload posts the file (multipart) instead of client-extracted rows.
- New **review step**: table of rows with status badges, an errors panel (row #, field, message), and a "descargar rechazos" CSV export.
- **Promote** button (disabled while errors remain) → triggers promotion, then risk scoring → existing result view.
- Remove the `'US'` default at `T1Context.tsx:171`.

## 10. Cleanup

- **Delete** `src/utils/fileParser.ts` (orphan, zero importers — confirmed) and its test if any.

## 11. Testing

- Unit (`shared/parsing`): `parseNumber` discriminated result; each field rule (bad number, blank required, country code/name/unknown, currency, date serial+invalid, units lb/oz/unknown); duplicate-header detection; idempotency-key determinism; country-semantics mapping (sender→procedencia, origin required).
- Integration (`server/test/routes/manifests.test.ts`): multipart upload → partial-accept response shape; quarantine excluded from promotion; promote upsert idempotency (re-upload corrected rows merges, no duplicates); promotion blocked while errors remain; audit events emitted.
- **Golden test:** run the real `.playwright-mcp/MANIFEST_TEST.xlsx` through the pipeline → expect **0 errors after declared origin supplied** (or: all rows quarantined with exactly `país de origen no declarado` if origin absent — asserting the legal rule fires), `procedenceCountry='CN'`, `currency='USD'`, `weightKg≈0.245`. This proves the originCountry bug fix and currency/weight normalization end-to-end.

## 12. Out of scope (deferred to Increment 2+)

- Full bronze **raw-row** lineage table (`manifest_raw_rows`); file-as-bronze covers short-term defensibility.
- **Reprocess-from-bronze** when catalogs/ruleset change (record versions now so it's possible later).
- Warning-**acknowledgement** workflow UI and partial re-upload of only rejected rows (idempotency key already enables it; needs UI).
- Envelope encryption of the file blob at rest; async/large-file processing.
- The `buildPedimento` field-split implementation detail and prevalidation catalog validation land in **Phase B**.

## 13. Risks / trade-offs

- More tables/migrations and a two-step UX vs one click — justified by defensibility for a legal declaration.
- Moving parsing server-side requires `xlsx` as a **server** dependency (currently a frontend dep) — add it.
- Behavior change: auto-risk-on-upload is removed; the client flow and any tests asserting the old single-call shape must be updated.
- Country-field rename ripples through `buildPedimento`, risk signals, reports — Phase A fixes the mapping/types and stops conflation; full downstream consumption is verified here and completed in Phase B.
