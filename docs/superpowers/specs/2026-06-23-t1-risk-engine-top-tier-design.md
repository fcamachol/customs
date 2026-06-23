# T1 Risk Engine — Top-Tier Re-Architecture (Design Spec)

**Date:** 2026-06-23
**Status:** Draft for review
**Owner:** engine / `shared/risk/*`

## 1. Context

The platform scores Mexican **T1** (simplified courier/e-commerce) manifests for customs risk. The current engine (`shared/risk/{ruleset,signals,classify}.ts`) is a faithful port of a client-supplied Excel workbook (`Risk analysis 17 feb '25.xlsx`): **8 equally-weighted boolean signals**, summed, banded `<2 Verde / 2–3 Amarillo / ≥4 Rojo`.

Running the client's reference manifest (`MANIFEST TEST 2.xlsx` — byte-identical to the committed golden fixture `shared/parsing/__fixtures__/MANIFEST_TEST.xlsx`, 501 rows) through the engine, and inspecting the reference Excel's own `Resumen` over 17,130 rows, reveals the same failure:

| Distribution | Reference Excel (17,130 rows) | Engine on fixture (501 rows) |
|---|---|---|
| Amarillo | **92.2%** | 78% |
| Rojo | 5.4% | 11% |
| Verde | 2.4% | 11% |

**Root cause (structural, originates in the reference):** the *Consignatarios* and *Direcciones* signals each fire at **≥2 occurrences** (`COUNTIF ≠ 1`). In a consolidated courier manifest the same buyers/addresses repeat by nature, so ~90% of rows score ≥2 points → Amarillo floor. A triage that flags 92% as "review" has not separated signal from noise. The engine conflates "this is an e-commerce courier manifest" with "this is risky."

Research (WCO, CBP ATS, EU ICS2, OECD, JRC fair-price, OFAC screening, and the Mexican RGCE/ANAM T1 rules) converges on the fix: **score deviation from each consignee's own baseline, not raw repetition**, with a **weighted, calibrated, explainable** model. Notably, the entire Mexican aduana-software market ships only deterministic prevalidation — no predictive risk scoring exists commercially — so a calibrated, explainable, deviation-based engine is genuine whitespace.

### Intended outcome
A two-layer engine: a **baseline-parity layer** that reproduces the client's Excel exactly (trust anchor / MVP), and an **enhanced top-tier engine** layered on top that produces a genuinely useful triage (~5–10% rojo, meaningful verde, defensible reason codes), with ML-ready scaffolding as the final phase.

## 2. Goals / Non-goals

