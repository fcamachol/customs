# Phase B — Prevalidation Correctness (ANAM/SAT Rejection Risk)

**Date:** 2026-06-23
**Status:** Design — awaiting review
**Branch:** main
**Scope:** The prevalidation + pedimento-build layer. Second of four phases remediating the validation-engine audit (`docs/validation_engine_top_tier_audit.md` §3, P1). Phase A (ingestion) is merged. Phases C (risk robustness) and D (Level 3–5) follow.

---

## 1. Problem

The active prevalidator (`shared/pedimento/prevalidate.ts`, run by `POST /api/manifests/:id/pedimento` in `server/src/routes/pedimento.ts`) is too weak to catch what ANAM/SAT actually reject:

- **Two divergent prevalidators.** Backend `shared/pedimento/prevalidate.ts` (validates `Pedimento`, gates generation) vs. frontend `src/engine/prevalidador.ts` (validates `T1PedimentoGlobal`, reachable only via the vestigial `T1Context:203`). They disagree (dotted vs dotless fracción, quantity/MJ checks present only in the frontend one).
- **Checksum is only a warning.** A bad RFC/CURP dígito verificador still `APPROVED`s.
- **No RRNA enforcement, no per-consignee aggregate, no catalog validation** (aduanas/unidades/países/patente), **no header-totals reconciliation.**
- **País conflation.** `buildPedimento.ts:26` copies one `originCountry` into both `paisVendedor` and `paisOrigenDestino`; país de origen is never required (the Phase A warning was deferred to here).
- **REJECTED doesn't block.** `POST /:id/pedimento` stores a `REJECTED` result but returns 201, and the pedimento-PDF upload never checks it — a rejected pedimento can still be "filed."

## 2. Goal

One authoritative prevalidator that **rejects what ANAM/SAT would reject**, a correct país-field split with a hard origin gate, and a filing path that refuses a REJECTED pedimento. Cohesive single increment.

## 3. Single authoritative prevalidator

`shared/pedimento/prevalidate.ts` becomes the sole prevalidator. **Port** the valuable structural checks from `src/engine/prevalidador.ts`, adapted to the `Pedimento` model:
- secuencia uniqueness across partidas;
- `cantidadUmc > 0` per partida;
- `description.trim().length >= 3` per partida;
- MJ-complement consistency: if a manifest-level "exención MJ" flag is set but any partida value > $50 USD → error (and the inverse → warning);
- EM identifier presence (`header.identifiers.EM`).

Then **delete** `src/engine/prevalidador.ts` and remove its call at `src/context/T1Context.tsx:203` — after confirming no routed view dispatches the prevalidate action (the ledger records `T1Provider` as vestigial; verify and, if a routed view does depend on it, adapt it to call the shared prevalidator via API result instead). Keep `src/types/t1` types only if still referenced elsewhere.

## 4. New prevalidation rules

All rules below run inside `prevalidatePedimento(p: Pedimento)` and contribute to `errors` (→ `REJECTED`) unless stated as warnings.

### 4.1 Checksum blocking (exempt generic RFCs)
A header RFC (importer, agent) or a partida consignee identity that is shape-valid but **fails the dígito verificador** → error, **except** the official generic RFCs `XAXX010101000` and `XEXX010101000`, which pass. Uses `taxId.isValidTaxIdStrict` + a `GENERIC_RFCS` allowlist constant in `taxId.ts`.

### 4.2 RRNA enforcement
Port the RRNA category detection into a shared, description-based module **`shared/pedimento/rrna.ts`** (`detectRrnaCategories(description: string): string[]`), carrying the keyword→category lists from `src/engine/rrnaDetector.ts`. In prevalidation, a partida whose description matches an RRNA-controlled category with no declared exemption (no matching `partida.identifiers`/`noms` entry) → error: "Partida N: requiere regulación no arancelaria (<categoría>)." `src/engine/rrnaDetector.ts` may delegate to the shared module to avoid divergence.

### 4.3 Per-consignee $2,500 aggregate
Group partidas by consignee identity and reject if any consignee's summed `valorAduanaUsd` > $2,500 USD: "Consignatario <id>: valor agregado $X excede $2,500 USD (fraccionamiento)." Requires the partida to carry its consignee id — see §6 (`buildPedimento` adds `partida.consigneeId`). This closes the gap the per-partida $2,500 check misses.

### 4.4 Catalog validation
- **País** (`paisOrigenDestino`, `paisVendedor`): must resolve via `shared/parsing/catalogs.resolveCountry`; unknown → error.
- **UMC** (`partida.umc`): must be in a static **SAT Apéndice 7** unit-of-measure seed (`shared/pedimento/catalogs.ts` → `UMC_CODES`); unknown → error.
- **Aduana** (`header.customsEntryCode`, `customsClearanceCode`): must be in a static SAT aduana-sección seed (`ADUANA_CODES`); unknown → error.
- **Patente** (`header.agent.patente`): format `^\d{4}$` + present; unknown-padrón validation deferred (no offline SAT padrón). Bad format → error.

