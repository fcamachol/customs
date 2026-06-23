# Phase A — Manifest Ingestion Data Integrity (Increment 1: Staging Core)

**Date:** 2026-06-22
**Status:** Design — revised after 4-agent adversarial review (awaiting final review)
**Scope:** Manifest upload → validation → staging → promotion. First of four phases remediating the validation-engine audit (`docs/validation_engine_top_tier_audit.md`). Phases B (prevalidation), C (risk robustness), D (Level 3–5) follow as separate spec→plan cycles.

**Revision note (v2):** Incorporates review findings — `source_file_id` (not `file_id` reuse), per-line idempotency key, `procedenceCountry` added without renaming `originCountry`, origin/tax-ID downgraded to warnings at ingestion (enforced at pedimento build), locale-ambiguous numbers blocking in Phase A, risk invalidation on re-promotion, lifecycle guards, and deterministic golden tests. `xlsx` is already a server dep.

---

## 1. Problem

Today's manifest upload (`src/components/RegistroView.tsx` → `POST /api/manifests` → `shared/parsing/manifestParser.ts`) is a single-shot parse-and-persist:

- The .xlsx is read **client-side**; the server never sees the original file or the true header row.
- `parseNumber` **silently coerces** bad numbers (`"N/A"`, `"abc"`, `"---"`, and locale-ambiguous `"1,000"`→`1`) to wrong values; there is **no row-level error reporting**. Garbage rows become clean-looking shipments.
- Every row is persisted regardless of validity; the only downstream guard is pedimento prevalidation, far too late.
- Country/currency are not normalized; **`originCountry` is empty for all real courier-manifest rows** (verified against `.playwright-mcp/MANIFEST_TEST.xlsx`, 501 rows — the file has no origin-of-manufacture column at all).
- Country semantics are legally wrong (see §4): one `originCountry` is copied into both `paisVendedor` and `paisOrigenDestino` (`shared/pedimento/buildPedimento.ts:26`). Silent `'US'` fallbacks fabricate origin (`src/utils/fileParser.ts:117`, `src/context/T1Context.tsx:171`).
- Re-uploading a corrected file duplicates the manifest and shipments (non-idempotent).
- An orphan second parser (`src/utils/fileParser.ts`, zero importers) carries its own silent-failure logic.

For an enterprise customs (aduana) platform whose output is a legal declaration, source data must be defensible, reconstructable, and never silently corrupted.

## 2. Goal

Replace single-shot ingestion with a **bronze → silver → gold staging pipeline**, parsed server-side, with per-row validation, a promotion gate, and idempotent re-upload — establishing clean, auditable input for downstream prevalidation/pedimento/risk. **No required-field value is ever silently coerced or fabricated.**

## 3. Architecture

Medallion-style staging:

