# Compliance Audit — Riesgo T1 · Capital Centennials

**Date:** 2026-06-19
**Method:** 7-agent swarm — PRD coverage (×4), ANAM regulatory rules (×1), document forensics (×1), reference-software research (×1).
**Inputs:** PRD v2.0 + production files (MANIFEST_TEST, LayOut_sistema, Risk_analysis 17-feb-25, Pedimento 240pp, Analisis de Riesgo).
**Per-team detail:** `/tmp/customs_docs/findings/{A1,A2,A3,A4,B1,B2,C1}*.md`

---

## Verdict

The platform is **structurally on-target but not yet compliance-ready**. The 6 modules, the 8-signal risk engine, the 34-column layout, RBAC, and an append-only audit table all exist and largely match the source documents. But there are **three blocking defects** that would each independently fail the AGACE evaluation or break core operation, plus two requirements the PRD calls "Must" that contradict what the code actually does.

### Compliance scorecard

| Area | State |
|---|---|
| Module 1 Realizar registro | 🟡 risk engine works; **manifest parser reads the wrong column vocabulary** |
| Module 2 Seguimiento | 🟡 PDF upload works; **import-data capture form never POSTs (mock)** |
| Module 3 Reporte general | ❌ `ReporteGeneralView` is a `null` stub; no client/platform catalog; report builder is a 7-col subset |
| Module 4 Consulta | ✅ search + 3-artifact retrieval works |
| Module 5 Dashboard | 🟡 data present, rendered as text not charts; no status view |
| Module 6 Acerca de | 🟡 mission/vision only; no marco legal / company RFC |
| Risk engine (V1–V8) | ✅ matches the real workbook; 🟡 thresholds hardcoded, not declarative/versioned |
| Data layout (§8.2) | 🟡 34 cols emitted; **fixed values 9901000100 / PCS / N/A not injected** |
| Tasa global (§10 capture-only) | ❌ **`taxCalculator.ts` fully calculates IGI/IVA/DTA — contradicts the PRD** |
| Audit hash-chain (RF-21 / RNF-10) | ❌ **no hash chain exists** (append-only trigger only) |
| Auth / RBAC | ✅ bcrypt-12, server-side role gating, parameterized SQL |
| MFA (RNF-04) | ❌ not implemented (PRD says obligatorio) |
| Authority access (RF-22, RGCE 3.7.4) | 🟡 read role exists; **write-block is frontend-only on some routes** |
| Consolidated authority report (RF-23) | ❌ not implemented |
| Branding / catalog mgmt (RF-20 / RF-24) | ❌ hardcoded in source |
| PII at-rest encryption (RNF-08) | ❌ RFC/CURP/passport + PDFs stored plaintext |

---

## The three blocking defects

### 1. The manifest parser cannot read the real manifest (CRITICAL — breaks Module 1 end-to-end)
`shared/parsing/headerSynonyms.ts` is keyed to the **output-layout** vocabulary, not the **28 input-manifest** headers. **0 of 28** real columns (`MWB`, `Destinatario (CNNE)`, `Peso`, `Valor total declarado`, …) map → every shipment parses as a blank record. Compounded by **no comma-decimal normalization** (RF-02): the real `Valor` column literally contains `"0,79"`, `"8,95"` → `Number("0,79")` = `NaN` → 0. So the engine that *does* work would receive empty/zero input from a real file.
*Surfaced independently by A1, A3, and B2.*

### 2. No chained-hash audit integrity (CRITICAL — fails the cybersecurity gate)
RF-21 and RNF-10 promise tamper-evident, hash-chained audit. `server/src/services/audit.ts` does a plain INSERT with no `prev_hash`/`hash` columns and no SHA-256. The only protection is an append-only DB trigger — real, but **not** cryptographically tamper-evident: dropping the trigger or recreating the table leaves no detectable break. IP (`quién/cuándo/IP`) is also never captured. This is the single highest-stakes control for the ANAM permit.
*Surfaced independently by A2 and A4.*

### 3. Tasa global is calculated, not captured (CONTRADICTS PRD §10)
`src/engine/taxCalculator.ts` derives the 0/19/33.5% rate from origin and computes `IGI/IVA/DTA + total` ("Liquidación estimada MXN" in the UI). PRD §10 is explicit: the system **must not** calculate contributions — the tasa is captured/read from the pedimento. The compliant `shared/` path treats the rate as passthrough; the **UI is wired to the non-compliant engine**.
*This is also the root of a second architecture problem (below).*