**Goals**
- Reproduce the reference Excel's classifications faithfully (baseline parity), proven by a golden test against its `92.2 / 5.4 / 2.4` distribution.
- Replace flat boolean counting with a **weighted graded 0–100 scorecard** and **4 bands** (`verde`/`amarillo`/`rojo`/`gris`-insufficient-data), calibrated capacity-based to ~5–10% rojo (configurable).
- Add a **deviation-based per-entity layer** (entity resolution + rolling aggregates) so legitimate repeat buyers stop dominating Amarillo.
- Map signals to **T1 regulation**: $2,500/consignee ceiling, $1,000 Padrón threshold, Ficha-124 (>3 ops/consignee or /address per calendar month), undervaluation, identity integrity, structuring/*fraccionamiento*, RRNA goods barred from T1.
- **Explainability + audit**: structured reason codes per row; versioned + `sha256`-hashed resolved ruleset; reproducible/replayable scores.
- **Anti-evasion** text matching (NFKC + confusable/homoglyph fold + leetspeak + separator collapse) and **config floors** (an admin cannot set a threshold/weight to silently disable a signal).
- Keep the scoring core **pure & deterministic** in `shared/risk/*`; upgrade the "manifest test" to assert **distributions + reason codes + monotonicity**.

**Non-goals (this milestone)**
- No live external integrations (SAT/VUCEM/ANAM submission, FIEL signing, Ficha-124/125 file generation) — separate roadmap.
- No external fair-price/valuation database or live OFAC/UN/EU list ingestion yet (undervaluation uses *within-manifest* peer statistics now; sanctions screening is roadmap).
- No trained ML model — only the scaffolding to enable one later (Phase 4).

## 3. Baseline parity layer (MVP — reproduce the reference)

A pure function `scoreLegacyParity(shipments, monthlyDb, …)` that reproduces the Excel exactly, used for the trust anchor and the parity golden test. Exact rules decoded from the workbook formulas:

| Signal | Reference formula | Note vs current code |
|---|---|---|
| Validación ID | `LEN(ID) ∈ {13,18} → 0 else 1` | code diverged → checksum; **parity uses length-only** |
| Validación Cantidad | `productos > 10` | match |
| Validación Monto | `monto < 1 OR > 2500` | match |
| Validación Consignatarios | `COUNTIF(consignee) ≠ 1` (**≥2**) | code diverged → ≥3; **parity uses ≥2** |
| Validación Direcciones | `COUNTIF(address) ≠ 1` (**≥2**) | match |
| Artículos Prohibidos | `SEARCH` of 14 keywords → any hit | match (extend keyword list to the 14) |
| Piratería | `SEARCH` of 9 brands → any hit | match |
| Valida BBDD | `VLOOKUP(consignee → 'Base de datos mensual'.Valida)` found→1 | code diverged → aggregated ≥4; **parity uses presence-in-monthly-DB** |
| Resultado | `SUMA<2 Verde / 2–3 Amarillo / ≥4 Rojo` | match |

The 14 prohibited keywords and 9 brands are lifted verbatim from the workbook into the ruleset data. The monthly-DB lookup maps to the existing `monthly_history` mechanism (presence = prior operation this month).

**Parity acceptance:** scoring the reference `Manifiesto` rows in parity mode reproduces the `Resumen` distribution within tolerance (Amarillo 92.2% ±1pp, Rojo 5.4% ±1pp, Verde 2.4% ±1pp) and matches per-row `Resultado` for a sampled set.

## 4. Enhanced engine (top-tier, layered on top)

### 4.1 Weighted graded scorecard → 0–100 → 4 bands
- Each signal returns **graded points** (magnitude), not a boolean. E.g. `monto` ramps with distance from the fair band; per-entity counts ramp with excess over the Ficha-124 threshold.
- `rawPoints = Σ(signal points)`; `score = round(100 × rawPoints / MAX_POINTS)`.
- Bands by **calibrated cutoffs** on the score distribution: `gris` (insufficient data — see 4.4), else `verde / amarillo / rojo` with rojo ≈ top 5–10% (admin-configurable). Severity floors generalized: a signal may declare `forcesBand: 'rojo'` (e.g. RRNA-barred goods, value > $2,500).
- Expert-set weights now; structure is identical for a later logistic/calibrated model (swap the weights table — Phase 4).

### 4.2 Deviation-based per-entity layer (the core fix)
- **Entity resolution:** resolve consignees to entities — RFC/CURP deterministic key first; fuzzy fallback (normalize → block on metaphone+postal → pairwise Jaro-Winkler ≥ ~0.92 → union-find). Libraries: `fuzzball`, `talisman`.
- **Per-entity rolling aggregates** (single-pass `Map`): parcel count, cumulative declared value, time window — within manifest and across `monthly_history`.
- **Score deviation, not repetition:** a repeat consignee is expected; flags fire on *deviation from that entity's baseline* and on **regulatory structuring thresholds**: Ficha-124 (>3 ops/consignee or /address per calendar month), cumulative value approaching **$1,000** (Padrón) and **$2,500** (T1 ceiling), and many sub-threshold parcels to one entity (*fraccionamiento*).

### 4.3 Signal set (mapped to T1 regulation)
Identity integrity (shape + checksum via existing `taxId`; generic/courier RFC where consignee should be identifiable = suspicious, not auto-fail) · Quantity · **Undervaluation** (declared unit value vs within-manifest peer median for the HS×origin group; below-band → graded points) · Consignatario/Direcciones **as entity-deviation** (replaces raw COUNTIF) · Ficha-124 recurrence · **Value-ceiling** ($1,000 / $2,500 → high points / `forcesBand`) · Prohibited keywords & RRNA-barred categories · Piratería brands — all via anti-evasion matching (4.5).

### 4.4 `gris` insufficient-data band
A row with too little usable signal (missing value, missing ID, blank description) must route to `gris` (review), never default to `verde`. Define a data-sufficiency check; below it → `gris` regardless of points.

### 4.5 Anti-evasion matching
Route prohibited/brand matching through: NFKC → strip zero-width/control → confusable/homoglyph fold (UTS #39, `confusables.js`) → diacritic fold → leetspeak map → separator collapse. Defeats `G u c c i`, `Ｇucci`, `G0cc1`. Matched span + method recorded in the reason code's `evidence`.

### 4.6 Explainability, versioning, config hardening
- Replace `incidences: string[]` with structured `ReasonCode[]` `{ signalId, code, points, weight, detail, evidence }`; keep a derived `incidences` for UI back-compat.
- Canonicalize (sorted keys) the **fully-resolved ruleset** (weights + thresholds + lists) and `sha256` it; stamp `ruleset_version` + `ruleset_hash` on every row → reproducible/replayable scores.
- `resolveThresholds`-style floors extended to **weights and bands**: clamp to valid ranges, reject inverted bands, never let an override remove a `forcesBand` floor.

## 5. Architecture (extends `shared/risk/*`, no rewrite)

```
shared/risk/
  ruleset.ts        // EXTEND: weights, bands (cutoffs), keep thresholds + resolve() + floors; verbatim keyword/brand lists
  signals.ts        // EXTEND: each signal returns graded points + evidence
  scorecard.ts      // NEW: Σ points → 0..100 → band; gris check; forcesBand floors; ReasonCode[]
  entity.ts         // NEW: normalize → block → cluster → per-entity rolling aggregates
  text/normalize.ts // NEW: anti-evasion pipeline (§4.5)
  hash.ts           // NEW: canonicalize + sha256 a resolved ruleset
  legacyParity.ts   // NEW: exact reference-Excel reproduction (§3)
  classify.ts       // KEEP as orchestrator: ctx → signals → scorecard → ScoredShipment (+ optional parity result)
```

- Server (`server/src/routes/risk.ts`) feeds config + monthly history; persists `score`, `band`, `reasons`, `ruleset_version`, `ruleset_hash`, and (initially) the parity `Resultado` for side-by-side display.
- React report (`ReportTabs`) shows enhanced band + reason codes, with the legacy parity verdict alongside ("Your Excel: X · Our engine: Y").
- `ScoredShipment` gains `score`, `band`, `reasons: ReasonCode[]`, `entityId`, `ruleset_hash`; legacy `color`/`incidences` retained as derived for back-compat.

## 6. Testing — the upgraded "manifest test"

Run against `shared/parsing/__fixtures__/MANIFEST_TEST.xlsx` (501) and, where feasible, a committed slice of the reference workbook:
1. **Parity golden:** legacy mode reproduces the reference `Resumen` distribution (92.2/5.4/2.4 ±1pp) and sampled per-row `Resultado`.
2. **Distribution golden (enhanced):** rojo within a sane band (~5–10%), gris/verde meaningful — catches over-firing regressions.
3. **Per-row reason-code golden:** snapshot `reasons[]` for a curated row set (the auditor's "why" is under test).
4. **Monotonicity properties:** worsening an input never lowers the score; `forcesBand` always yields rojo; adding a clean row never changes another row's score.
5. **Ruleset-hash test:** stable across key orderings; changes when any weight/threshold/list changes.
6. **Anti-evasion unit tests:** `G u c c i`, fullwidth, leetspeak all match.

## 7. Phasing

- **Phase 1 — Baseline parity + golden.** `legacyParity.ts` + verbatim lists + parity test proving we reproduce the Excel. *(Trust anchor; small.)*
- **Phase 2 — Weighted scorecard + reason codes + 4 bands + config floors.** Graded signals, `scorecard.ts`, `hash.ts`, `gris`, distribution + reason-code + monotonicity goldens. *(Fixes over-firing core; no external deps.)*
- **Phase 3 — Deviation/entity layer + anti-evasion + T1 regulatory signals + calibration.** `entity.ts`, `text/normalize.ts`, undervaluation, ceilings, Ficha-124-as-deviation; calibrate cutoffs to ~5–10% rojo on the fixture.
- **Phase 4 (last) — ML-ready scaffolding.** Inspection-outcome capture, score-distribution/calibration tooling, and the weights-table seam so expert points can be swapped for calibrated/logistic coefficients — no engine code change.

## 8. Verification (definition of done)
- Parity golden green: engine reproduces the reference Excel distribution and sampled rows.
- Enhanced distribution on the 501-row fixture: rojo ≈ 5–10%, no longer ~78–92% amarillo; verde/gris meaningful.
- Every scored row carries structured reason codes + `ruleset_hash`; re-scoring is byte-stable.
- All goldens (parity, distribution, reason-code, monotonicity, hash, anti-evasion) pass; existing server/shared/frontend suites stay green.
- Report surfaces enhanced verdict + reasons with the legacy verdict side-by-side.
