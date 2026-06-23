# Phase B — Prevalidation Correctness (ANAM/SAT Rejection Risk)

**Date:** 2026-06-23
**Status:** Design v2 — revised after 4-agent analysis (awaiting review)
**Branch:** main
**Scope:** The prevalidation + pedimento-build layer. Second of four phases remediating the validation-engine audit (`docs/validation_engine_top_tier_audit.md` §3, P1). Phase A (ingestion) is merged. Phases C (risk robustness) and D (Level 3–5) follow.

**Revision note (v2):** Incorporates the analysis team's findings — operator origin-supply path (the §4.6 gate is otherwise un-satisfiable on the real feed), MJ derived (no input field exists), RRNA detector rewrite + NOM-as-warning before any hard block, per-consignee $2,500 reframed as T1-ineligibility, header-totals tautology documented, UMC/aduana normalization before validation, `resolveCountry` alpha-3 support, empty-partidas guard.

---

## 1. Problem

The active prevalidator (`shared/pedimento/prevalidate.ts`, run by `POST /api/manifests/:id/pedimento` in `server/src/routes/pedimento.ts`) is too weak to catch what ANAM/SAT actually reject:

- **Two divergent prevalidators** — backend `shared/pedimento/prevalidate.ts` (validates `Pedimento`, gates generation) vs frontend `src/engine/prevalidador.ts` (validates `T1PedimentoGlobal`, reachable only via the vestigial `T1Context`). They disagree.
- **Checksum is only a warning**; no RRNA enforcement, no per-consignee aggregate, no catalog validation (aduanas/unidades/países/patente), no header-totals reconciliation.
- **País conflation** — `buildPedimento.ts:26` copies one `originCountry` into both `paisVendedor` and `paisOrigenDestino`; país de origen is never required.
- **REJECTED doesn't block** — `POST /:id/pedimento` stores `REJECTED` but returns 201, and the pedimento-PDF upload never checks it.

## 2. Goal

One authoritative prevalidator that **rejects what ANAM/SAT would reject** without over-rejecting legitimate courier shipments, a correct país-field split with an operator-supplied origin gate, and a filing path that refuses a REJECTED pedimento. Single cohesive increment.

## 3. Single authoritative prevalidator

`shared/pedimento/prevalidate.ts` becomes the sole prevalidator. **Port** these structural checks from `src/engine/prevalidador.ts`, adapted to the `Pedimento` model:
- secuencia uniqueness across partidas;
- `cantidadUmc > 0` per partida;
- `description.trim().length >= 3` per partida;
- **empty-partidas guard** (`partidas.length === 0` → error) — present in the frontend one, missing from the backend;
- EM identifier presence (`header.identifiers.EM` — real field, populated by `buildPedimento.ts:49`).

**MJ-complement (derived, warning-only):** no MJ/exención flag exists on `Pedimento`/`BuildOptions`/`Shipment`/the DB, so derive it: `mjEligible = partidas.every(p => p.valorAduanaUsd <= 50)`. When `mjEligible` is true, emit an advisory **warning** ("todas las partidas ≤$50 USD; considere complemento MJ de exención"). The "flag set + partida >$50" *error* branch is logically impossible under derivation, so it is dropped (no false rejections).

**Retire the frontend prevalidador:** delete `src/engine/prevalidador.ts`; remove its import + the `PREVALIDATE_PEDIMENTO` reducer case in `src/context/T1Context.tsx` (verified: no routed view dispatches it — every `useT1`/prevalidate reference is internal to `T1Context`). Leave `T1Provider`/`T1Context` mounted (vestigial but harmless) to avoid churning `ConfigurationView.test.tsx`, which wraps it.

## 4. New prevalidation rules

All contribute to `errors` (→ `REJECTED`) unless stated as warnings.

### 4.1 Checksum blocking (exempt generic RFCs)
A header RFC (importer, agent) or partida consignee identity that is shape-valid but **fails the dígito verificador** → error, **except** the official generic RFCs `XAXX010101000` (genérico nacional) and `XEXX010101000` (extranjeros). Add `GENERIC_RFCS` to `taxId.ts`; check the allowlist **before** the strict check (confirmed: `XAXX010101000` fails the check digit, so the exemption is load-bearing). Apply equally to CURP-shaped consignee identities.

### 4.2 RRNA enforcement (detector fixed first; NOM = warning)
Port RRNA detection into a shared, description-based module **`shared/pedimento/rrna.ts`**, but **fixed** before it drives any block:
- **word-boundary** matching, not substring `includes` (kills "foil"→`oil`, "microscope"→`scope`, etc.);
- drop the promiscuous tokens identified (`oil`, `te `, `gel`, `spray`, `cream`, `solution`, `serum`, `scope`, `lead`, `armor`, …);
- classify categories into **hard-RRNA** (COFEPRIS permit, SENASICA, CITES, SEDENA) vs **NOM-only**.
Severity: a partida matching a **hard-RRNA** category with no declared exemption → **error** ("requiere regulación no arancelaria: <categoría>; no elegible para T1 simplificado", per regla 3.7.5 which bars non-NOM RRNA from the simplified régimen). A **NOM-only** match → **warning** (NOMs are explicitly carved out of the 3.7.5 prohibition). Declared exemption (matching `partida.identifiers`/`noms`) suppresses the finding. A **corpus test** over realistic descriptions gates the hard block (must show no false positives before it ships). `src/engine/rrnaDetector.ts` delegates to the shared module to end divergence.