### Cross-cutting: two divergent engines
There are **two parallel pipelines**. The PRD-faithful one (`shared/parsing` + `shared/risk`, reachable via `server/src/routes/risk.ts`) is correct in spirit but mis-mapped (defect 1). The legacy one (`src/engine/*` + `ManifestUploadView.tsx`, RGCE/tax-flavored) is what the **UI actually runs** — and it carries the forbidden tax calculation. v1 should converge on the `shared/` pipeline and retire/quarantine the tax engine.

---

## ANAM regulatory reality check (Team B1)

- **RGCE 3.7.4 is the one rule that genuinely governs this software** — online authority access to the risk system. The product matches it. (Tasa-global content has renumbered to **3.7.35**.)
- **Tasa change confirmed** via 4ta RM RGCE 2025, DOF 28/07/2025 (eff. 15/08/2025), but the PRD's framing is slightly off: 33.5% applies to **non-treaty origin only**; **T-MEC origin kept 19% / 17% / 0%** by value band. Parameterize with vigencias.
- **The "22 requisitos", ISO-27001/pen-test/DRP package, AGACE "pruebas conjuntas" software certification, the SHCP "espejo", and "separate tables per company" are NOT found in any published rule.** They are defensible engineering targets but **cannot be cited as law** — get the real AGACE checklist in writing.
- **LFPDPPP (new, DOF 20/03/2025)** and **5-year retention (LA 59-V/162, CFF 30)** are real obligations partially unmet (no aviso de privacidad / ARCO / breach plan / retention policy).

## Reference-software positioning (Team C1)

- **Line-level risk scoring → traffic-light is a genuine differentiator**, not a baseline — it was the hardest feature to find across 12+ commercial products. The product builds in real whitespace and is the same category as CBP ATS / ASYCUDA / Cotecna selectivity engines.
- **Deferrals are reasonable** (HS classification, pedimento generation/transmission, duty calc, multi-tenant SaaS are incumbent-owned: CASA/CargoWise, SLAM, Darwin/VANTEC, MIC + prevalidadores CAAAREM/CLAA).
- **Blind spots vs state-of-the-art:** (a) no **denied-party/sanctions screening** (OFAC/BIS/EU/UN) — table-stakes in trade compliance; (b) **exact-string matching** for piracy/consignee/address — trivially evaded; SOTA uses fuzzy + entity resolution; (c) hard `0.01` undervaluation trip vs distributional unit-price outliers.

---

## Prioritized remediation

**P0 — blocks v1 operation / evaluation**
1. Re-key `headerSynonyms.ts` to the 28 real manifest headers + add comma-decimal and gram↔KG normalization (RF-01/02). Without this nothing downstream sees real data.
2. Implement the chained-hash audit trail: migration with `hash`/`prev_hash`, compute `sha256(prev_hash || canonical_row)` in a serialized tx, capture `req.ip` (RF-21/RNF-09/10).
3. Wire the Seguimiento capture form to `POST` the real backend (RF-09); converge the UI onto the `shared/` risk pipeline and retire the tax calculation from the operative path (§10).

**P1 — Must requirements still open**
4. Build Module 3: client/platform catalog + full LayOut-conformant XLS merge that **injects** fracción `9901000100`, unidad `PCS`, RRNA `N/A` (RF-11/RF-12).
5. Persist the 3 expediente artifacts as real stored files (not regenerated per request) so hash-chaining/immutability is meaningful (RF-06/RF-13).
6. Enforce `requireRole` write-blocks on every data route for `autoridad`; restore capturista shared-visibility (`records.ts` scopes to `created_by=self`, contradicting the PRD).
7. Add MFA (RNF-04); move catalogs + branding to DB with admin CRUD (RF-20/RF-24); build the consolidated daily/monthly XLS (RF-23).
8. Encrypt PII at rest (RFC/CURP/passport) and remove the committed default `JWT_SECRET` (RNF-03/05/08).

**P2 — credibility / roadmap**
9. Make the rule engine declarative + versioned (store rule-set version per run); reconcile V4 threshold (code `>1` vs PRD `≥3`) and the D2 bucket mapping (code omits "No identificados").
10. Add denied-party screening as a 9th signal; introduce fuzzy/normalized matching on catalogs.

**Open decisions for the client/customs broker:** the AGACE checklist in writing (D-?), D2 bucket mapping, D4 thresholds, D5 tasa-consistency table (with T-MEC bands), D8 retention/RTO-RPO, and the LFPDPPP privacy package.
