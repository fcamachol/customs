# ANAM Compliance Remediation — Master Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Scope note:** This plan spans multiple independent subsystems (ANAM reporting, auth/security, risk engine, privacy/PII, government integration, governance docs). Per the writing-plans skill, each **Phase** below is independently shippable and could be split into its own plan. Execute phases in order; within a phase, tasks are mostly parallelizable except where **Dependencies** say otherwise.

**Goal:** Remediate every finding in `docs/SGA_Customs_Full_Strategic_ANAM_Report_2026-06-22.md`, each re-verified against current code (branch `feat/t1-risk-engine-core`) by an independent adversarial agent.

**Architecture:** Two-layer fixes wherever possible — correct the source *and* add a guard rail (prevalidation rule, CI gate, or test) so the defect cannot silently regress. Customs-correctness fixes live in `shared/`; auth/security/storage in `server/`; UI in `src/`. Government integrations (FIEL, SAAI M3, VUCEM) are built behind typed seams with no-op/dev adapters so the rest of the app stays testable.

**Tech Stack:** TypeScript (ESM, `"type":"module"`), Vitest, Express, PostgreSQL (node-pg-migrate), React + Vite, `xlsx` (SheetJS), bcrypt, otplib, AES-256-GCM (`node:crypto`).

## Global Constraints

- **Branch off `main`** for each phase (or one feature branch per phase); do not commit directly to `main`.
- **TDD:** write the failing test first, watch it fail, implement, watch it pass, commit. Frequent atomic commits.
- **Test commands:** root `npx vitest run <path>`; server `npm --prefix server test`; typecheck `npx tsc --noEmit` (root) and in `server/`. Baseline today: **315 tests green (178 root + 137 server)** — never regress this.
- **`contribuciones` stays a REQUIRED field** in `shared/types/pedimento.ts` (now `[]`), never made optional/deleted.
- **Single source of truth:** canonical generic fraction, privileged-role list, $2,500 cap, normalization, and `entityKey` must each live in exactly one module and be imported everywhere.
- **Encoding:** ANAM `.txt` outputs are Latin-1/ASCII (accent-stripped), pipe-delimited, with Julian-day `veeemmnnn.ddd` filenames — never UTF-8 BOM/CRLF.
- **Fail-closed:** secrets (`JWT_SECRET`, `FIELD_ENCRYPTION_KEY`, `BLIND_INDEX_PEPPER`) must throw at boot in production; rate-limit/MFA enforcement must default to on (`NODE_ENV==='test'` may relax limiters only).
- **Audit everything:** new export/sign/transmit/ARCO actions must write a `recordAudit` entry through the existing hash chain, fail-closed (audit must succeed before the artifact is delivered).
- **Do not touch `shared/risk/legacyParity.ts`** — it is a faithful 8-signal Excel reproduction and must keep parity; new signals are expected to diverge from it (document in `PARITY.md`).

---

## Re-Verification Results (all 25 findings independently re-checked)

| ID | Area | Finding | Verdict | Sev | Effort |
|----|------|---------|---------|-----|--------|
| F01 | ANAM | Pedimento builder computes IVA contribution (forbidden T1) | **live** | P0 | S |
| F02 | ANAM | Builder emits real HS codes, not generic 9901/9902; self-contradicts validator | **live** | P0 | S |
| F03 | ANAM | Ficha 124/LA generator missing (.txt/.zip) | **live** | P1 | L |
| F04 | ANAM | Ficha 125/LA monthly report generator missing | **live** | P1 | L |
| F05 | ANAM | RFC/CURP checksum is warning, not blocking error (prevalidator) | **live** | P1 | S |
| F06 | Security | Hardcoded JWT fallback secret | **partial** (prod already guarded by `index.ts`) | P2 | S |
| F07 | Security | No global rate limiting / login brute-force protection | **live** | P1 | M |
| F08 | Security | High/critical CVEs in xlsx, tar, glob | **live** | P1 | M |
| F09 | Security | No JWT revocation / refresh tokens | **live** | P1 | M |
| F10 | Security | MFA opt-in, not mandatory for privileged roles | **live** | P1 | M |
| F11 | Security | No input schema validation library | **live** | P2 | M |
| F12 | Risk | Leetspeak/homoglyph/token-split bypass piracy & prohibited | **live** | P1 | M |
| F13 | Risk | Split-shipment 2×$2,499 evades $2,500 cap | **live** | P0 | M |
| F14 | Risk | Name-typo recurrence evasion (no fuzzy entity resolution) | **live** | P1 | L |
| F15 | Legacy | `src/engine/*` unreachable dead code (forbidden tax calc, toy seal) | **live** (dead code — safe to delete) | P1 | S |
| F16 | Integration | No FIEL/e.firma signing (only toy seal) | **live** | P0 | XL |
| F17 | Integration | No SAAI M3 fixed-width generator/transmitter | **live** | P1 | L |
| F18 | Integration | No denied-party/sanctions screening (OFAC/BIS/EU/UN) | **live** | P0 | L |
| F19 | Integration | No VUCEM/COVE/MVE/e-AWB integration | **live** (accepted deferral) | P2 | M |
| F20 | Privacy | name/address/email/phone plaintext in JSONB | **live** (deliberate, for dedup) | P1 | L |
| F21 | Privacy | No LFPDPPP program (aviso, ARCO, retention, breach) | **live** | P1 | L |
| F22 | Compliance | No ISO 27001 / ISMS evidence | **live** (target, not legal mandate) | P1 | XL |
| F23 | Ops | No retention/backup/BCP-DRP; 5-yr expediente unmet | **live** | P1 | L |
| F24 | Risk | Two divergent manifest parsers | **partial** (legacy is dead code; prod path is strict) | P3 | S |
| F25 | Report | Stale red-team claims (NaN→0, locale, unweighted, etc.) | **live** (report correction warranted) | P3 | S |