### 4.3 Per-consignee $2,500 aggregate (T1 ineligibility)
Group promotable partidas by consignee identity (`partida.consigneeId`, see §6); if any consignee's summed `valorAduanaUsd` > $2,500 USD → error: **"Consignatario <id>: valor agregado $X excede $2,500 USD — no elegible para despacho simplificado T1 (regla 3.7.5); use pedimento ordinario."** This is ineligibility, not fraud — do not frame as "fraccionamiento" (that suspicious-pattern detection stays in the risk engine, Phase C). Skip rows whose consignee identity is empty (do not bucket all empties together → false positives). **Scope note:** this catches intra-pedimento aggregation only; cross-pedimento/per-period aggregation is out of scope (no offline history join here).

### 4.4 Catalog validation
- **País** (`paisOrigenDestino`, `paisVendedor`): resolve via `shared/parsing/catalogs.resolveCountry`, extended to accept **alpha-3** (e.g. `CHN`→`CN`) as well as alpha-2/names; unknown → error.
- **UMC** (`partida.umc`): `buildPedimento` first normalizes the source unit through a new `mapUnitToUmc(unit)` (token→Apéndice-7 numeric code; default `'6'` PIEZA on blank/unmapped), then prevalidation validates the resulting code against `UMC_CODES` (the 21-code Apéndice 7 seed). Do **not** validate raw free-text units against the seed.
- **Aduana** (`header.customsEntryCode`, `customsClearanceCode`): validate the aduana clave against an `ADUANA_CODES` static seed (the ~50 SAT aduanas). Fix the build fixtures/UI to emit real codes (current samples `'4'`/`'850'` are not real aduanas). Unknown → error, surfaced loudly.
- **Patente** (`header.agent.patente`): trim, then `^\d{4}$` + present; padrón lookup deferred. Bad format → error.

New seeds live in `shared/pedimento/catalogs.ts` (`UMC_CODES`, `ADUANA_CODES`, `mapUnitToUmc`).

### 4.5 Header totals vs partidas (guards edited/imported pedimentos)
Check `valorDolares ≈ Σ valorAduanaUsd` (±0.01), `totalBultos == partidas.length`, `pesoBrutoKg ≈ Σ weightKg` (±0.001); mismatch → error. **Documented tautology:** on the pure build path `buildPedimento` computes these totals from the same partidas, so this can never fire there — it exists to guard an externally-supplied or import-data-edited pedimento (where header and partidas can diverge). Its unit test MUST use a hand-crafted inconsistent `Pedimento`, not `buildPedimento` output. (If/when an import-data header-override path is added, point the same check there.)

### 4.6 Origin gate (operator-supplied)
A partida whose resolved `paisOrigenDestino` is blank → error: "Partida N: país de origen no declarado." Because the courier manifest carries no manufacture-origin, **the operator supplies it at generation time** (§6): `buildPedimento` sets `paisOrigenDestino` from the operator-provided origin (falling back to `s.originCountry` if ever present). País de origen (P.O/D, Anexo 22 Apéndice 4) is mandatory per partida for courier T1 imports — there is no generic-origin exemption.

### 4.7 Currency basis (USD)
The pedimento value basis is USD. `buildPedimento` converts a non-USD source value to USD when derivable (MXN via `customsValueUsd / tipoCambio`; guard `tipoCambio > 0` and finite); a partida whose source currency is non-USD and non-convertible → error: "Partida N: moneda <X> no convertible; declare en USD o proporcione tipo de cambio." (Full multi-currency FX is out of scope — no offline rate source. Real feed is 100% USD; Phase A permits MXN/EUR/CAD at ingestion, the declaration boundary is stricter — intentional layering.)

## 5. Reject-blocks-filing

`POST /api/manifests/:id/pedimento-pdf` (`server/src/routes/pedimentoUpload.ts`) reads the manifest's `prevalidation` and refuses with **422** when `status === 'REJECTED'`: "No se puede adjuntar el pedimento: la prevalidación está RECHAZADA." Guard added immediately after the `req.file` check, before MIME/scan/`saveFile`. A null/absent prevalidation (pedimento never generated) is allowed through (only REJECTED blocks). `computeLock` unchanged.

## 6. `buildPedimento` + request changes