- **Bronze (immutable landing):** the **original uploaded file**, stored via `saveFile({ kind: 'manifest' })` (the `'manifest'` FileKind already exists, `server/src/storage/files.ts:6`) + a SHA-256 `content_hash`. Referenced by a **new `manifests.source_file_id`** column (NOT the existing `file_id`, which is owned by the pedimento PDF and drives `computeLock`). Parsing moves **server-side** (`XLSX.read`), making the server the single source of truth and the file re-parseable when catalogs/rules change.
- **Silver (validated working layer):** a new `manifest_staging_rows` table — typed/normalized fields, per-row `status` (`valid | warning | error`), structured `errors`/`warnings`, an `idempotency_key`, and PII encrypted via `encryptConsignee` on the `consignee` sub-object (matching today's boundary). Bad numbers become **errors**, never silent values. `error` rows are quarantined; `warning` rows are promotable.
- **Gold (promoted declaration):** `POST /api/manifests/:id/promote` upserts `valid` and `warning` rows into `shipments` keyed by `idempotency_key`. Risk scoring + prevalidation run on gold **only**, after promotion.

### Module boundary (server vs shared)
- **Server-only** (`server/src/...`): the bytes→rows reader (`XLSX.read`), multipart handling, `saveFile`, DB writes. `XLSX.read` must NOT live in `shared/` because `shared/` is bundled to the browser by Vite.
- **Shared** (`shared/parsing/`): the pure rows→validated-result validator + static catalogs (`catalogs.ts`). These must avoid `node:` imports if the frontend ever imports them for an optional instant-preview.

### Parsing location
**Server-side via multipart upload.** The client uploads the raw file (`multipart/form-data`); the server runs `XLSX.read`. Mirrors the existing pedimento path (`server/src/routes/pedimentoUpload.ts`: `multer.memoryStorage`, MIME/size guards, `saveFile`). `xlsx@^0.18.5` is **already a server dependency** (`server/package.json`). Benefits: true header row visible (enables duplicate-header detection), no trust in client transforms (OWASP), reproducible source artifact.

### Behavior change (explicit)
Upload becomes **two steps**: (1) upload → server validates → returns a per-row report; (2) operator reviews/fixes rejects → **promote**. Risk scoring no longer runs inside upload (today's `RegistroView.tsx:79-86` two-call sequence is replaced by upload → review → promote → risk).

## 4. Country semantics fix (legal correctness)

Per Anexo 22 / RGCE, these are **three distinct declared data** and must not be conflated:

| Concept | Definition | Source in manifest |
|---|---|---|
| **País de origen** (P. O/D) | where goods were **manufactured** | a true origin datum — **NOT** derivable from shipper; absent in the courier feed |
| **País de procedencia** | where goods **shipped from** | sender/remitente country (`sender.countryCode` = `CN`) |
| **País vendedor** (P. V/C) | the **seller's** country | platform/seller country |

Decisions:
- **Do NOT rename `Shipment.originCountry`.** It already carries *país de origen* semantics and is read by `taxCalculator.ts` / `t1Compliance.ts` for USMCA rate logic — renaming would break ~17 call sites at compile time and risk silently changing tax rates. Instead **ADD `Shipment.procedenceCountry`** and populate it from the sender country code; stop fabricating origin.
- **Stop deriving origin from sender country.** No `país del remitente` column maps to `originCountry`. Map sender columns → `procedenceCountry`, consignee columns → destination, platform → seller.
- **Missing true país de origen = WARNING at ingestion** (`país de origen no declarado`), NOT a hard error. Rationale: courier T1 low-value (RGCE 3.7.x / Anexo 22) is not required to certify per-item manufacture origin, and the real feed carries none — a hard ingestion gate would quarantine 100% of legitimate rows. **Origin becomes a hard requirement at the promote-to-pedimento gate (Phase B)**, where it can be supplied/defaulted per company SOP. **No fabrication** at any stage — remove the `'US'` defaults in `fileParser.ts` (deleted) and `T1Context.tsx:171`.
- **`buildPedimento.ts:26` país split is deferred to Phase B.** Phase A only adds/populates `procedenceCountry` and stops upstream conflation; `buildPedimento` keeps compiling against `originCountry` until Phase B rewires `paisOrigenDestino`/`paisVendedor` to distinct inputs. (Resolves the prior §4/§12 contradiction.)

## 5. Validation rules (silver layer)

Each rule emits `{ rowIndex, field, code, severity, message, rawValue }`.

**Hard errors (quarantine the row — not promotable):**
- **Numbers** — `parseNumber` returns a discriminated result (`{ ok: true, value } | { ok: false, code }`) instead of silent coercion. Non-finite / non-numeric in a required numeric field (`customsValueUsd`, `quantity`) → error.
- **Locale-ambiguous numbers** — a value like `"1,000"` whose decimal/thousands interpretation is ambiguous, in a required numeric field, → **error** (promotion-blocking). This is the bypass-#8 corruption and is fixed in Phase A; only *automatic disambiguation heuristics* defer to Phase C.
- **Required fields blank** → error: `description`, `hsCode`, `quantity > 0`, `customsValueUsd > 0`, `guideId`, sender country (procedencia), `currency`. Value ≤ 0 carries an actionable message (muestra sin valor comercial → declare reconstructed value), since zero-value courier lines are prohibited (ANAM).
- **Country** — prefer the ISO **code** column; fall back to mapping the Spanish/English name via static ISO-3166 catalog; unknown → error.
- **Currency** — `"Dólar estadounidense"` → `USD` via static ISO-4217 name map; unknown → error. (Threshold rules assume USD; non-USD requiring tipo-de-cambio conversion is noted for Phase B/C.)
- **Dates** — parse `arrivalDate` from Excel serial numbers and common string formats → ISO `YYYY-MM-DD`; invalid → error.
- **Weight units** — extend `toKg` to `mg/g/kg/t/lb/oz`; unknown unit → error.
- **Duplicate mapped headers** → **upload-level error** (whole file rejected before row processing).

**Warnings (row persists, promotable, flagged):**
- **Consignee identity** — require *presence* of an identity in the `ID` column; **detect shape (RFC 12-13 / CURP 18 / generic XAXX·XEXX)** and store typed. Do NOT force RFC-regex on CURP rows. Missing/invalid identity → warning (resolvable via generic-RFC + observaciones per regla 3.7.5), not a hard error.
- **País de origen** missing → warning (see §4; hard-gated at Phase B).
- **HS/fracción format** — sanity check (8 or 10-digit numeric); malformed → warning (full fracción validity deferred to Phase B).

**Non-blocking:** unmapped headers reported as today.

Catalogs live as static shared data: `shared/parsing/catalogs.ts` (ISO-3166 + name→code, ISO-4217 + name→code, unit→kg factors). No DB coupling in Phase A.

## 6. Data model / migrations

(Using `node-pg-migrate` builder style; next slot `1700001900000_*`.)

1. `files.content_hash text` — populate SHA-256 in `saveFile`.
2. `manifests`: add `ingestion_status text NOT NULL DEFAULT 'draft'` CHECK in `('draft','staged','promoted')`, `source_file_id uuid REFERENCES files`, `source_header jsonb`, `file_content_hash text`. **Declaration locking stays with `computeLock` (`manifestLock.ts`); ingestion_status is orthogonal and documented as such — it does not gate edits the way `file_id`/prevalidation do.**
3. `manifest_staging_rows (id uuid PK, manifest_id uuid FK, row_index int, idempotency_key text, data jsonb /* consignee PII-encrypted */, status text CHECK ('valid','warning','error'), errors jsonb, warnings jsonb, promoted_at timestamptz, created_at timestamptz default now())` + `UNIQUE (manifest_id, idempotency_key)`.
4. `shipments`: add `idempotency_key text` + `UNIQUE (manifest_id, idempotency_key)` (NULL keys never collide; promotion always computes a non-null key). Promotion is an UPSERT.

**Idempotency key (per-line, not per-shipment):** `sha256(mawbReference | guideId | lineSeq | hsCode)` where `lineSeq` = ordinal of the line within its `guideId` group (stable across re-uploads of the same-ordered file). Rationale: the real file has 501 rows but only 126 unique `guideId`/`clientOrderId` — keying without a per-line discriminator would collapse ~375 partidas and the UNIQUE constraint would drop them. The golden test asserts **501 distinct staging rows**. Known limitation: correcting a key-component field (e.g. `guideId`) changes the key → a re-upload patches as new rather than updating; documented, not silent.

## 7. API contract

- `POST /api/manifests` — `multipart/form-data` with `file` + `mawbReference` + `clientName` (text fields via multer; global `express.json` is a no-op for multipart). Guards: reject if target manifest is `computeLock`-locked (409); MIME/size guard → `saveFile({kind:'manifest'})` + content hash → `XLSX.read` → validate → write silver rows; set `ingestion_status='staged'`. Response:
  ```
  { manifestId, ingestionStatus, counts: { total, valid, warning, error },
    rejected: RowError[], warnings: RowWarning[], unmappedHeaders, duplicateHeaders }
  ```
- `GET /api/manifests/:id/staging` — paged silver rows + status for the review UI; downloadable "rejects + error column" export (**PII redacted** in the export).
- `POST /api/manifests/:id/promote` — **state-machine guarded**: requires `ingestion_status='staged'` (rejects `promoted`/locked, preventing double-promote and concurrent promotes); refuses if any `error` rows remain; refuses if **zero** valid/warning rows. UPSERTs valid+warning rows → `shipments` by idempotency key; on any UPSERTed row sets **`risk_stale=true` and NULLs `risk_score/color/incidences`** (re-promotion invalidates prior risk — audited); sets `ingestion_status='promoted'`. Risk scoring runs after this.

## 8. Audit events

Via existing `recordAudit` (hash-chained, `stableStringify`): `INGEST_MANIFEST` (file_content_hash, counts by status), `PROMOTE_MANIFEST` (promoted count, risk-invalidated count), `QUARANTINE_ROWS` (error count).

## 9. UI (`RegistroView.tsx`)

- Upload posts the file (multipart) instead of client-extracted rows.
- New **review step**: table of rows with status badges, errors/warnings panels (row #, field, message), "descargar rechazos" CSV export (PII-redacted).
- **Promote** button (disabled while errors remain or zero promotable rows) → triggers promotion, then risk scoring → existing result view.
- Remove the `'US'` default at `T1Context.tsx:171`.
- (Bulk país-de-origen entry UX is a Phase B concern, since origin is only a warning at ingestion.)

## 10. Cleanup

- **Delete** `src/utils/fileParser.ts` (orphan, zero importers, no test — confirmed).

## 11. Testing

- Unit (`shared/parsing`): `parseNumber` discriminated result incl. locale-ambiguous → error; each field rule (bad number, blank required, country code/name/unknown, currency, date serial+invalid, units lb/oz/unknown); duplicate-header detection; idempotency-key per-line determinism; consignee RFC/CURP/generic shape detection; country mapping (sender→procedenceCountry, origin→warning).
- Integration (`server/test/routes/manifests.test.ts` — rewrite for multipart): partial-accept response shape; quarantine excluded from promotion; promote UPSERT idempotency (re-upload corrected rows merges, no duplicates); promote blocked while errors remain / on `promoted` state / zero valid rows; re-promotion sets `risk_stale`; 409 on locked manifest; audit events emitted.
- **Golden tests (two deterministic fixtures, no disjunction):**
  - (a) **Unmodified real `MANIFEST_TEST.xlsx`** → **501 staging rows, 0 hard errors**, all `valid`/`warning`, **`país de origen` warning on every row**, `procedenceCountry='CN'`, `currency='USD'`, `weightKg≈0.245`; fully promotable. Proves origin is no longer fabricated and normalization works end-to-end.
  - (b) **Mutated fixture** (inject `"N/A"` value, `"1,000"` value, blank `hsCode`, unknown country, duplicate header) → asserts each becomes the correct hard error and the row is quarantined / file rejected.

## 12. Out of scope (deferred)

- **Phase B:** `buildPedimento` país-field split; **hard origin requirement at the promote-to-pedimento gate** + bulk origin-entry UX; prevalidation catalog validation; non-USD tipo-de-cambio conversion before threshold rules.
- **Increment 2+:** full bronze `manifest_raw_rows` lineage; reprocess-from-bronze on catalog/ruleset change (record versions now); warning-acknowledgement workflow UI; partial re-upload of only rejected rows; envelope encryption of the file blob at rest; async/large-file processing (Phase A keeps synchronous insert with a row-count ceiling — reject files over the ceiling rather than silently degrade); staged-manifest TTL/cleanup for abandoned uploads.

## 13. Risks / trade-offs

- More tables/migrations and a two-step UX vs one click — justified by defensibility for a legal declaration.
- `encryptConsignee` encrypts only the 5 consignee identity fields (`fieldCrypto.ts`); silver `data` stores the encrypted consignee sub-object, names/addresses follow today's plaintext boundary. The `v1:` prefix makes encrypt idempotent, so promotion copies the encrypted blob verbatim (no decrypt/re-encrypt cycle).
- Behavior change: auto-risk-on-upload removed; `RegistroView` flow and the single-shot tests (`manifests.test.ts`, `manifestParser.test.ts`) must be rewritten.
- `procedenceCountry` is additive (no rename), so no compile-time ripple; downstream consumers (`reportData.ts:48` sender-country fallback) are reviewed and updated where they read `originCountry` for sender semantics.
- Synchronous per-row insert is retained for current volumes; a row-count ceiling guards against pathological files until async lands in Increment 2.
