# Validation Engine Top-Tier Audit — SGA Customs

**Date:** 2026-06-22  
**Scope:** Risk engine, prevalidation engine, RGCE rule engine, manifest ingestion validation  
**Method:** 5-agent focused red-team / benchmark swarm  
**Verdict:** Not top-tier. Solid Level-2 rules engine with clear path to Level 5.

---

## Executive Verdict

**The validation engine is not top-tier yet, but it is the strongest part of the codebase and has the cleanest path to top-tier status.**

It is currently a **Level-2 engine**: configurable, versioned, deterministic rules with good test coverage and a sound severity override. Against CBP ATS, Cotecna CRMS, ASYCUDA World dynamic selectivity, and modern sanctions-screening engines, it is missing:

- Fuzzy/semantic matching (trivially evaded by leetspeak, spacing, typos)
- Entity resolution and clustering
- Sanctions / denied-party screening
- Machine-learned scoring with feedback loops
- Item-level / fraud-type decomposition
- Real-time adaptive AI and explainability
- Robust catalog validation (aduanas, países, unidades, patentes)
- RFC/CURP checksum validation
- Row-level ingestion error reporting

**Bottom line:** The engine will catch honest mistakes and naive bad actors, but it will not stop a determined adversary or match the selectivity accuracy of modern customs platforms.

---

## 1. Maturity Assessment

| Level | Description | SGA Status |
|---|---|---|
| 1 | Static rules | Partial — some hard-coded lists |
| 2 | Configurable rules + catalogs | ✅ **Current level** |
| 3 | Fuzzy matching + entity resolution | ❌ Missing |
| 4 | Machine-learned scoring with feedback | ❌ Missing |
| 5 | Real-time adaptive AI + explainability | ❌ Missing |

SGA is approximately **2.5–3 levels below** a Level-5 top-tier engine.

---

## 2. Risk Engine Audit

### What works well
- 8-signal design covers the major T1 risk categories (ID, quantity, value, consignee/address concentration, prohibited goods, piracy, repeat importer).
- Versioned ruleset (`2026-06`) stamped on every scored row.
- Configurable thresholds with non-negative validation.
- Severity override forces `rojo` on `prohibidos` / `pirateria` regardless of score count.
- Clean separation between signals, classification, and ruleset.
- Tests verify boundary conditions.

### Critical weaknesses

#### 2.1 Substring-only matching is trivially evadable
The engine uses `d.includes(norm(b))` for brand and keyword detection. This is the weakest link.

| Attack | Example | Bypasses? |
|---|---|---|
| Leetspeak | `"N1ke air max"`, `"p1st0l4"` | ✅ Yes |
| Token splitting | `"Guc ci bolso"`, `"p i s t o l a"` | ✅ Yes |
| Extra chars | `"Samsungg galaxy"`, `"Guccii"` | ✅ Yes |
| Unicode homoglyphs | `"Nіke"` (Cyrillic і), `"Ｎike"` (fullwidth) | ✅ Yes |
| Zero-width chars | `"pistol​a"` (U+200B) | ✅ Yes |
| Synonyms | `"makeup palette"` instead of `maquillaje` | ✅ Yes |

#### 2.2 Signal portfolio is too narrow
Missing signals vs top-tier:
- Sanctions / denied-party screening (OFAC, UN, EU, UK, BIS, SAT)
- Valuation anomaly (unit-price outliers, market-price benchmarks)
- HS-code / description mismatch
- Origin-country risk and transshipment detection
- Sender/platform risk scoring
- Weight/value ratio anomalies
- Network analysis (consignee-sender-platform clustering)
- Random/stratified inspection slot

#### 2.3 Scoring is unweighted
- Score = count of fired signals. A quantity of 11 counts the same as a prohibited weapon.
- No confidence score per signal.
- Threshold override can be set to `0`, silently disabling a signal.

#### 2.4 Auditability gaps
- Keyword/brand lists are not versioned independently.
- No hash of the effective ruleset + lists.
- No shadow-mode or champion-challenger capability.

---

## 3. Prevalidation / RGCE Rule Engine Audit

### What works well
- Basic structural checks: 15-digit pedimento, T1 clave, RFC/CURP shape, value thresholds, generic HS code prefix.
- RGCE rule framework in `src/engine/t1Compliance.ts` assigns blocking/warning severities and recommended actions.
- Fractionation detection exists (3+ shipments to same RFC exceeding $2,500 total).

### Critical weaknesses