`shared/pedimento/buildPedimento.ts` and the `POST /:id/pedimento` route (`server/src/routes/pedimento.ts`):
- **Operator origin (`BuildOptions.partidaOrigins`):** add an optional map keyed by shipment `guideId` (or partida secuencia) → ISO origin code, supplied in the request body. `buildPedimento` sets `paisOrigenDestino = partidaOrigins[key] ?? s.originCountry ?? ''`. The route validates/passes it through; `validatePedimentoInput` accepts the new field.
- **País split:** `paisVendedor ← s.platform.countryOfOrigin || s.procedenceCountry` (seller/platform; falls back to procedencia — resolves to `'CN'` on the real feed, which is valid); stop copying `originCountry` into both.
- **Per-partida consignee id:** set `partida.consigneeId = s.consignee.curp ?? s.consignee.rfc` (new optional field on `PedimentoPartida`). Decryption already happens before build (`pedimento.ts:37` `decryptShipment`), so these are plaintext.
- **UMC normalization:** `umc = mapUnitToUmc(s.unit)` (replacing `s.unit || '6'`).
- **USD conversion (§4.7):** convert non-USD `customsValueUsd` when derivable, else leave for prevalidation to reject.

`PedimentoPartida` gains `consigneeId?: string` in `shared/types/pedimento.ts`.

## 7. Files

**Create:** `shared/pedimento/rrna.ts` (+ test), `shared/pedimento/catalogs.ts` (`UMC_CODES`, `ADUANA_CODES`, `mapUnitToUmc`, + test).
**Modify:** `shared/pedimento/prevalidate.ts` (+ test — bulk of the work), `shared/pedimento/buildPedimento.ts` (+ test), `server/src/routes/pedimento.ts` (operator origin in body + `validatePedimentoInput`, + test), `shared/types/pedimento.ts` (`consigneeId`, `BuildOptions.partidaOrigins`), `shared/parsing/taxId.ts` (`GENERIC_RFCS`), `shared/parsing/catalogs.ts` (`resolveCountry` alpha-3), `server/src/routes/pedimentoUpload.ts` (REJECTED guard + test), `src/engine/rrnaDetector.ts` (delegate to shared), `src/context/T1Context.tsx` (remove prevalidador import + case), `shared/pedimento/buildPedimento.test.ts` (real aduana/UMC/origin in fixtures).
**Delete:** `src/engine/prevalidador.ts`.

## 8. Testing

- **Unit** (`shared/pedimento`): each rule isolated — checksum block + generic-RFC exempt (incl. CURP); RRNA hard vs NOM-only severity + the promiscuous-token corpus (assert "foil/microscope/gel pen" do NOT match); per-consignee aggregate (two partidas same consignee >$2,500 → reject; ≤$2,500 → pass; empty-identity skipped); each catalog (unknown país incl. alpha-3 CHN→CN, UMC via mapUnitToUmc, aduana, patente); header-totals on a **hand-crafted inconsistent** Pedimento; origin gate (blank → reject; operator-supplied → pass); ported structural checks (secuencia dup, qty, description, empty-partidas, MJ warning). Happy-path pedimento → `APPROVED`.
- **`buildPedimento` test:** país split (origin vs vendedor distinct), `consigneeId` populated (CURP for real rows), `mapUnitToUmc`, operator `partidaOrigins` applied, MXN→USD.
- **Integration** (`server/test/routes`): `POST /:id/pedimento` with operator origins → `APPROVED`; without → `REJECTED` (origin); `POST /:id/pedimento-pdf` → 422 when REJECTED, succeeds when APPROVED.
- **Regression:** full server + frontend suites green after deleting the frontend prevalidador.

## 9. Out of scope (deferred)

- RFC homoclave verification (needs legal name; `taxId.ts` documents this).
- Full multi-currency FX (only MXN↔USD via `tipoCambio`).
- SAT padrón-de-agentes lookup for patente.
- Cross-pedimento/per-period $2,500 aggregation and fraccionamiento *pattern* detection (risk engine, Phase C).
- Tasa-global tier correctness (`buildPedimento.ts:30` hardcodes 19% IVA, ignoring 17%/19%/33.5% tiers) — flagged, separate fix.
- SAAI M3 record 505/551/557 fidelity, real-time transmission (Phase D / future).

## 10. Risks / trade-offs

- **RRNA is the over-reach risk.** The detector rewrite (word boundaries, dropped tokens, NOM carve-out) and the corpus gate are prerequisites to the hard block — enforcement must NOT ship on the current substring lists. Tune the lists against the corpus *first*, then enable REJECT.
- The origin-supply path adds request-body surface; keeping origin at the declaration boundary (not the immutable shipment record) is deliberate.
- Static aduana/UMC seeds may be incomplete; unknown-code rejections are surfaced loudly so gaps are easy to find and extend (logged, not silent).
- Deleting the frontend prevalidador is verified safe (no routed consumer); `T1Provider` stays mounted to avoid unrelated test churn.