**Net:** 21 live, 2 partial (F06, F24), 2 report-corrections (F19 partial-deferral, F25). **Zero false.** Two report sections need correction (F06's "startup does not fail" is refuted by an existing prod guard; the §4 red-team table audited dead legacy code — see F25).

## Dependency & Sequencing Notes

- **F20 is the keystone for identity.** F13, F14, F16, F18 all key on consignee identity (`entityKey`). Implement F20's `entityKey`/blind-index seam early, or build F13/F14/F18 against the current `entityKey()` and re-point to the token when F20 lands. **Recommendation:** do F20's `entityKey` centralization first (cheap), defer full encryption migration.
- **F03 + F04** share zip-dependency + authority-export + audit plumbing — build together.
- **F16 has two tracks:** Track 1 (delete toy seal, stop treating structural APPROVED as legal, add "not legally submittable" banner) is **S effort, ship immediately**; Track 2 (real CSD/e.firma + VUCEM transmission) is XL and externally blocked on SAT credentials.
- **External blockers (cannot complete without third-party input):** F03/F04 (official Ficha layouts), F16 Track 2 (CSD certs + SAT/VUCEM contract), F17 (Anexo 22 layout + SAT sandbox), F22 (pen-test engagement).
- **Report-only / cleanup (do last, fast):** F24, F25, F19 doc reclassification, F06 report correction.

---

# Phase 0 — P0 Blockers (code, fast wins)

These are legally/operationally critical, small, and unblock confidence in the pedimento path. Do first.

### Task F01: Stop computing IVA contribution in T1 pedimento builder

**Files:**
- Modify: `shared/pedimento/buildPedimento.ts` (~line 30)
- Modify: `shared/pedimento/prevalidate.ts` (partida loop)
- Test: `shared/pedimento/buildPedimento.test.ts`, `shared/pedimento/prevalidate.test.ts`

**Approach:** A T1/IMD pedimento must carry NO contributions. `buildPedimento.ts:30` unconditionally emits `contribuciones: [{ concepto:'IVA', tasa:19, importe: customsValue*tc*0.19 }]`. Emit `contribuciones: []` and add a prevalidate guard that REJECTS any T1 partida carrying contributions, so this can never silently regress.

- [ ] **Step 1:** In `shared/pedimento/buildPedimento.ts`, replace the IVA-bearing array at line 30 with `contribuciones: [],` and add a comment citing the T1/IMD no-contribution rule.
- [ ] **Step 2:** In `shared/pedimento/prevalidate.ts`, inside the `p.partidas.forEach` loop add: `if (p.header.clave === 'T1' && pa.contribuciones && pa.contribuciones.length) errors.push(`Partida ${pa.secuencia}: T1/IMD no admite contribuciones (regla de no contribución).`);`
- [ ] **Step 3 (test):** In `buildPedimento.test.ts` assert `expect(ped.partidas[0].contribuciones).toEqual([])` for the T1/IMD build.
- [ ] **Step 4 (test):** In `prevalidate.test.ts` change `basePedimento()`'s partida to `contribuciones: []` (so well-formed fixture still APPROVES); add a test that a partida with non-empty `contribuciones` on a T1 pedimento is REJECTED (message matches `/contribuci/`).
- [ ] **Step 5:** Run `npx vitest run shared/pedimento` and `npm --prefix server test -- pedimento`; grep for any other `PedimentoPartida` constructor re-adding IVA.

**Tests:** built partidas have `contribuciones === []`; bad contributions → REJECTED; well-formed fixture still APPROVED; live `POST /:id/pedimento` returns/persists no IVA line.

**Risks:** `contribuciones` is required in the type — keep it as `[]`, do not delete/optionalize. Any PDF/print layer iterating `partida.contribuciones` must tolerate empty. Persisted historical pedimentos still carry the bad IVA line — optional backfill, out of scope for code fix.

**Dependencies:** none.

---

### Task F02: Force generic 9901/9902 fraction in pedimento builder

**Files:**
- Create: `shared/pedimento/fraction.ts`
- Modify: `shared/pedimento/buildPedimento.ts:24`, `shared/pedimento/prevalidate.ts:31`, `shared/export/layoutExport.ts`
- Test: `shared/pedimento/buildPedimento.test.ts`, `shared/pedimento/prevalidate.test.ts`, `shared/export/layoutExport.test.ts`

**Approach:** `buildPedimento.ts:24` sets `fraccion: s.hsCode.replace(/\./g,'')` — the real product HS code, which the prevalidator (`/^990[12]00\d{2}$/`) rejects. Centralize the canonical generic fraction + regex in one module so builder, prevalidator, and layout export agree (also fixes the 8-char vs 10-char mismatch).

- [ ] **Step 1:** Create `shared/pedimento/fraction.ts` exporting `GENERIC_T1_FRACTION = '99010001'` (8-char), `GENERIC_T1_FRACTION_LAYOUT = '9901000100'` (10-char padded), `GENERIC_FRACTION_RE = /^990[12]00\d{2}$/`, and `genericFractionFor(shipment?)` (default 9901; seam for 9902).
- [ ] **Step 2:** `buildPedimento.ts:24` → `fraccion: genericFractionFor(s)` (import from `./fraction`).
- [ ] **Step 3:** `prevalidate.ts:31` → use imported `GENERIC_FRACTION_RE` instead of the inline literal.
- [ ] **Step 4:** `layoutExport.ts` → import `GENERIC_T1_FRACTION_LAYOUT` instead of the local `'9901000100'` literal.
- [ ] **Step 5 (test):** In `buildPedimento.test.ts` add a regression test feeding a REAL hsCode (`'8517.13.0001'`) and assert `ped.partidas[0].fraccion === '99010001'` and `prevalidatePedimento(ped).status === 'APPROVED'`.
- [ ] **Step 6:** Add a unit test asserting `GENERIC_FRACTION_RE.test(GENERIC_T1_FRACTION) === true` and that the layout form maps to the same significant digits.

**Tests:** real hsCode → fraccion forced to generic → APPROVED; layout export still emits `'9901000100'`; new regression test fails on current code, passes after.

**Risks:** keep both 8-char and 10-char forms in the shared module (collapsing breaks the export column). Historical persisted pedimentos with real-HS fraccion are not retro-fixed.

**Dependencies:** none. (Existing tests masked this by feeding already-generic codes.)

---

### Task F13: Cross-row $2,500 aggregation by consignee (split-shipment cap)

**Files:**
- Modify: `shared/risk/ruleset.ts`, `shared/risk/signals.ts`, `shared/risk/classify.ts`, `shared/pedimento/prevalidate.ts`, `shared/pedimento/buildPedimento.ts`, `shared/types/pedimento.ts`
- Test: `shared/risk/signals.test.ts`, `shared/risk/classify.test.ts`, `shared/pedimento/prevalidate.test.ts`

**Approach:** No code aggregates value across rows by RFC, so 2×$2,499 for one consignee passes the per-row cap. Add a per-entity `agregado` signal in the risk engine and a grouping pass in the prevalidator, both keyed on `entityKey(consignee)`. Keep the per-row cap as a floor.

- [ ] **Step 1:** `ruleset.ts` — add weight `agregado` (~20, mirroring `monto`) to `RULESET.weights` and the `Weights` union; `resolveWeights`/`maxPoints` iterate keys so they pick it up.
- [ ] **Step 2:** `signals.ts` — add `'agregado'` to `SignalId`; add `entityValueTotal: Record<string,number>` to `EntityContext`; in `gradeSignals`, after the per-row `monto` block: `const ek = entityKey(s.consignee); const total = ctx.entityValueTotal[ek] ?? s.customsValueUsd; if (total > t.montoMax) add('agregado', (total - t.montoMax)/t.montoMax, 'Valor agregado por consignatario excede el umbral', { entityTotal: total, cap: t.montoMax });`
- [ ] **Step 3:** `classify.ts` PASS 1 loop — build `entityValueTotal[ek] = (entityValueTotal[ek] ?? 0) + (Number.isFinite(s.customsValueUsd) ? s.customsValueUsd : 0)` and pass into `ctx`.
- [ ] **Step 4:** `shared/types/pedimento.ts` — add optional `consigneeKey?: string` to `PedimentoPartida`.
- [ ] **Step 5:** `buildPedimento.ts` — set `consigneeKey: entityKey(s.consignee)` per partida (import `entityKey` from `../risk/signals`).
- [ ] **Step 6:** `prevalidate.ts` — keep per-partida `>2500`; add a grouping pass keyed by `pa.consigneeKey ?? parseIdFromObservation(pa.observation) ?? `seq:${pa.secuencia}``, summing `valorAduanaUsd`; push a distinct error `Consignatario <id>: valor agregado $<sum> USD excede $2,500 USD (posible envío fraccionado).` for any group over cap. Extract `SPLIT_CAP_USD = 2500` constant reused by both checks.
- [ ] **Step 7 (test):** `signals.test.ts` — one RFC summing 4998 fires `agregado`; two distinct RFCs at 2499 do not. `classify.test.ts` — two same-RFC $2,499 rows escalate above verde with `agregado` reason; two different RFCs stay verde. `prevalidate.test.ts` — two same-consignee partidas at $2,499 → REJECTED.
- [ ] **Step 8:** Re-run `distribution.test.ts` (501-row golden); adjust band cutoffs only if rojo% drifts outside the 3–12% target.

**Tests:** see steps; full `shared` suite green.

**Risks:** new signal changes `maxPoints` — recalibrate the golden distribution. Keep `SPLIT_CAP_USD` single-sourced so per-row and aggregate can't drift.

**Dependencies:** **F20** — when blind-index tokenization lands, `entityValueTotal` must key on the same tokenized identity. Coordinate the key derivation (shared `entityKey`).

---

### Task F15: Delete unreachable legacy `src/engine/*` (forbidden tax calc + toy seal)

**Files:**
- Delete: `src/engine/{taxCalculator,prevalidador,t1Compliance,rrnaDetector}.ts`, `src/context/T1Context.tsx`, `src/mockData.ts`
- Modify: `src/App.tsx`, `src/components/ConfigurationView.test.tsx`, `src/types/t1.ts` (prune engine-only types)

**Approach:** Confirmed dead code: `T1Provider` is mounted but no rendered view calls `useT1`/dispatch, so the forbidden tax math and non-crypto toy seal never execute. Delete wholesale; TS compiler is the safety net.

- [ ] **Step 1:** Re-confirm zero live consumers: `grep -rn 'useT1|useManifest|useCompliance|usePedimento|useTax|useUserRole|calculateBatchTax|prevalidatePedimento|evaluateT1Compliance|detectRRNABatch|mockData' src/` excluding the files to be deleted (expect only `App.tsx` + `ConfigurationView.test.tsx`).
- [ ] **Step 2:** Delete the four `src/engine/*` files and the now-empty directory.
- [ ] **Step 3:** Delete `src/context/T1Context.tsx` and `src/mockData.ts`.
- [ ] **Step 4:** `src/App.tsx` — remove the `T1Provider` import and change line 61 to `return <AuthenticatedApp />;`.
- [ ] **Step 5:** `src/components/ConfigurationView.test.tsx` — remove the `T1Provider` import; simplify the Wrapper to `<AuthProvider>{children}</AuthProvider>`.
- [ ] **Step 6:** Prune `src/types/t1.ts` — KEEP `T1ComplianceRule` and `RRNACategory` (still imported by `constants/rgceRules.ts` and `constants/rrnaCategories.ts`); delete engine-only types after grep-confirming no importer.
- [ ] **Step 7:** `npx tsc --noEmit`, `npm test`/`vitest run`, `npm run build`; finally `grep -rn 'igi\|iva\|dta\|simpleHash\|VB-' src/` to confirm no residual forbidden code.

**Tests:** `tsc --noEmit` clean (primary net); full suite green; production build compiles.

**Risks:** none beyond a missed live consumer, which the compiler catches.

**Dependencies:** sequence after any other in-flight `src/types/t1.ts` edit to avoid conflicts. F16 Track 1 also edits `prevalidador.ts` — if doing both, do F15's deletion and skip F16's toy-seal edit (the file is gone).

---

# Phase 0b — P0 Legal Blockers (larger / externally gated)

### Task F18: Denied-party / sanctions screening (force-rojo signal)

**Files:**
- Modify: `shared/risk/lists.ts`, `shared/risk/signals.ts`, `shared/risk/ruleset.ts`, `shared/risk/classify.ts`, `server/src/routes/risk.ts`, `server/src/routes/catalogs.ts`
- Create: `server/src/services/deniedParties.ts`, `server/scripts/ingestSanctions.ts`, `server/migrations/<ts>_denied_parties_seed.ts`
- Test: `shared/risk/deniedParty.test.ts`, `shared/risk/lists.test.ts`, `shared/risk/classify.test.ts`, `shared/risk/hash.test.ts`

**Approach:** `denied_parties` is a write-only config key with no consumer — the engine produces bands with zero sanctions screening (a hard regulatory gap). Turn it into a screened list feeding a `denied_party` force-rojo signal, mirroring the existing `prohibidos`/`pirateria` pattern.

- [ ] **Step 1:** `lists.ts` — add `matchesDeniedParty(fields:{names:string[];ids:string[]}, list?:DeniedPartyEntry[]): string|null` (normalized exact-ID match on RFC/CURP/foreignTaxId/sender.taxId; substring/token match on names). Define `DeniedPartyEntry {name; ids?; source?:'OFAC'|'BIS'|'EU'|'UN'; program?}`.
- [ ] **Step 2:** `ruleset.ts` — add `denied_party` to `Weights` + `RULESET.weights` with a dominating value (e.g. 100).
- [ ] **Step 3:** `signals.ts` — add `'denied_party'` to `SignalId`; add `deniedParties?` to `EntityContext`; in `gradeSignals` call `matchesDeniedParty({names:[consignee.name,sender.name], ids:[curp,rfc,foreignTaxId,sender.taxId]})` and on match `add('denied_party', 1, 'Coincidencia en lista de sancionados (...)', {matched,source}, 'rojo')`.
- [ ] **Step 4:** `classify.ts` — add `deniedParties?` to `ScoreOptions`, thread into `ctx`, and include it in `resolved.lists` (so `rulesetHash` captures the screening list for replay).
- [ ] **Step 5:** `server/src/routes/risk.ts` — `const deniedParties = await loadConfig<DeniedPartyEntry[]>('denied_parties');` into `scoreOptions`.
- [ ] **Step 6:** Create `server/src/services/deniedParties.ts` (`loadDeniedParties()` + normalization) and `server/scripts/ingestSanctions.ts` (download/parse OFAC SDN, BIS Entity List, EU CFSP, UN Consolidated → `DeniedPartyEntry[]` → upsert config). Document periodic refresh via the repo's cron infra.
- [ ] **Step 7:** Add migration seeding an empty `[]` `denied_parties` config row; optionally add `denied_parties` to `SUPER_ADMIN_CONFIG_KEYS` to prevent tampering.
- [ ] **Step 8 (test):** `deniedParty.test.ts` + `lists.test.ts` (name/ID/diacritic/empty-list); `classify.test.ts` (matched party → rojo with reason even when other signals clean); `hash.test.ts` (changing the list changes `ruleset_hash`). Assert `legacyParity` output unchanged; note divergence in `PARITY.md`.

**Tests:** see steps; sanctioned shipment → rojo; clean shipment unaffected; replay-hash integrity.

**Risks:** false positives on common names (tune name matching; prefer ID match). External list refresh cadence must be operationalized.

**Dependencies:** **F20** for tokenized identity keying (coordinate).

---

### Task F16: FIEL / e.firma signing — Track 1 now, Track 2 build

**Files (Track 1):** `src/engine/prevalidador.ts` (or N/A if F15 deleted it), `src/types/t1.ts`, `server/src/services/manifestLock.ts`, `src/components/*` (banner), `docs/legal/fiel-efirma-integration.md`
**Files (Track 2):** `server/src/crypto/certStore.ts`, `server/src/crypto/cfdiSigner.ts`, `server/src/services/transmission/vucemClient.ts`, `server/src/routes/pedimento.ts`, `server/migrations/<ts>_add_pedimento_seal_and_transmission.ts`, `server/package.json`

**Approach:** No real signing exists; the only "seal" is a 32-bit non-crypto hash, yet `manifestLock` treats structural `APPROVED` as legally final. **Track 1 (S, ship immediately):** remove the toy seal, decouple structural validity from legal sealing, surface a "NOT legally submittable" banner. **Track 2 (XL, externally gated):** real CSD/e.firma RSA-SHA256 sello + VUCEM transmission.

- [ ] **Step 1 (T1):** Remove `simpleHash`; rename `generateVistoBueno` → `generateStructuralCheckId` (non-legal id); in `src/types/t1.ts` rename `vistoBueno` → `structuralCheckId` with a doc comment "NOT a digital signature". *(Skip if F15 already deleted `src/engine/*`; instead ensure no server path labels anything a legal seal.)*
- [ ] **Step 2 (T1):** `manifestLock.ts` — lock on a signed/transmitted state (sello or acuse present), not structural `APPROVED`; keep "structurally valid" distinct from "legally sealed".
- [ ] **Step 3 (T1):** Add a persistent UI banner + `docs/legal/fiel-efirma-integration.md` stating documents are simulation-only / not legally submittable until signing + transmission ship.
- [ ] **Step 4 (T2 design):** Choose libs (`@peculiar/x509` + WebCrypto for X.509; `node:crypto` `createSign('RSA-SHA256')` for the sello; `node-forge` for `.pfx`). Document SAT cadena-original/sello algorithm. **BLOCKED on:** valid CSD/e.firma certs + SAT/VUCEM web-service contract.
- [ ] **Step 5 (T2):** `certStore.ts` — load `.cer`/`.key`/`.pfx`, decrypt private key, validate chain/validity/serial against SAT roots, store cert material encrypted-at-rest via `fieldCrypto.ts`. Never log keys/passwords.
- [ ] **Step 6 (T2):** `cfdiSigner.ts` — build cadena original, compute RSA-SHA256 sello, return typed `Sello {sello,noCertificado,fechaSellado,cadenaHash}`.
- [ ] **Step 7 (T2):** Migration adding `sello,no_certificado,sello_at,cadena_hash,transmission_status,acuse,acuse_at` to manifests.
- [ ] **Step 8 (T2):** `pedimento.ts` — sign only after structural prevalidation passes AND an authorized signer with a valid cert acts; persist real sello + audit entry.
- [ ] **Step 9 (T2):** `vucemClient.ts` — implement SAT/VUCEM contract, submit signed pedimento, persist acuse, behind a feature flag + per-env credentials.
- [ ] **Step 10 (test):** Track 1 — grep test that `simpleHash` is gone and no module returns a legal seal from a non-crypto hash; `computeLock` no longer locks legally on structural APPROVED. Track 2 — self-signed throwaway cert round-trip (`createSign`/`createVerify` RSA-SHA256); pedimento→sign→persist integration; transmission gated as integration-only.

**Risks:** Track 2 cannot be completed in-repo without SAT certs/contract — Track 1 is the shippable risk reduction. Coordinate seal inputs with F20 tokenization.

**Dependencies:** F20 (PII tokenization for seal inputs); F15 (toy-seal file may be deleted there). External: CSD certs, SAT/VUCEM contract.

---

# Phase 1 — ANAM Reporting (P1)

### Task F03: Ficha 124/LA generator (.txt in .zip)

**Files:** Create `shared/export/ficha124.ts` (+test), `server/src/services/ficha124Data.ts`, `server/migrations/<ts>_monthly_address_history.ts`; Modify `server/src/routes/exports.ts`, `server/src/storage/files.ts`, `server/src/services/monthlyHistory.ts`, `src/components/ReportTabs.tsx`.

**Approach:** Recurrence detection exists; the statutory notice generator does not. Build a pure pipe-delimited ASCII `.txt` generator from aggregated monthly recurrence rows, zip with `veeemmnnn.ddd` naming, persist + expose as a download. Add `monthly_address_history` for the address-based trigger.

- [ ] **Step 1 (BLOCKER):** Pin the official Ficha 124/LA format (column order, pipe delimiter, ASCII/Latin-1 encoding, header/trailer, `veeemmnnn.ddd` Julian naming) from the ANAM 78/LA reference. Treat as the acceptance contract before coding.
- [ ] **Step 2:** Add a zip lib (`adm-zip` or `jszip`) to `server/package.json`.
- [ ] **Step 3:** Create `shared/export/ficha124.ts` — pure `buildFicha124Txt(rows, period): string` + `fichaFileName(period, sequence)` (Julian-day). IO-free.
- [ ] **Step 4:** `server/src/services/ficha124Data.ts` — reuse `loadHistoryCounts(period)` to find consignees with `total > 3`, join back via `loadShipments`/`decryptShipment` for identity/operation detail.
- [ ] **Step 5:** Add `monthly_address_history` table + `recordAddresses`/`loadAddressHistoryCounts` in `monthlyHistory.ts`; call `recordAddresses` alongside `recordNames` in `routes/risk.ts`. Ensure `deleteManifestHistory` clears address rows too.
- [ ] **Step 6:** Add `ficha_124` to `FileKind` in `storage/files.ts`.
- [ ] **Step 7:** `exports.ts` — `GET /:id/ficha124.zip`: build rows → render `.txt` → zip with correct filename → `Content-Type: application/zip` (add a generic sender; do NOT reuse the xlsx-hardcoded `send()`) → persist via `saveFile` → `EXPORT_FICHA124` audit (fail-closed) → enforce `assertManifestAccess` + masking.
- [ ] **Step 8:** Wire a Ficha 124 download into `ReportTabs.tsx`.
- [ ] **Step 9 (test):** `ficha124.test.ts` — byte-exact layout, pipe delimiting, ASCII (no BOM/CRLF), header/trailer, deterministic order, Julian filenames for Jan 1 / Dec 31 / leap year. Service test (>3 selection). Integration: 200, `application/zip`, filename matches, zip contains one round-trippable `.txt`, audit row written, artifact retrievable.
- [ ] **Step 10:** Mark Ficha 124/LA generation implemented in the audit docs.

**Risks:** **format is external** — guessing produces an ANAM-rejected file; validate against the official spec/consultant. Latin-1 accent handling. New address-history write path has no backfill (forward-only; document).

**Dependencies:** External (official format). Shares plumbing with F04.

---

### Task F04: Ficha 125/LA monthly report generator

**Files:** Create `server/src/services/ficha125.ts` (+test); Modify `server/src/routes/consolidated.ts`, `shared/types/reports.ts`, `server/package.json`.

**Approach:** The monthly branch in `consolidated.ts` only re-dates the generic XLSX. Add a dedicated official-format Ficha 125/LA generator (pipe-delimited ASCII `.txt` in `.zip`, Julian naming) on a new authority-only route, keeping the XLSX export intact.

- [ ] **Step 1 (BLOCKER):** Confirm the authoritative Ficha 125/LA layout (columns, delimiter, encoding, header/trailer, Julian `.txt`-in-`.zip` naming) from the ANAM/DGIA-AGACE spec; capture as a single `FICHA_125_FIELDS` constant.
- [ ] **Step 2:** Add the zip dep (shared with F03).
- [ ] **Step 3:** Create `server/src/services/ficha125.ts` — pure builder over the monthly rows (reuse the consolidated SELECT shape extended with pedimento number, HS, customs value, origin, consignee RFC) returning text + Julian filename; keep zip assembly separate.
- [ ] **Step 4:** Use `reportData.ts` loaders (`loadShipments`/`decryptShipment`) so PII is decrypted correctly.
- [ ] **Step 5:** Add `GET /api/ficha125` (or `/consolidated/ficha125.zip`) in `consolidated.ts`, `requireAuth` + `requireRole('autoridad','admin')`, `?period=YYYY-MM` (reuse the existing range parser), `application/zip` Julian-named attachment.
- [ ] **Step 6:** Apply the fail-closed audit pattern (`EXPORT_FICHA_125` must succeed before delivery).
- [ ] **Step 7:** Add Ficha-125 row types to `shared/types/reports.ts`.
- [ ] **Step 8 (test):** unit (exact line output, Julian filename e.g. 2026-06-23 → day 174, pipe/newline escaping), integration (400 bad period, 200 zip→txt parseable, 403 non-authority), audit fail-closed test. Update audit doc row to Implemented.

**Risks:** external layout; encoding; do not alter the existing `/consolidated.xlsx`.

**Dependencies:** External (official layout). Coordinate scaffolding with F03.

---

### Task F05: Promote RFC/CURP checksum to a blocking error in the prevalidator

**Files:** Modify `shared/pedimento/prevalidate.ts`, `src/engine/prevalidador.ts` (if not deleted by F15); Test `shared/pedimento/prevalidate.test.ts`.

**Approach:** Checksum logic exists (`isValidTaxIdStrict` in `taxId.ts`) but `prevalidate.ts` only pushes failures to `warnings`. Move to `errors` so a wrong check-digit RFC/CURP REJECTS instead of being persisted APPROVED.

- [ ] **Step 1:** In `prevalidate.ts`, replace the shape-only blocking checks (lines 21-22) and checksum warnings (23-27) with single strict blocking checks: `if (!isValidTaxIdStrict(p.header.importer.rfc)) errors.push('RFC/CURP del importador inválido (dígito verificador no coincide).');` and the equivalent for `p.header.agent.agentRfc`.
- [ ] **Step 2:** `isValidTaxIdStrict` already handles RFC and CURP via `classifyTaxId` — no kind-specific branching.
- [ ] **Step 3:** Add a strict check for `p.header.agent.agencyRfc` (currently unvalidated); flag to reviewer as additive.
- [ ] **Step 4 (test):** flip the lines 56-62 test to assert `REJECTED` + error matching `/importador/i` and `/dígito verificador|inválido/`; confirm the "approves well-formed pedimento" test still passes (base RFCs pass strict checksum).
- [ ] **Step 5:** Apply the same strict-as-error treatment in `src/engine/prevalidador.ts` for client/server parity (if F15 hasn't deleted it).
- [ ] **Step 6:** Grep test/seed fixtures + sample manifests for shape-valid/checksum-invalid RFC/CURP and correct them to real values.

**Tests:** base fixture APPROVED; bad-checksum importer/agent RFC REJECTED; valid CURP in importer field APPROVED; server route persists REJECTED for bad checksum.

**Risks:** APPROVED→REJECTED is intended but may break demo/integration fixtures — audit first. Homoclave chars remain unverified (reduces, not eliminates, false-accepts).

**Dependencies:** coordinate with any `src/engine/prevalidador.ts` change (F15 may delete it; then this task is server-only).

---

# Phase 2 — Security Hardening (P1/P2)

### Task F07: Global rate limiting + login brute-force protection

**Files:** Add `express-rate-limit` to `server/package.json`; Create `server/src/middleware/rateLimit.ts`; Modify `server/src/app.ts`, `server/src/routes/auth.ts`, `server/src/routes/reports.ts`; Test `server/test/routes/rateLimit.test.ts`.

**Approach:** Only an in-memory per-user limiter on `reports.json` exists; `/auth/login` is unthrottled. Add three layers via `express-rate-limit`: global per-IP, tight login limiter (IP+username, `skipSuccessfulRequests`), and the existing PII limiter routed through the shared module.

- [ ] **Step 1:** Add `express-rate-limit@^7` to `server/package.json`; `npm --prefix server install`.
- [ ] **Step 2:** Create `server/src/middleware/rateLimit.ts` with `globalLimiter` (60s/~300 per IP, skip health), `loginLimiter` (15min/~10 failed, key `ip+lower(username)`, `skipSuccessfulRequests:true`, 429 + Retry-After), `piiReportLimiter` (60s/60, key `userId??ip`). No-op all when `NODE_ENV==='test'`.
- [ ] **Step 3:** `app.ts` — `app.use('/api', globalLimiter)` after `express.json`; keep `trust proxy` but tighten to the known proxy hop count.
- [ ] **Step 4:** `auth.ts` — `authRouter.post('/login', loginLimiter, …)`; ensure failed credential/MFA branches stay 401 so they count as failures.
- [ ] **Step 5:** `reports.ts` — import `piiReportLimiter`, delete the local `RATE_*`/`hits`/`rateLimit` block.
- [ ] **Step 6 (test):** `rateLimit.test.ts` — ~10 bad-password logins → 429 + Retry-After; valid login before threshold → 200; successful logins never accumulate; global limiter 429 past cap. Pre-existing suites stay green (limiter no-op under test).
- [ ] **Step 7:** Comment the multi-instance caveat + `rate-limit-redis` upgrade path.

**Tests:** see steps.

**Risks:** `trust proxy: true` allows XFF spoofing — tighten to actual hop count. In-memory store is per-process (note Redis path). Office-NAT lockout mitigated by IP+username keying + failure-only counting. Gate the test no-op strictly on `NODE_ENV==='test'`.

**Dependencies:** none.

---

### Task F08: Patch high/critical CVEs (xlsx, tar, glob) + audit CI gate

**Files:** Modify `package.json`, `server/package.json`, both lockfiles; Create `.github/workflows/audit.yml`.

**Approach:** `npm audit` confirms root 1H (xlsx, no registry fix) and server 1C/7H/3M (xlsx/tar/glob + vitest/vite dev). Three tracks: pin xlsx to the SheetJS CDN build (patches both CVEs), bump bcrypt→6 (tar) and node-pg-migrate→8 (glob), bump server vitest→4 (critical). Add an audit CI gate.

- [ ] **Step 1:** Capture baseline `npm audit` counts in root and `/server`.
- [ ] **Step 2:** Replace `"xlsx": "^0.18.5"` in both manifests with `"xlsx": "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"`; `npm install` in each.
- [ ] **Step 3:** Run xlsx-touching tests: root `npx vitest run src/lib/extractMawb.test.ts`; server manifestIngest/exports/consolidated/artifacts. Verify `write()` buffer/array casts still hold.
- [ ] **Step 4:** Bump `bcrypt@^6` (+`@types/bcrypt`) in server; rebuild native; run auth/password tests (v5 hashes verify under v6).
- [ ] **Step 5:** Bump `node-pg-migrate@^8` (devDep); smoke-test `npm --prefix server run migrate` on a scratch DB.
- [ ] **Step 6:** Bump server `vitest@^4.1.9` to match root; re-run server suite, fix any v2→v4 config drift.
- [ ] **Step 7:** Re-run `npm audit` in both → target 0 high/critical; pin any residual via `overrides`.
- [ ] **Step 8:** Create `.github/workflows/audit.yml` running `npm audit --audit-level=high` in root and `/server` on PRs.
- [ ] **Step 9:** Document the xlsx CDN-pin rationale; bump VERSION + CHANGELOG.

**Tests:** affected suites green after each bump; `npm audit --audit-level=high` exit 0 in both; CI job passes.

**Risks:** CDN tarball URL deps aren't registry-mirrored (vendor/mirror for CI resilience). bcrypt@6 native rebuild for the deploy platform. node-pg-migrate v7→v8 CLI/format changes. Confirm CDN xlsx still bundles under vite for the browser client.

**Dependencies:** coordinate the vitest bump with any other lockfile-touching task.

---

### Task F09: JWT revocation via `token_version`

**Files:** Create `server/migrations/<ts>_token_version.ts`; Modify `server/src/auth/token.ts`, `server/src/auth/middleware.ts`, `server/src/routes/auth.ts`, `server/src/routes/users.ts`, `src/context/AuthContext.tsx`; Test `server/src/auth/token.test.ts`, `server/src/auth/middleware.test.ts`.

**Approach:** Add a `token_version` int column to `users`, embed it as a `tv` claim, and have `requireAuth` compare `tv` against the user's current version (one indexed PK lookup). Bumping the version (logout-all, password/role change, compromise) invalidates all outstanding tokens. Add a real `POST /api/auth/logout`.

- [ ] **Step 1:** Migration: add `users.token_version int not null default 0`.
- [ ] **Step 2:** `token.ts` — add `tv` to the `Claims` type; include `user.token_version` when signing.
- [ ] **Step 3:** `middleware.ts` — after crypto verify, look up the user's current `token_version`; 401 on mismatch / deactivated / missing user. (Fold any future `users.disabled` check into this same query.)
- [ ] **Step 4:** `auth.ts` — add `POST /logout` that bumps `token_version` (logout-all); bump on password change.
- [ ] **Step 5:** `users.ts` — bump `token_version` on role change.
- [ ] **Step 6:** `AuthContext.tsx` — call logout endpoint; handle 401-on-revoked by clearing session.
- [ ] **Step 7 (test):** token round-trip carries `tv`; middleware rejects a token whose `tv` < current; logout bumps version and invalidates prior tokens; role change invalidates.

**Tests:** see steps.

**Risks:** one extra DB lookup per authed request (indexed PK — negligible). Keep stateless-ish; no global blacklist.

**Dependencies:** land alongside F06 (auth hardening). Adjacent to F10.

---

### Task F10: Mandatory MFA for privileged roles

**Files:** Create `server/src/auth/roles.ts`; Modify `server/src/auth/token.ts`, `server/src/routes/auth.ts`, `server/src/routes/users.ts`, `server/src/auth/mfa.ts`; Test `server/test/routes/mfa.test.ts`, `server/test/routes/mfaEnforcement.test.ts`. Frontend login must handle a new enrollment state.

**Approach:** Gate MFA on role, not just `mfa_enabled`. A privileged user (admin/super_admin/autoridad) without MFA gets only a short-lived enrollment-scoped grant usable solely for `/mfa/setup` + `/mfa/enable`; once enabled, TOTP required every login. Capturista keeps opt-in.

- [ ] **Step 1:** Create `server/src/auth/roles.ts` — `PRIVILEGED_ROLES = ['admin','super_admin','autoridad'] as const` + `isPrivilegedRole(role)`. Single source of truth.
- [ ] **Step 2:** `auth.ts` `/login` — after password verify: if `mfa_enabled`, require valid `code` (401 `mfa_required` on missing/invalid). If `isPrivilegedRole(role) && !mfa_enabled`, issue a 10-min `scope:'mfa_enrollment'` token and return 403 `{error:'mfa_enrollment_required', enrollmentToken}`.
- [ ] **Step 3:** `token.ts` — add optional `scope?:'mfa_enrollment'` to `Claims`. Add `rejectEnrollmentScope` middleware on all authed routes except `/mfa/setup` + `/mfa/enable` (401 if scope is enrollment).
- [ ] **Step 4:** `/mfa/enable` — on success, mint and return a FULL session token.
- [ ] **Step 5:** `users.ts` — allow creating privileged users but record an MFA-pending audit note; enforcement happens at first login.
- [ ] **Step 6:** Add `MFA_ENFORCEMENT=enforce|warn` (default `enforce`) escape hatch for migration windows.
- [ ] **Step 7 (test):** `mfaEnforcement.test.ts` — admin w/o MFA → 403 + enrollmentToken (not full); enrollment token rejected on protected routes but accepted on setup/enable; after enable, full token works; capturista unaffected.

**Tests:** see steps.

**Risks:** existing admins get forced into enrollment on deploy — use `MFA_ENFORCEMENT=warn` for the migration window. Frontend must handle the new state.

**Dependencies:** frontend login UI coordination; adjacent to F09.

---

### Task F06: Fail-closed JWT secret (hardening — prod already guarded)

**Files:** Modify `server/src/auth/token.ts`, `server/src/index.ts`, `server/.env.example`; Test `server/test/auth/token.test.ts`; correct `docs/...ANAM_Report...md`.

**Approach:** Re-verification downgraded this to **partial**: `index.ts:4-7` already throws in production when `JWT_SECRET` is missing/default. Residual risk: it relies on `NODE_ENV==='production'` being set. Move secret resolution into `token.ts` with a fail-closed default (allow the dev constant ONLY when `NODE_ENV` is `development`/`test`; else throw), and correct the report.

- [ ] **Step 1:** `token.ts` — replace `?? 'change-me-in-production'` with a lazy/memoized resolver: use `JWT_SECRET` if set and non-default; else if `NODE_ENV` is `test`/`development` use a clearly-labeled dev constant; else throw `Error('JWT_SECRET must be set to a non-default value')`. Resolve lazily so test imports that set env first don't crash at import.
- [ ] **Step 2:** Keep `index.ts` boot guard as defense-in-depth; have it call the shared resolver to avoid duplicating the literal.
- [ ] **Step 3:** Remove the duplicated `'change-me-in-production'` literal from `index.ts`.
- [ ] **Step 4:** `.env.example` — leave `JWT_SECRET=` empty with a generate-with comment (don't seed the weak value).
- [ ] **Step 5 (test):** with `NODE_ENV` unset/`production` and no `JWT_SECRET`, `signToken` throws; with the default literal in production, throws; real secret round-trips; dev/test still work.
- [ ] **Step 6:** Correct the report: note the "startup does not fail" claim is refuted by the `index.ts` guard; reclassify as a hardening item.

**Tests:** see steps; existing `token.test.ts` passes under `NODE_ENV=test`.

**Risks:** import-time vs call-time — use lazy/memoized resolution. Stricter path surfaces previously-silent prod misconfig (intended).

**Dependencies:** none (shares the fail-closed pattern with F20).

---

### Task F11: Introduce zod request-schema validation

**Files:** Add `zod` to `server/package.json`; Create `server/src/validation/{zod,middleware,schemas}.ts`; Modify `server/src/app.ts` + each route; Test `server/src/validation/middleware.test.ts`, `server/src/routes/users.test.ts`.

**Approach:** No validation library exists; routes do ad-hoc `req.body` checks. Add zod (ESM-native, zero deps), a reusable `validate({body,params,query})` middleware, centralized schemas, and a `ZodError`→structured-400 branch in the global error handler. Hardening/consistency (routes are auth-gated + parameterized SQL), hence P2.

- [ ] **Step 1:** Add `zod@^3`; `npm --prefix server install`.
- [ ] **Step 2:** Create `validation/zod.ts` (re-export `z`), `validation/middleware.ts` (`validate()` via `.safeParse`, assigns coerced values back, throws typed `ValidationError` carrying `ZodError.flatten()`).
- [ ] **Step 3:** `validation/schemas.ts` — named schemas mirroring current checks (createUserBody with `role: z.enum([...])`, loginBody, mfaEnableBody, client CRUD, configKeyParam enum, validatedRfcBody, manifestCreateBody, importDataBody allowlist, pedimentoBody incl. nested importer/agent, riskBody `period` regex, idParam).
- [ ] **Step 4:** `app.ts` global error handler — detect `ZodError`/`ValidationError` → `400 {error:'Validation failed', details}` before the 500 fallback.
- [ ] **Step 5:** Migrate routes one file at a time — replace manual destructure+`if(!x)400` with `validate({body:schema})` after `requireAuth`/`requireRole` (and after `multer.single` for manifests). Remove the dead `validatePedimentoInput` helper.
- [ ] **Step 6:** Keep non-shape logic in handlers (super_admin config gating, lock/ingestion 409s, row-count 413/422).
- [ ] **Step 7:** `tsc --noEmit` + full suite; fix handlers assuming un-coerced types.
- [ ] **Step 8 (test):** `middleware.test.ts` (valid passes coerced; invalid → 400 + details; enum rejects bad role); extend `users.test.ts` for the 400 shape.

**Tests:** existing route suites pass (parity); new validation tests.

**Risks:** behavioral parity — migrate incrementally and keep messages aligned with frontend error handling (`ConsultaView.tsx` on this branch).

**Dependencies:** none; reuse for F20/F21 request schemas.

---

# Phase 3 — Risk Engine Robustness (P1)

### Task F12: Evasion-resistant matching (leetspeak / homoglyph / token-split)

**Files:** Create `shared/risk/normalize.ts` (+test); Modify `shared/risk/lists.ts`, `shared/risk/signals.ts`, `shared/risk/ruleset.ts`; Test `shared/risk/lists.test.ts`.

**Approach:** Matching is substring-only (NFD+lowercase), so `N1ke`, `Guc ci`, Cyrillic `Nіke`, `l1quido` bypass. Add a shared canonicalizer producing `{loose, tight}` forms applied symmetrically to haystack and every list entry; match on either. Bump `RULESET.version`.

- [ ] **Step 1:** Create `shared/risk/normalize.ts` — `canonicalize(s)` → `{loose, tight}`. `loose` = NFD diacritic strip + confusable/homoglyph fold + lowercase (preserves boundaries). `tight` = loose + leetspeak map (`0→o,1→i/l,3→e,4→a,5→s,7→t,@→a,$→s`) + remove all non-alphanumeric. Small audited `CONFUSABLES` (Cyrillic а,е,о,р,с,х,і,ѕ,у; Greek) + `LEET` tables, each documented.
- [ ] **Step 2:** `lists.ts` — replace local `norm` with imports; rewrite `matchesBrand`/`matchesProhibited` to match when `d.loose.includes(entry.loose) || d.tight.includes(entry.tight)`. Memoize default-list canonicals at module scope.
- [ ] **Step 3:** Guard tight-form false positives: only use tight path for needles whose tight length ≥ 4. Document the threshold.
- [ ] **Step 4:** `signals.ts` — import shared `norm`/`canonicalize` (replace the duplicated inline `norm`); keep exported `norm` loose-form semantics identical so `bbdd`/address key spaces don't shift.
- [ ] **Step 5:** Bump `RULESET.version` (e.g. `'2026-07'`) so `rulesetHash`/`ruleset_version` reflect changed matching.
- [ ] **Step 6 (test):** `normalize.test.ts` — `N1ke→Nike`, `Guc ci→Gucci`, Cyrillic `Nіke→Nike`, `l1quido→liquido`, `p4st1lla→pastilla` all match; SKU-bearing benign strings + short fragments do NOT. Extend `lists.test.ts` keeping all existing positive/negative + injected-override assertions.
- [ ] **Step 7:** Update hash/parity baselines only for intended changes; keep `legacyParity` semantics (it shares the matchers — fixed for free).

**Tests:** see steps; full `shared/risk` suite green.

**Risks:** false positives — the ≥4 tight threshold + loose-always-on mitigate. Coordinate `RULESET.version` bump with other persistence/parity work to avoid baseline collisions.

**Dependencies:** sequence relative to any legacy `runSignals` removal so both paths' tests stay valid.

---

### Task F14: Fuzzy entity resolution for recurrence (name-typo evasion)

**Files:** Create `shared/risk/nameMatch.ts` (+test); Modify `shared/risk/signals.ts`, `shared/risk/classify.ts`, `shared/risk/ruleset.ts`, `server/src/services/monthlyHistory.ts`, `server/migrations/<ts>_monthly_history_block_key.ts`; Test `shared/risk/signals.test.ts`.

**Approach:** `bbdd`/smurfing key on exact normalized name, so `Juan Peres` ≠ `Juan Perez`. Add fuzzy clustering (phonetic blocking key + bounded Damerau-Levenshtein) for ID-less consignees, while RFC/CURP stays authoritative. Additive union → preserves monotonicity. Persist a `name_block_key` so cross-manifest DB recurrence unifies typos too.

- [ ] **Step 1:** Create `shared/risk/nameMatch.ts` — `blockingKey(name)` (token-sorted, diacritic-stripped, Spanish-phonetic-folded: s/z/c, b/v…), `similar(a,b,maxDistance)` (bounded Damerau-Levenshtein on `norm`), `resolveNameClusters(names, opts)` (union-find: join iff blockingKey matches OR distance ≤ threshold = `min(2, ceil(len*0.15))`).
- [ ] **Step 2:** `ruleset.ts` — add `thresholds.fuzzyNameMaxDistance` (default 2) + `thresholds.fuzzyEntityResolution` flag (default true) with `resolveThresholds` plumbing (admin-tunable/reversible for audit traceability).
- [ ] **Step 3:** `classify.ts` PASS 1 — cluster over the union of current-manifest names + DB history keys; re-aggregate `monthlyNameCount` by cluster canonical; for consignees with no valid RFC/CURP, replace the `entityKey` name-fallback with the cluster canonical (never merge distinct valid RFC/CURP holders).
- [ ] **Step 4:** `signals.ts` — `bbdd` lookup + `entityKey` name-fallback consult `ctx.nameCanonical(normName)` (default identity for back-compat); RFC/CURP-first behavior unchanged.
- [ ] **Step 5:** `monthlyHistory.ts` — `recordNames` also persists `blockingKey(raw)`; migration adds `name_block_key` (+ backfill + index); `loadHistoryCounts` returns the block key; keep `consignee_name_norm` + its unique constraint.
- [ ] **Step 6 (test):** `nameMatch.test.ts` — `Juan Peres`~`Juan Perez`; token-order invariance; `Maria`!~`Mario` (tune/doc); distinct valid RFCs never merge. `signals.test.ts` — `bbdd` fires when a typo variant pushes cluster count >3; smurfing counts ID-less typo variants as one entity.
- [ ] **Step 7:** Run `properties.test.ts`/`legacyParity.test.ts`/`distribution.test.ts`; recalibrate bands if rojo% drifts outside 3–12%; document.

**Tests:** see steps.

**Risks:** false-positive merges (tune threshold; ID-authoritative when present). Band drift from newly-unified recurrence.

**Dependencies:** **F20** (shared `entityKey`/tokenized identity).

---

# Phase 4 — Privacy, Data Protection & Governance (P1)

### Task F20: Encrypt remaining PII + HMAC blind-index for dedup

**Files:** Modify `server/src/crypto/fieldCrypto.ts`, `server/src/routes/{manifests,risk,pedimento}.ts`, `server/src/services/{reportData,monthlyHistory}.ts`, `shared/types/shipment.ts`, `shared/risk/signals.ts`, `server/migrations/<ts>_monthly_history_bidx.ts`; Create `server/src/crypto/blindIndex.ts`, `server/scripts/backfill-pii-encryption.ts`; Test `server/src/crypto/{fieldCrypto,blindIndex}.test.ts`.

**Approach:** name/address/email/phone are plaintext (deliberately, for dedup). Encrypt them with the existing AES-256-GCM scheme and replace dedup-on-plaintext with deterministic HMAC-SHA256 blind-index tokens over the *same* normalization, so dedup (V4/V5/V8) is exactly preserved while raw PII is encrypted at rest — including the cross-manifest `monthly_history` table the original finding missed.

- [ ] **Step 1:** Create `server/src/crypto/blindIndex.ts` — `blindIndex(value) = base64url(HMAC-SHA256(BLIND_INDEX_PEPPER, normalized(value)))`. Dedicated `BLIND_INDEX_PEPPER` env (32-byte, validated/fail-closed like `FIELD_ENCRYPTION_KEY`, separate so rotation is independent). Per-field normalizers matching current dedup `norm` (name/email: lower+trim+NFD+collapse; address: + strip punctuation; phone: digits only).
- [ ] **Step 2:** `fieldCrypto.ts` — extend beyond the 5 identity fields: AES-GCM encrypt `consignee.{name,address,email,phone,city,postalCode}`, `sender.{name,address,email,phone,city}`, `platform.email`. Add `encryptSender`/`encryptPlatform` (or a single `encryptShipmentPii`) + matching decrypt; `decryptShipment` also decrypts sender/platform. Guard idempotency on the `v1:` prefix.
- [ ] **Step 3:** Attach blind-index sidecars (`consignee.nameBidx`, `consignee.addressBidx`, optional email/phone) computed BEFORE encryption; add optional `*Bidx?` fields to `shared/types/shipment.ts`.
- [ ] **Step 4:** Refactor dedup to consume tokens: in `classify.ts`/`signals.ts` key `nameCounts`/`addressCounts`/`monthlyNameCount`/`addressEntities` by token. Since `risk.ts` already decrypts, recompute `blindIndex(norm(name))` in-memory for in-manifest counts; switch `entityKey()` name-fallback to the token.
- [ ] **Step 5:** Migrate `monthly_history` — add `consignee_name_bidx` (backfill = HMAC of existing norm during cutover, then drop `consignee_name_norm`); `recordNames` stores `blindIndex(raw)`; `loadHistoryCounts` groups by token; `risk.ts:81` `monthlyDbNames` + `legacyParity` comparison use tokens consistently.
- [ ] **Step 6:** Fix all write paths to encrypt the full set (`manifests.ts:42` also encrypts sender/platform; promote path copies verbatim; decrypt idempotent).
- [ ] **Step 7:** Audit every read/display/export path to decrypt (`risk.ts` incl. `sender.address`, `pedimento.ts`, `reportData.ts`, artifacts). Add a CI grep gate for raw `.consignee.`/`.sender.`/`.platform.` reads outside decrypt helpers.
- [ ] **Step 8:** Write `backfill-pii-encryption.ts` (resumable, transaction-batched; skip `v1:` values; populate bidx; monthly_history token backfill). `decryptField` passthrough keeps reads safe mid-migration.
- [ ] **Step 9:** Document `FIELD_ENCRYPTION_KEY` + `BLIND_INDEX_PEPPER` (fail-closed at boot); make `decryptField` log/metric on non-`v1` post-backfill.
- [ ] **Step 10 (test):** `blindIndex.test.ts` (same normalized input → same token; formatting variants collide; pepper rotation changes tokens). `fieldCrypto.test.ts` (round-trip all new fields on consignee/sender/platform; idempotent; `decryptShipment` covers nested). Dedup parity: scoring before/after migration yields identical bands on a fixture.

**Tests:** see steps; risk-engine dedup parity preserved.

**Risks:** must tokenize name/address EVERYWHERE persisted-normalized (incl. monthly_history) or cross-manifest recurrence breaks. Backfill correctness; provision pepper before flipping writes. Coordinate with in-progress engine commits (de29590, 8e1cc75) to avoid merge churn.

**Dependencies:** existing `fieldCrypto`; in-progress risk-engine work settling. Keystone for F13/F14/F16/F18 identity keying.

---

### Task F21: LFPDPPP privacy program (aviso, ARCO, retention, breach)

**Files:** Create `docs/privacy/{aviso-de-privacidad,politica-de-retencion-y-supresion,plan-respuesta-a-incidentes-LFPDPPP,procedimiento-derechos-ARCO}.md`, `src/components/{AvisoPrivacidadView,ArcoRequestView}.tsx`, `server/src/routes/privacy.ts`, `server/src/services/retention.ts`, `server/migrations/<ts>_arco_requests.ts`, `server/migrations/<ts>_data_retention.ts`; Modify `src/nav.ts`, `src/components/AcercaDeView.tsx`, `src/App.tsx`, `server/src/index.ts`; Test `server/src/routes/privacy.test.ts`, `src/components/AvisoPrivacidadView.test.tsx`.

**Approach:** Two layers — (1) author the four governance docs; (2) make them real in-product: publish the aviso (all roles), an ARCO intake page + endpoint logging to the hash-chained audit + an `arco_requests` table with SLA timers, and a retention service + migration enforcing a documented retention class (dry-run first). Reuse `fieldCrypto`, `recordAudit`, RBAC.

- [ ] **Step 1–4:** Author the four docs (aviso integral with responsable identity, data categories, purposes, transfers to ANAM/SAT, ARCO channel, security summary, version/effective date; retention+supresion schedule reconciling the 5-yr expediente with data-minimization; incident-response plan with notification timeline; ARCO procedure with identity proof + SLA).
- [ ] **Step 5:** Migrations — `arco_requests` (id, request_type enum, subject_identifier as **blind-index HMAC** not raw PII, contact, status enum, received_at, due_at, resolved_at, resolution_notes) and `data_retention_class` (store_name, retention_days, disposition) seeded from policy + optional `retention_run_log`.
- [ ] **Step 6:** `server/src/routes/privacy.ts` — `POST /api/privacy/arco` (intake → insert row, compute `due_at`, `recordAudit({action:'arco.request'})`); `GET` (admin-only) list/manage; `PATCH` status (audited); `GET /api/privacy/aviso` metadata. Mount in `index.ts`.
- [ ] **Step 7:** `server/src/services/retention.ts` — read `data_retention_class`, find past-retention records, anonymize/mark for supresion, write `retention_run_log` + audit. Default DRY-RUN behind `RETENTION_ENFORCE=1`; cron-invocable (never auto-delete on boot).
- [ ] **Step 8:** UI — `AvisoPrivacidadView.tsx` (mirror Marco Legal Card styling), `ArcoRequestView.tsx` (form → `/api/privacy/arco` + confirmation); link aviso from `AcercaDeView.tsx`.
- [ ] **Step 9:** `src/nav.ts` — add `'aviso'`/`'arco'` sections (aviso visible to ALL roles incl. autoridad); route in `App.tsx`.
- [ ] **Step 10 (test):** `privacy.test.ts` — ARCO intake inserts row + `due_at` + one chained audit entry; management routes admin-only (401/403 else); retention dry-run reports without deleting, enforce mode anonymizes only past-retention records leaving audit_log intact. UI form test. Update audit-doc rows to Implemented.

**Tests:** see steps.

**Risks:** retention-vs-erasure conflict must be reconciled in policy; never auto-delete; store ARCO subject as blind-index (align with F20).

**Dependencies:** **F20** (blind-index for subject identifier); shares retention concepts with F23.

---

### Task F23: Data retention / backup / BCP-DRP + pluggable storage

**Files:** Create `docs/ops/{DATA-RETENTION-POLICY,BCP-DRP}.md`, `server/src/storage/backends/{index,local,s3}.ts`, `server/src/storage/lifecycle.ts`, `server/src/jobs/retentionSweep.ts`, `server/migrations/<ts>_files_retention_columns.ts`, `infra/backup/{pg_backup,storage_sync}.sh`, `infra/{Dockerfile,docker-compose.yml}`; Modify `server/src/storage/files.ts`, `server/.env.example`, `README.md`; Test `server/test/storage/lifecycle.test.ts`.

**Approach:** Two written policies (5-yr retention; BCP/DRP with RTO/RPO) plus enforcement: a pluggable storage backend (S3 with SSE + versioning, local default for dev), retention metadata on the files table, a lifecycle sweep that never deletes before `retain_until` / under legal hold, and backup tooling + restore-drill runbook.

- [ ] **Step 1–2:** Write `DATA-RETENTION-POLICY.md` (scope, 5-yr minimum, legal-hold override, deletion procedure, LFPDPPP mapping) and `BCP-DRP.md` (RTO/RPO, managed-Postgres + automated backup, off-site file replication, restore-drill cadence, failover runbook).
- [ ] **Step 3:** Migration — add `retain_until timestamptz default now()+5y`, `legal_hold boolean default false`, `deleted_at timestamptz null` to `files`; backfill `retain_until`.
- [ ] **Step 4:** Create `storage/backends/index.ts` (`StorageBackend` interface put/get/delete/exists), `local.ts` (wrap current fs), `s3.ts` (`@aws-sdk/client-s3`, SSE-KMS, versioning) selected by `FILE_STORAGE_BACKEND`.
- [ ] **Step 5:** Refactor `files.ts` to delegate to the selected backend and set `retain_until` on insert; keep `FileMeta`/content-hash contract.
- [ ] **Step 6:** `storage/lifecycle.ts` — `deleteExpiredFiles()` removes only rows with `retain_until < now() AND legal_hold=false AND deleted_at IS NULL`; guarded `deleteFile()` refuses early/held deletion.
- [ ] **Step 7:** `jobs/retentionSweep.ts` — scheduled sweep; document cadence.
- [ ] **Step 8:** Infra — `Dockerfile`, `docker-compose.yml` (app + Postgres ref), `pg_backup.sh` (pg_dump → versioned off-site), `storage_sync.sh` (sync → object store).
- [ ] **Step 9:** `.env.example` — `FILE_STORAGE_BACKEND`, S3 bucket/region/KMS, `RETENTION_YEARS`, backup targets; README runbook links.
- [ ] **Step 10 (test):** `lifecycle.test.ts` — refuse deletion when `retain_until` future or `legal_hold`; delete only when past + no hold. Backend parity (local vs mocked S3 identical bytes/hash); existing `files.test.ts`/`filesSecurity.test.ts` still pass; migration defaults test.

**Tests:** see steps.

**Risks:** retention floor must never be violated; reconcile with F21 erasure; align backup/object-store encryption with F20 KMS choices.

**Dependencies:** shares object-storage work + retention reconciliation with F21; align with F20.

---

### Task F22: ISO 27001 / ISMS evidence package (governance)

**Files:** Create `docs/security/00..14` (scope, infosec policy, risk methodology, risk register, SoA, risk treatment plan, access-control, cryptography, secure-dev, incident-response, BCP/DR, retention+backup, supplier/cloud, pentest plan, internal-audit) + `README.md`; Correct `docs/full_anam_compliance_audit_2026-06-22.md`, `docs/SGA_Customs_Full_Strategic_ANAM_Report_2026-06-22.md`, `docs/ANAM_T1_compliance_audit.md`.

**Approach:** Author a real, repo-tracked ISMS package targeting ISO/IEC 27001:2022, with an SoA mapping Annex A controls to the codebase's actual controls (MFA, hash-chained audit, PII encryption, RBAC, CORS allowlist, path-traversal sanitization) and gaps linked to the treatment plan. Documentation deliverable (no app-code changes); pen-test is the external dependency. Also correct the "required for prevalidators" wording → "expected/recommended engineering target, not a published ANAM legal mandate."

- [ ] **Step 1:** `docs/security/README.md` index + ISMS scope (server/, shared/, src/, Postgres, infra) stating the 27001:2022 engineering-target framing.
- [ ] **Step 2:** `00` scope/context + `01` infosec policy.
- [ ] **Step 3:** `02` risk methodology + `03` risk register seeded from existing audits (plaintext PII, no rate limiting, no CSRF/origin binding, no pen-test, no BCP/DR, weak RFC/CURP, evasion, no denied-party screening).
- [ ] **Step 4:** `04` SoA — enumerate Annex A controls, applicable/NA + justification, cite REAL implemented controls as evidence; mark gaps "planned" → treatment plan.
- [ ] **Step 5:** `05` risk treatment plan (owner/date/treatment per risk, cross-ref F20/F07/F23 etc.).
- [ ] **Step 6:** `06`–`12` supporting policies (access control, cryptography, secure-dev incl. SAST/dependency review, incident response aligned to LFPDPPP, BCP/DR RTO/RPO, retention+backup aligned to LA 59-V/162 & CFF 30, supplier/cloud).
- [ ] **Step 7:** `13/README.md` pentest plan (OWASP ASVS/Top 10 scope, partner engagement, evidence placeholder).
- [ ] **Step 8:** `14` internal-audit + management-review cadence/template.
- [ ] **Step 9:** Correct the three report docs: status Missing → "In progress — ISMS package at docs/security/"; reword "required for prevalidators" → "expected/recommended; not a published ANAM legal requirement."
- [ ] **Step 10:** Tick RNF-06/07 boxes in `docs/superpowers/plans/2026-06-19-compliance-remediation.md`.

**Tests:** documentation — verify `docs/security/` is git-tracked with all artifacts; refutation greps now return substantive policy content; every SoA control claiming an implementation cites real code.

**Risks:** pen-test is external/schedulable (cannot be authored). Don't overstate ISO as legal mandate.

**Dependencies:** F20 (feeds cryptography policy/SoA); F07/F23 statuses referenced by the treatment plan; external pen-test partner.

---

# Phase 5 — Integration Build-out (P1/P2)

### Task F17: SAAI M3 fixed-width generator + transmitter abstraction

**Files:** Create `shared/pedimento/saaiM3/{layout,fields,encodeSaaiM3}.ts` (+test), `server/src/services/saaiTransmitter/{types,index,noopAdapter,fileDropAdapter,sftpAdapter}.ts`, `server/src/routes/saai.ts`, `server/migrations/<ts>_add_saai_transmission.ts`; Modify `server/src/routes/pedimento.ts`, `server/package.json`.

**Approach:** Build (1) a pure fixed-width encoder serializing a `Pedimento` to positional records (500/501/505/trailer) from a declarative layout, and (2) a transmitter abstraction with pluggable adapters (noop default for dev/test, file-drop, sftp). Wire into `POST /:id/pedimento` after prevalidation, persisting the artifact + a `saai_transmissions` row.

- [ ] **Step 1 (BLOCKER):** Source the SAAI M3 layout (positions/lengths/types/record codes for 500/501/505/trailer) per Lineamientos Técnicos VOCE / Anexo 22 into `layout.ts` as a declarative table.
- [ ] **Step 2:** `fields.ts` formatters — `formatN` (right/zero-pad), `formatA` (left/space-pad, ASCII/accent-strip), `formatD` (YYYYMMDD), with overflow-throws.
- [ ] **Step 3:** `encodeSaaiM3.ts` — pure: `Pedimento` → records via layout, trailer with counts, spec terminator, returns `{content, lineCount, sha256}`.
- [ ] **Step 4 (test):** `encodeSaaiM3.test.ts` — byte-exact substring-offset assertions, padding, accent stripping, overflow throws, deterministic sha256, trailer counts.
- [ ] **Step 5:** Transmitter — `types.ts` (`SaaiTransmitter.transmit(record)`), `index.ts` (factory from `SAAI_TRANSMITTER=noop|filedrop|sftp`), `noopAdapter` (persist only, SIMULATED), `fileDropAdapter` (`SAAI_OUTBOX_DIR`), `sftpAdapter` (`ssh2`, env config).
- [ ] **Step 6:** Add `ssh2` as optional dep, lazy-imported only in `sftpAdapter`.
- [ ] **Step 7:** Migration — `saai_transmissions` (id, manifest_id FK, file_id FK, sha256, line_count, status, adapter, acuse, error, transmitted_at, created_by).
- [ ] **Step 8:** `pedimento.ts` — after prevalidation APPROVED, `encodeSaaiM3` → persist `.txt` (`kind:'saai'`) → insert row → invoke configured transmitter → audit `GENERATE_SAAI_M3`/`TRANSMIT_SAAI_M3`; idempotent on sha256.
- [ ] **Step 9:** `routes/saai.ts` — `GET /:id/saai.txt` + `GET /:id/saai/status`, role-gated + `assertManifestAccess`.
- [ ] **Step 10:** Run shared + server tests, typecheck, manual `POST /:id/pedimento`.

**Tests:** unit byte-exact golden; integration (transmission row + downloadable artifact; rejected prevalidation → no transmission; `GET /saai.txt` correct fixed-width body).

**Risks:** external layout (Anexo 22) + SAT sandbox credentials. Consolidate the two prevalidate paths so the encoder consumes one canonical `Pedimento`.

**Dependencies:** External (layout + sandbox). Depends on prevalidator consolidation (F15/F05).

---

### Task F19: Reclassify VUCEM/COVE/MVE/e-AWB as documented boundary + remove dead field

**Files:** Modify `shared/types/pedimento.ts`, `server/src/services/manifestLock.ts`, `src/engine/prevalidador.ts` (if present); Create `docs/INTEGRATION_BOUNDARIES.md`, `server/src/services/integrations/govTransport.ts`; Correct the report docs.

**Approach:** This is an accepted deferral, not a bug (real integrations need gov credentials/WSDL/e.firma — out of scope). Remove the misleading dead `coveAcuseValor` field, make the deferral explicit via a typed `GovTransport` seam + boundary doc, and reclassify in the reports.

- [ ] **Step 1:** Confirm `coveAcuseValor` has zero readers/writers; remove it from `PedimentoHeader`.
- [ ] **Step 2:** Create `docs/INTEGRATION_BOUNDARIES.md` — explicit canonical statement: prevalidador is a local simulation (no network I/O), manifestLock is a local proxy (not SAT/VUCEM transmission), no VUCEM/COVE/MVE/e-AWB integration; list each system, payload, required auth, deferral status.
- [ ] **Step 3:** Create `server/src/services/integrations/govTransport.ts` — typed `GovTransport` interface + `NotImplementedGovTransport` returning `{supported:false, reason}`.
- [ ] **Step 4:** Update `manifestLock.ts` + `prevalidador.ts` comments to reference the boundary doc instead of aspirational prose.
- [ ] **Step 5:** Reclassify F19 in the two report docs from open finding → documented accepted boundary; note `coveAcuseValor` removed.
- [ ] **Step 6 (test):** `tsc --noEmit` (nothing referenced the field); full suite; a unit test asserting `NotImplementedGovTransport.transmitPedimento()` returns the documented unsupported result.

**Tests:** see steps.

**Risks:** minimal (field is dead).

**Dependencies:** light overlap with F20 (identifier tokenization) — no hard ordering.

---

# Phase 6 — Report Corrections & Cleanup (P3, fast, do last)

### Task F24: Remove dead lenient parser + correct the "divergent parsers" framing

**Files:** Modify `shared/parsing/manifestParser.ts`, `shared/parsing/normalize.ts`; remove/trim `shared/parsing/manifestParser.test.ts`; correct `docs/full_anam_compliance_audit_2026-06-22.md`.

**Approach:** Re-verification: **partial** — the "strict one in production" framing is wrong (production `validateManifest` is built ON TOP of the same `mapRowToShipment` and re-parses numerics strictly). The real residual is dead `parseManifestRows`. Delete it; document `parseNumber` as internal pre-fill only; correct the doc.

- [ ] **Step 1:** Delete `parseManifestRows` + the unused `ParseResult` interface in `manifestParser.ts`; keep `mapRowToShipment`/`blankShipment`/`cleanCell`.
- [ ] **Step 2:** Remove the orphaned `manifestParser.test.ts` (or strip only the `parseManifestRows` describe block, keeping direct `mapRowToShipment` tests).
- [ ] **Step 3:** JSDoc `parseNumber` (normalize.ts) as a lenient pre-fill used only inside `mapRowToShipment`; MUST NOT be a validation gate; required numerics re-validated with `parseNumberStrict` at the boundary.
- [ ] **Step 4:** Add a re-introduction guard (eslint `no-restricted-imports`/comment) stating `validateManifest` is the only sanctioned entry point; ensure no barrel re-exports `parseManifestRows`.
- [ ] **Step 5:** `tsc --noEmit` + `npx vitest run shared/parsing`; `grep -rn 'parseManifestRows\|ParseResult' shared server src` → zero.
- [ ] **Step 6:** Correct the audit doc F24 entry: headline → "dead lenient top-level parser coexists with the production validator"; note `validateManifest` reuses `mapRowToShipment`, gates numerics via `parseNumberStrict`, rejects duplicate headers; severity low/cleanup.

**Tests:** parsing suite green; typecheck clean; grep zero.

**Risks:** none (dead code).

**Dependencies:** none.

---

### Task F25: Correct stale red-team report claims

**Files:** Modify `docs/validation_engine_top_tier_audit.md`, `docs/SGA_Customs_Full_Strategic_ANAM_Report_2026-06-22.md`; optional comments in `shared/parsing/{manifestParser,normalize}.ts`.

**Approach:** Verified: NaN→0, locale `1,000`→$1, unweighted scoring, missing required-field enforcement, and duplicate-header overwrite are ALL fixed on the production path (`parseNumberStrict` + `validateManifest` errors; weighted 0-100 scorecard). This is a documentation correction.

- [ ] **Step 1–4:** In `validation_engine_top_tier_audit.md` mark RESOLVED with code citations: 4.1 silent NaN→0 (`validateManifest.ts:50,60`), 4.2 required-field absence (`validateManifest.ts:43-78`), 4.6 duplicate-header overwrite (`validateManifest.ts:21-23`, `fileRejected:true`), 2.3 unweighted scoring (`scorecard.ts:19-21` + `ruleset.ts:30-42`).
- [ ] **Step 5:** Update the red-team table rows (#7 NaN, #8 locale) to FIXED; strike completed P0/P2 items; note `fileParser.ts` no longer exists.
- [ ] **Step 6:** Mirror the corrections in `SGA_Customs_Full_Strategic_ANAM_Report_2026-06-22.md` §4 weaknesses (lines ~199-203) and red-team rows #6/#7 (lines ~215-216).
- [ ] **Step 7:** Add a dated correction note atop each section ("Corrected 2026-06-23: items below FIXED on production path, see validateManifest.ts/normalize.ts/scorecard.ts").
- [ ] **Step 8:** Optional: comment `parseNumber` + its call sites clarifying it is the lenient pre-fill and `parseNumberStrict` is the authoritative gate (prevents re-flagging).
- [ ] **Step 9:** Confirm `fileParser.ts` is absent; drop any sentence claiming it exists.

**Tests:** run the suite to confirm the corrected report's claims; grep that no report text still asserts the stale defects as current.

**Risks:** none. Caveat for wording: `manifestParser.ts:30-34` still uses lenient `parseNumber` to populate the Shipment object — the strict guard lives in `validateManifest`; phrase the correction as "the production ingest gate rejects" rather than "the parser is strict."

**Dependencies:** do after F12/F13/F24 land so line citations stay accurate.

---

## Self-Review

- **Spec coverage:** all 25 findings have a task (F01–F25). The two report-correction findings (F06 partial, F19, F25) include the doc edits; F24 includes both cleanup and doc correction.
- **Keystone dependency (F20):** F13/F14/F16/F18 each note the `entityKey`/blind-index coupling. Recommended sequencing: centralize `entityKey` early (cheap), full F20 migration in Phase 4, then re-point.
- **External blockers flagged:** F03/F04 (Ficha layouts), F16 Track 2 (CSD/SAT contract), F17 (Anexo 22 + sandbox), F22 (pen-test). These tasks have a Step 1 BLOCKER and a shippable non-blocked portion.
- **Type consistency:** shared constants single-sourced — `GENERIC_T1_FRACTION`/`GENERIC_FRACTION_RE` (F02), `SPLIT_CAP_USD` (F13), `PRIVILEGED_ROLES` (F10), `canonicalize` (F12), `blindIndex`/`entityKey` (F20). New `SignalId`s `agregado` (F13) and `denied_party` (F18) added to `ruleset.ts` weights + `signals.ts` union consistently.

## Execution Handoff

Plan saved to `docs/superpowers/plans/2026-06-23-anam-compliance-remediation.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration. Best for this size (25 tasks).
2. **Inline Execution** — execute tasks in this session with checkpoints for review.

Recommended starting point: **Phase 0** (F01, F02, F13, F15) — all P0, small, no external blockers, immediately verifiable.