### 4.5 Header totals vs partidas
- `header.valorDolares` ≈ Σ `partida.valorAduanaUsd` (tolerance ±0.01);
- `header.totalBultos` == `partidas.length`;
- `header.pesoBrutoKg` ≈ Σ shipment `weightKg` (tolerance ±0.001).
Mismatch → error citing expected vs actual.

### 4.6 Origin hard-gate
A partida with empty/blank `paisOrigenDestino` → error: "Partida N: país de origen no declarado." (The Phase A ingestion warning becomes a hard block at the pedimento boundary, as decided.)

### 4.7 Currency basis (USD)
The pedimento value basis is USD (`valorAduanaUsd`). `buildPedimento` converts a non-USD source value to USD when a rate is derivable (MXN via `1/tipoCambio`); a partida whose source currency is non-USD and non-convertible → error: "Partida N: moneda no soportada; declare en USD." (Full multi-currency FX is out of scope — no offline rate source.)

## 5. Reject-blocks-filing

`POST /api/manifests/:id/pedimento-pdf` (`server/src/routes/pedimentoUpload.ts`) refuses with **422** when the manifest's stored `prevalidation.status === 'REJECTED'`: "No se puede adjuntar el pedimento: la prevalidación está RECHAZADA." (Check added before `saveFile`, alongside the existing MIME/scan guards.) `computeLock` is unchanged; this is an independent filing guard.

## 6. `buildPedimento` changes (`shared/pedimento/buildPedimento.ts`)

- **País split:** `paisOrigenDestino ← s.originCountry` (país de origen, manufactured); `paisVendedor ← s.platform.countryOfOrigin || s.procedenceCountry` (seller/platform country, falling back to procedencia); stop copying one value into both.
- **Per-partida consignee id:** set `partida.consigneeId = s.consignee.curp ?? s.consignee.rfc` (new optional field on `PedimentoPartida`) so §4.3 can group without parsing the observation string.
- **USD conversion (§4.7):** when `s.currency !== 'USD'`, convert `customsValueUsd` to USD if a rate is derivable (MXN), else leave as-is and let prevalidation reject.

`PedimentoPartida` gains `consigneeId?: string` in `shared/types/pedimento.ts`.

## 7. Files

**Create:** `shared/pedimento/rrna.ts` (+ test), `shared/pedimento/catalogs.ts` (UMC + aduana seeds, + test).
**Modify:** `shared/pedimento/prevalidate.ts` (+ test — the bulk of the work), `shared/pedimento/buildPedimento.ts` (+ test), `shared/types/pedimento.ts` (`consigneeId`), `shared/parsing/taxId.ts` (`GENERIC_RFCS`), `server/src/routes/pedimentoUpload.ts` (REJECTED guard + test), `src/engine/rrnaDetector.ts` (delegate to shared), `src/context/T1Context.tsx` (remove prevalidador call).
**Delete:** `src/engine/prevalidador.ts`.

## 8. Testing

- **Unit** (`shared/pedimento`): each rule in isolation — checksum block + generic-RFC exempt; RRNA category hit → reject; per-consignee aggregate (two partidas same consignee summing >$2,500 → reject; ≤$2,500 → pass); each catalog (unknown país/UMC/aduana/patente → reject); header-totals mismatch; origin hard-gate; ported structural checks (secuencia dup, qty, description, MJ). A "happy path" pedimento → `APPROVED` with zero errors.
- **`buildPedimento` test:** país split (origin vs vendedor distinct), `consigneeId` populated, MXN→USD conversion.
- **Integration** (`server/test/routes`): `POST /:id/pedimento` returns `REJECTED` on a bad pedimento and `APPROVED` on a clean one; `POST /:id/pedimento-pdf` returns 422 when prevalidation REJECTED, succeeds when APPROVED.
- **Regression:** full server + frontend suites stay green after deleting the frontend prevalidador.

## 9. Out of scope (deferred)

- RFC homoclave verification (needs the legal name; `taxId.ts` documents this — the name-independent check digit is what we verify).
- Full multi-currency FX conversion (no offline rate source; only MXN↔USD via `tipoCambio`).
- SAT padrón-de-agentes lookup for patente (no offline source; format/presence only).
- Real-time SAAI M3 transmission and 505/551/557 record fidelity (Phase D / future).

## 10. Risks / trade-offs

- Deleting `src/engine/prevalidador.ts` + the `T1Context` call must be verified against routed views first; if `T1Context` turns out load-bearing, adapt rather than delete and note it.
- RRNA enforcement could over-reject if the keyword lists are broad — the ported lists match today's detector behavior; tune only if tests on real descriptions show false positives.
- Static aduana/UMC seeds may be incomplete; unknown-code rejections are surfaced clearly so missing seeds are easy to spot and extend (logged, not silent).