#### 3.1 Two contradictory prevalidators exist
| | Active backend (`shared/pedimento/prevalidate.ts`) | Legacy frontend (`src/engine/prevalidador.ts`) |
|---|---|---|
| Generic HS format | `99010001` (no dots) | `9901.00.01` (dots) |
| Observation format | `GUIA … VALOR … USD NOMBRE … RFC-CURP …` | `EM1\|name\|RFC:xxx` |
| Quantity validation | ❌ Not checked | ✅ Checked |
| MJ complement | ❌ Not checked | ✅ Checked |
| RRNA enforcement | ❌ Not checked | ⚠️ Upstream only |

**This divergence is a compliance hazard.** The backend can accept what the frontend rejects.

#### 3.2 No catalog validation
- Aduana-sección codes not validated.
- Patente not validated against SAT padrón de agentes.
- Country codes not validated (e.g., `XX`, `YY` accepted).
- UMC/UMT units not validated against SAT catalog.
- Currency not normalized (`"Dólar estadounidense"` stays as-is).

#### 3.3 RFC/CURP validation is weak
```ts
const RFC  = /^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$/;
const CURP = /^[A-Z]{4}[0-9]{6}[HM][A-Z]{5}[A-Z0-9]{2}$/;
```

Accepted but invalid:
- `XXXX010101AAA` (placeholder RFC)
- `AAAA000000HAAAAA00` (impossible date)
- `TOMM029922D40` (day 99, month 99)
- `AERA790828HBSRBR99` (wrong CURP checksum)

Top-tier prevalidadores compute RFC homoclave and CURP verification digit.

#### 3.4 RRNA not enforced in active prevalidator
A pedimento with `"Vitamin C supplement"` would be `APPROVED` by the backend prevalidator because RRNA detection happens upstream and is not guaranteed to block.

#### 3.5 Missing SAAI M3 fidelity
- Records 500/501 partially modeled; 505/551/557 not validated.
- No fixed-width field-level checks.
- No validation of header totals against partidas.
- No pedimento-number uniqueness / chronological checks.

---

## 4. Ingestion / Parser Validation Audit

### What works well
- Maps all 28 real `MANIFEST_TEST.xlsx` headers.
- Handles accents, case, punctuation, multi-line text.
- Correctly normalizes comma vs dot decimals and gram→kg.
- Reports unmapped headers.

### Critical weaknesses

#### 4.1 Silent coercion of bad numbers to `0`
```ts
const n = Number(t);
return Number.isFinite(n) ? n : 0;
```
`"N/A"`, `"abc"`, `"1.2.3"`, `"---"` all become `0`. There is no row-level error collector.

#### 4.2 Required-field validation is absent
Blank rows become persisted shipments with empty strings and zeros. The only downstream guard is prevalidation of the generated pedimento, not the raw data.

#### 4.3 Country / currency not normalized
- `"Porcelana"` stays as `originCountry` instead of `CN`.
- `"Dólar estadounidense"` stays as currency instead of `USD`.

#### 4.4 Date parsing absent
`arrivalDate` is stored as raw string; Excel serial dates and invalid dates pass through.

#### 4.5 Weight unit conversion minimal
Only units starting with `"g"` convert to kg. `"lb"`, `"oz"` are treated as kg.

#### 4.6 Duplicate headers silently overwrite
If two columns are named `"RFC"`, the second value wins without warning.

#### 4.7 Two parsers exist
`src/utils/fileParser.ts` is orphaned and has its own silent-failure modes (e.g., `"1,234.50"` → `123450`).

---

## 5. Red-Team Findings — Concrete Bypass Examples

### Critical bypasses

| # | Attack | Input | Result |
|---|---|---|---|
| 1 | Leetspeak piracy | `"N1ke air max"` | ✅ Bypasses piracy detection |
| 2 | Token splitting | `"Guc ci bolso"` | ✅ Bypasses piracy detection |
| 3 | Unicode homoglyph | `"Nіke"` (Cyrillic і) | ✅ Bypasses piracy detection |
| 4 | Leetspeak prohibited | `"p0lvo blanco"`, `"past1llas"` | ✅ Bypasses RRNA/prohibited detection |
| 5 | Fake RFC | `"XXXX010101AAA"` | ✅ Accepted as valid ID |
| 6 | Wrong CURP checksum | `"AERA790828HBSRBR99"` | ✅ Accepted as valid ID |
| 7 | NaN value injection | `declaredValueUsd: NaN` | ✅ Invisible to all value rules |
| 8 | Locale trick | `"Valor total declarado": "1,000"` | ✅ Parsed as `$1.00` instead of `$1,000` |
| 9 | Split shipment | 2 rows × $2,499 same RFC | ✅ Bypasses $2,500 limit (needs ≥3 rows to trigger) |
| 10 | Generic desc evasion | `"regalito de empresa"` | ✅ Bypasses generic-description check |

### High-severity bypasses

| # | Attack | Input | Result |
|---|---|---|---|
| 11 | Name typo | `"Juan Peres"` vs `"Juan Perez"` | ✅ Bypasses duplicate consignee detection |
| 12 | Address abbreviation | `"C. 1"` vs `"Calle 1"` | ✅ Bypasses duplicate address detection |
| 13 | Extra whitespace | `"Juan  Perez"` | ✅ Bypasses duplicate detection |
| 14 | Synonym substitution | `"makeup palette"` | ✅ Bypasses `maquillaje` keyword |
| 15 | Invalid fracción | `"99020001"` in import T1 | ✅ Accepted (should be `9901`) |
| 16 | Invalid aduana | `"999"` | ✅ Accepted |
| 17 | Invalid country | `"XX"` | ✅ Accepted |

---

## 6. Top-Tier Benchmark — What You're Competing Against

| Capability | CBP ATS | Cotecna CRMS | ASYCUDA 4.4 | SGA |
|---|---|---|---|---|
| Weighted rules | ✅ | ✅ | ✅ | ❌ (count only) |
| ML scoring | ✅ | ✅ | ✅ | ❌ |
| Item-level fraud decomposition | ✅ | ✅ | ⚠️ | ❌ |
| Entity resolution | ✅ | ⚠️ | ✅ | ❌ |
| Sanctions/PEP screening | ✅ | ⚠️ | ⚠️ | ❌ |
| Feedback loop from inspections | ✅ | ✅ | ✅ | ❌ |
| Real-time adaptive scoring | ✅ | ⚠️ | ⚠️ | ❌ |
| Explainability | ✅ | ✅ | ⚠️ | ⚠️ (basic incidences) |
| AI document extraction | ⚠️ | ⚠️ | ⚠️ | ❌ |
| Authority audit trail | ✅ | ✅ | ✅ | ✅ (hash chain) |

---

## 7. Priority Fixes to Reach Top Tier

### P0 — Production adversarial robustness (do first)
1. **Replace substring matching** with a defensive matcher:
   - Leetspeak normalization (`1→i`, `0→o`, `3→e`, `@→a`, etc.)
   - Zero-width / invisible character stripping
   - NFKC normalization + ASCII folding for homoglyphs
   - Fuzzy similarity threshold (Levenshtein/Jaro-Winkler ≥ 0.85)
2. **Version keyword/brand lists** independently and hash the effective ruleset.
3. **Add minimum threshold floors** so admins cannot set signals to `0` silently.
4. **Fix NaN handling** — reject non-finite values everywhere.
5. **Fix ambiguous number parsing** — reject or flag locale-ambiguous inputs.

### P1 — ANAM/SAT rejection risk
6. **Consolidate to one prevalidator**; remove or delegate the legacy `src/engine/prevalidador.ts`.
7. **Add RFC homoclave and CURP checksum validation**.
8. **Enforce RRNA exclusion in the active prevalidator**.
9. **Validate per-consignee $2,500 aggregate** inside prevalidation.
10. **Add catalog validation**: aduanas, países, unidades, monedas, patentes.
11. **Validate header totals against partidas**.
12. **Parse and validate dates**.

### P2 — Ingestion hardening
13. **Return row-level parse errors** instead of coercing to `0`.
14. **Enforce required-field validation per row** before persistence.
15. **Normalize countries and currencies**.
16. **Expand weight unit conversion** (lb, oz).
17. **Detect and reject duplicate headers**.
18. **Deprecate `src/utils/fileParser.ts`**.

### P3 — Move to Level 3/4/5
19. **Add sanctions/denied-party screening** (OFAC, UN, EU, UK, BIS) with fuzzy matching.
20. **Implement entity resolution** — cluster names/addresses/RFCs/phones/emails.
21. **Add valuation anomaly detection** (unit-price vs historical/mirror prices).
22. **Build per-entity risk profiles**.
23. **Introduce weighted/calibrated scoring** and eventually ML with inspection feedback.
24. **Add random/stratified inspection slot** (sample 2–5% of `verde`).
25. **Emit structured explainability objects** with confidence and evidence spans.

---

## 8. Summary

The SGA Customs validation engine is a **strong Level-2 foundation**: clean architecture, versioned rules, good tests, and correct severity override. But it is **not top-tier** because it relies on naive substring matching, lacks entity resolution and sanctions screening, has weak RFC/CURP validation, and allows silent data corruption in ingestion.

**The good news:** the gaps are well-defined and the codebase is modular enough to close them. The highest-ROI fixes are defensive normalization (leetspeak/homoglyphs/zero-width), RFC/CURP checksum validation, row-level ingestion errors, and consolidating the two prevalidators. After that, sanctions screening and entity resolution will move the engine to Level 3, and ML feedback loops will move it toward Level 5.

---

*Raw findings from the 5-agent swarm are available in the agent transcripts used for this synthesis. This report focuses on the validation engine only.*
