# SGA Customs — Full Strategic & ANAM Compliance Report

**Date:** 2026-06-22  
**Repository:** `/Users/fernandocamacholombardo/customs`  
**Branch:** `feat/t1-compliance-sprint`  
**Prepared for:** SGA Customs / Capital Centennials T1 Risk Platform  
**Method:** Multi-agent research swarm covering competitive intelligence, regulatory mapping, code-level audits, red-team adversarial testing, security/privacy review, UX evaluation, and technical integration assessment.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Current Platform State](#2-current-platform-state)
3. [Competitive Landscape](#3-competitive-landscape)
4. [Validation Engine Deep Dive](#4-validation-engine-deep-dive)
5. [ANAM/SAT Compliance Audit](#5-anamsat-compliance-audit)
6. [Security & Privacy Compliance](#6-security--privacy-compliance)
7. [UX / Workflow Evaluation](#7-ux--workflow-evaluation)
8. [Technical Integration Readiness](#8-technical-integration-readiness)
9. [Risk Matrix](#9-risk-matrix)
10. [Prioritized Roadmap](#10-prioritized-roadmap)
11. [Conclusion](#11-conclusion)
12. [Appendix: Source Agent Reports](#12-appendix-source-agent-reports)

---

## 1. Executive Summary

### 1.1 Verdict

**SGA Customs is a well-architected T1 risk-analysis foundation, but it is not yet ANAM-production-compliant or top-tier.**

The platform has made significant progress: real manifest ingestion, an 8-signal risk engine, hash-chained audit logs, MFA, PII encryption, RBAC, authority reporting, and configurable thresholds are all implemented and tested. However, **critical gaps remain** in pedimento generation, government integration, mandatory ANAM reporting, security hardening, privacy program, and ISO 27001 evidence.

### 1.2 Overall Scores

| Dimension | Score | Status |
|---|---|---|
| **ANAM/SAT Compliance** | 55% | Not production-ready |
| **Validation Engine Maturity** | Level 2 / 5 | Rules-based, not ML-driven |
| **Security & Privacy** | 5.3 / 10 | Strong foundation, missing program |
| **Government Integration** | 1.8 / 10 | Not integrated |
| **UX / Workflow** | 6 / 10 | Functional, manual friction remains |
| **Competitive Position** | Unique whitespace | No AI-first T1-specific competitor |

### 1.3 Highest-Priority Actions

1. **Fix the pedimento builder** — remove forbidden IVA contribution calculation and force generic HS codes.
2. **Harden JWT secret resolution** — move fail-closed logic to `token.ts`, allow dev default only in `NODE_ENV=test|development`, remove duplicated literal from `index.ts`.
3. **Delete/quarantine the legacy simulation-only engine** (`src/engine/*`).
4. **Build Ficha 124/LA and 125/LA generators** in the official format.
5. **Begin FIEL + SAAI M3 + SEA integration**.
6. **Implement a formal privacy program** (aviso de privacidad, ARCO, retention, breach plan).
7. **Initiate ISO 27001:2013 implementation**.
8. **Encrypt/tokenize remaining PII fields** (name, address, email, phone).

---

## 2. Current Platform State

### 2.1 Implemented

| Capability | Evidence |
|---|---|
| Real 28-column manifest ingestion | `shared/parsing/headerSynonyms.ts`, `manifestParser.ts` |
| 8-signal risk engine | `shared/risk/signals.ts`, `classify.ts`, `ruleset.ts` |
| Versioned ruleset + configurable thresholds | `shared/risk/ruleset.ts`, `server/src/routes/catalogs.ts` |
| SHA-256 chained audit log + IP | `server/src/services/audit.ts`, `auditVerify.ts` |
| MFA (TOTP) | `server/src/auth/mfa.ts`, `src/components/LoginView.tsx` |
| PII AES-256-GCM encryption | `server/src/crypto/fieldCrypto.ts` |
| Client/platform catalog + validated RFCs | `server/src/routes/catalogs.ts` |
| Import-data capture (Seguimiento) | `server/src/routes/importData.ts` |
| Artifact persistence | `server/src/services/artifacts.ts` |
| Consolidated authority report | `server/src/routes/consolidated.ts` |
| PDF security scan | `server/src/services/pdfScan/` |
| Dashboard + UI redesign | `src/components/DashboardView.tsx`, `Sidebar.tsx` |
| RBAC + shared capturista visibility | `server/src/auth/access.ts`, `server/test/routes/rbac.test.ts` |

### 2.2 Partial / Needs Work

| Area | Issue | Evidence |
|---|---|---|
| Pedimento generation | Uses input HS code, computes IVA contribution | `shared/pedimento/buildPedimento.ts:24,30` |
| `super_admin` role | Cannot create super_admin users | `server/src/routes/users.ts:11` |
| ANAM authority access | No scoped API/SSO or separate access log | `server/src/routes/reports.ts:65` |
| CORS / security | No global rate limiting, CSRF, or schema validation library | `server/src/app.ts` |
| File storage | Local disk only | `server/src/storage/files.ts` |
| Acerca de / branding | Hardcoded fallback | `src/components/AcercaDeView.tsx:16-17` |
| Legacy T1Context | Still bundles forbidden tax engine | `src/context/T1Context.tsx` |

### 2.3 Missing / Broken

| Requirement | Status | Evidence |
|---|---|---|
| Live SAT/ANAM/VUCEM integration | ❌ Missing | `src/engine/t1Compliance.ts` says checks are simulated |
| FIEL / e.firma digital seal | ❌ Missing | No signing client |
| Ficha 124/LA and 125/LA | ❌ Missing | No official report generators |
| Denied-party / sanctions screening | ❌ Missing | No OFAC/BIS/EU/UN checks |
| ISO 27001 / formal ISMS | ❌ Missing | No policies |
| Rate limiting / CSRF / schema validation | ❌ Missing | Only per-user limiter on reports |
| Data retention / backup / BCP | ❌ Missing | No documented policy |
| e-AWB / air-cargo transmission | ❌ Missing | No integration |

---

## 3. Competitive Landscape

### 3.1 Market Map

| Category | Players |
|---|---|
| Mexican legacy incumbents | CASA, VANTEC/Darwin, SLAM (OP-CBS), Aduanet M3 |
| Modern cloud challengers | Aduvanta |
| Association prevalidators | CAAAREM, CLAA |
| Enterprise global trade | CargoWise, MIC-CUST |
| Government risk engines | CBP ATS, ASYCUDA World, Cotecna CRMS |
| Carrier-integrated | DHL Express, FedEx Trade Networks, UPS TradeAbility |

### 3.2 Feature Comparison

| Capability | CASA | VANTEC | SLAM | Aduvanta | CargoWise | MIC | SGA |
|---|---|---|---|---|---|---|---|
| T1-specific risk scoring | ❌ | ⚠️ | ⚠️ | ⚠️ | ❌ | ❌ | ✅ |
| AI/ML risk engine | ❌ | ❌ | ⚠️ | ⚠️ | ⚠️ | ✅ | ❌ |
| SAT/ANAM direct integration | ✅ | ✅ | ✅ | ✅ | ⚠️ | ✅ | ❌ |
| FIEL/e.firma sealing | ✅ | ✅ | ✅ | ✅ | ⚠️ | ✅ | ❌ |
| Transparent SaaS pricing | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | N/A |
| Denied-party screening | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | ❌ |
| Line-level traffic-light risk | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |

### 3.3 White-Space Opportunity

**No competitor owns the AI-first, T1-specific, line-level risk-scoring lane.** SGA's traffic-light per-package risk model is a genuine differentiator in a market dominated by legacy broker suites and enterprise ERPs.

**Recommended positioning:** "The AI-powered T1 pre-clearance risk layer for Mexican couriers."

---

## 4. Validation Engine Deep Dive

### 4.1 Maturity Assessment

| Level | Description | SGA Status |
|---|---|---|
| 1 | Static rules | Partial |
| 2 | Configurable rules + catalogs | ✅ Current |
| 3 | Fuzzy matching + entity resolution | ❌ Missing |
| 4 | Machine-learned scoring with feedback | ❌ Missing |
| 5 | Real-time adaptive AI + explainability | ❌ Missing |

### 4.2 Risk Engine Strengths
- Clean 8-signal design
- Versioned ruleset stamped per run
- Configurable thresholds and lists
- Severity override for critical signals
- Good test coverage

### 4.3 Risk Engine Weaknesses

| Weakness | Example Bypass |
|---|---|
| Substring-only matching | `"N1ke"`, `"Guc ci"` bypass piracy detection |
| No leetspeak defense | `"p0lvo"`, `"past1llas"` bypass prohibited detection |
| No homoglyph defense | Cyrillic `"Nіke"` bypasses |
| No entity resolution | `"Juan Perez"` vs `"Juan Peres"` treated as different |
| No sanctions screening | No OFAC/UN/EU/BIS checks |
| No valuation anomaly | Hard $1–$2,500 band only |
| Unweighted scoring | Quantity=11 counts same as prohibited weapon |

### 4.4 Prevalidation Engine Findings

**Two contradictory prevalidators exist:**

| Aspect | Active Backend (`shared/pedimento/prevalidate.ts`) | Legacy Frontend (`src/engine/prevalidador.ts`) |
|---|---|---|
| Generic HS format | `99010001` | `9901.00.01` |
| Observation format | `GUIA … VALOR … USD NOMBRE … RFC-CURP …` | `EM1\|name\|RFC:xxx` |
| Quantity validation | ❌ | ✅ |
| MJ complement | ❌ | ✅ |
| RRNA enforcement | ❌ | ⚠️ Upstream only |

**Critical prevalidation gaps:**
- No RFC homoclave / CURP checksum enforcement as errors
- No catalog validation (aduanas, países, unidades, patentes)
- No header-partidas totals reconciliation
- No SAAI M3 fixed-width generation
- RRNA not enforced in active prevalidator

### 4.5 Ingestion Validation Findings

**Strengths:**
- Maps real 28-column manifest
- Handles accents/case/punctuation
- Normalizes comma/dot decimals and gram→kg
- Reports unmapped headers

**Critical weaknesses:**
- Bad numeric data silently becomes `0`
- No required-field enforcement per row
- Country/currency not normalized (`"Porcelana"`, `"Dólar estadounidense"`)
- No date parsing/validation
- Duplicate headers silently overwrite
- Two divergent parsers exist

### 4.6 Red-Team Bypass Examples

| # | Attack | Input | Result |
|---|---|---|---|
| 1 | Leetspeak piracy | `"N1ke air max"` | Bypasses |
| 2 | Token splitting | `"Guc ci bolso"` | Bypasses |
| 3 | Homoglyph | `"Nіke"` (Cyrillic) | Bypasses |
| 4 | Leetspeak prohibited | `"p0lvo"` | Bypasses |
| 5 | Fake RFC | `"XXXX010101AAA"` | Accepted |
| 6 | NaN value | `declaredValueUsd: NaN` | Invisible to value rules |
| 7 | Locale trick | `"1,000"` | Parsed as `$1.00` |
| 8 | Split shipment | 2 × $2,499 same RFC | Bypasses $2,500 limit |
| 9 | Generic desc evasion | `"regalito"` | Bypasses |
| 10 | Name typo | `"Juan Peres"` | Bypasses duplicate detection |

---

## 5. ANAM/SAT Compliance Audit

### 5.1 Compliance Scorecard by Requirement

| Requirement Area | Status | Score |
|---|---|---|
| Ley Aduanera Art. 88 Bis/Ter authorization | 🟡 Partial | N/A business |
| RGCE 3.7.3 registration/prerequisites | 🟢 Mostly compliant | 8/10 |
| RGCE 3.7.4 online authority access | 🟡 Partial | 6/10 |
| RGCE 3.7.5 T1 dispatch mechanics | 🟡 Partial | 7/10 |
| RGCE 3.7.35 tasa global | 🟢 Compliant | 9/10 |
| Ficha 124/LA recurrent notices | 🔴 Missing generator | 2/10 |
| Ficha 125/LA monthly reports | 🔴 Missing | 0/10 |
| Expediente electrónico / 5-year retention | 🟡 Partial | 4/10 |
| Sistema de análisis de riesgo | 🟢 Mostly compliant | 8/10 |
| LFPDPPP privacy | 🔴 Non-compliant | 2/10 |
| ISO 27001 / prevalidation security | 🔴 Missing | 2/10 |
| VOCE-SAAI M3 / e.firma | 🔴 Missing | 1/10 |
| Air cargo / e-AWB | 🔴 Missing | 1/10 |

### 5.2 Detailed Compliance Matrix

| Requirement | Status | Evidence |
|---|---|---|
| 3.7.3-A ANAM registry | 🟡 Simulated | `src/engine/t1Compliance.ts:25-32` |
| 3.7.3-B Generic descriptions | ✅ Implemented | `shared/risk/signals.ts`, `src/engine/t1Compliance.ts` |
| 3.7.3-C Zero/negative value | ✅ Implemented | `shared/risk/signals.ts`, `validateManifest.ts` |
| 3.7.3-D Consignee RFC | ✅ Implemented | `shared/pedimento/observation.ts`, `prevalidate.ts` |
| 3.7.4 Online access | 🟡 Partial | `autoridad` role + portal; no ANAM SSO |
| 3.7.5-A $2,500 cap | ✅ Implemented | `shared/pedimento/prevalidate.ts`, `src/engine/t1Compliance.ts` |
| 3.7.5-B Generic HS codes | 🟡 Partial | Layout forces; builder does not |
| 3.7.5-C Fractional shipments | 🟡 Partial | Within manifest only |
| 3.7.5-D Air/land only | ✅ Implemented | `src/engine/t1Compliance.ts` |
| 3.7.5-E RRNA | 🟡 Partial | Backend keywords only; richer taxonomy frontend-only |
| 3.7.35 Tasa global | ✅ Implemented | Captured from user; vigencias config |
| Ficha 124/LA detection | ✅ Implemented | `monthlyHistory.ts`, `bbdd` signal |
| Ficha 124/LA generation | ❌ Missing | No `.txt`/`.zip` generator |
| Ficha 125/LA generation | ❌ Missing | Consolidated XLS only |
| 5-year retention | ❌ Missing | No policy |
| Privacy notice | ❌ Missing | No aviso de privacidad |
| ARCO workflow | ❌ Missing | No workflow |
| e.firma / FIEL | ❌ Missing | No signing service |
| SAAI M3 transmission | ❌ Missing | No fixed-width encoder/transmitter |

### 5.3 Critical Compliance Violations

1. **Pedimento builder computes IVA contribution** — violates T1/IMD no-contribution rule.
2. **Pedimento builder does not force generic HS codes** — real HS codes can reach output.
3. **No Ficha 124/LA or 125/LA** — direct statutory obligation.
4. **No live government integration** — cannot submit or validate pedimentos.
5. **No FIEL/e.firma digital seal** — documents not legally submittable.
6. **Legacy simulation engine** — contradictory prevalidators, toy seal, forbidden tax calc.
7. **No ISO 27001 / formal ISMS** — required for prevalidators.
8. **No privacy program** — LFPDPPP non-compliant.

---

## 6. Security & Privacy Compliance

### 6.1 Scorecard

| Domain | Score |
|---|---|
| Authentication | 6.5/10 |
| Authorization | 8/10 |
| Data Protection | 6/10 |
| Audit & Logging | 8.5/10 |
| Input Validation | 5.5/10 |
| Privacy (LFPDPPP) | 2/10 |
| ISO 27001 | 2/10 |
| Dependencies | 4/10 |

**Overall: 5.3/10**

### 6.2 Critical Security Gaps

1. **Unencrypted name/address/email/phone** in `shipments.data` JSONB
2. **No global rate limiting / brute-force protection**
3. **High/critical CVEs** in `xlsx`, `tar`, `glob`
4. **JWT secret resolution hardening** — production already guarded by `index.ts`, residual risk is lack of fail-closed default in token module itself; moving resolution to `token.ts` with lazy evaluation eliminates duplicated literal and centralizes logic
5. **No JWT revocation / refresh tokens**
6. **MFA is opt-in**, not mandatory for privileged roles
7. **No input schema validation library**
8. **No formal privacy program**
9. **No ISO 27001 / ISMS evidence**
10. **No BCP/DRP / retention policy**

### 6.3 LFPDPPP Status

| Principle | Status |
|---|---|
| Licit, informed, consent-based treatment | ❌ Non-compliant |
| Purpose limitation | ⚠️ Partial |
| Data minimization | ⚠️ Partial |
| Accuracy | ⚠️ Partial |
| Retention limitation | ❌ Non-compliant |
| Security | ⚠️ Partial |
| Accountability | ⚠️ Partial |
| ARCO rights | ❌ Non-compliant |
| Breach notification | ❌ Non-compliant |

---

## 7. UX / Workflow Evaluation

### 7.1 Module Scorecard

| Module | Score |
|---|---|
| Realizar Registro | 🟡 |
| Seguimiento | 🟡 |
| Reporte General | 🟡 |
| Consulta | 🟡 |
| Dashboard | 🟡 |
| Acerca de | ✅ |

### 7.2 Top Friction Points

1. **No inline field validation** — emails, RFCs, dates largely free-text
2. **No master-data lookup** — aduanas, agentes, patentes, clients typed by hand
3. **Fake/missing progress feedback** — timed animation in Registro, no upload progress in Seguimiento
4. **State loss on errors** — Registro resets file
5. **Authority PII gap** — Consulta exposes unredacted downloads to `autoridad`
6. **No preview anywhere** — manifests, reports, artifacts cannot be previewed

### 7.3 Quick UX Wins

1. Preserve file/state on error + show real progress
2. Surface server warnings (`tasaWarning`, lock reason)
3. Add client/master-data search + autofill
4. Add field-level validation
5. Redact PII for `autoridad` in Consulta
6. Add date filter + trend sparklines in Dashboard

---

## 8. Technical Integration Readiness

### 8.1 Integration Scorecard

| Area | Score |
|---|---|
| SAT/ANAM SEA connectivity | 0/10 |
| SAAI M3 record generation | 3/10 |
| VOCE/VUCEM/COVE | 1/10 |
| MVE | 1/10 |
| e.firma / FIEL / SELLO | 0/10 |
| Air cargo / e-AWB | 2/10 |
| Carrier/platform EDI/API | 1/10 |
| SAT catalog integration | 3/10 |
| **Overall** | **1.8/10** |

### 8.2 Implemented vs Simulated vs Missing

| Category | Examples |
|---|---|
| ✅ Implemented (internal) | T1 pedimento model, risk engine, manifest ingestion, 34-col export, audit chain, PII encryption |
| 🟡 Simulated/Partial | SAAI M3 structures (legacy only), ANAM registry check, digital seal, SAT online toggle, generic RFC, EM identifier, catalogs (static seeds) |
| ❌ Missing (live) | SEA/SAAI M3 transmission, FIEL signing, VUCEM/COVE, MVE, e-AWB, SAT catalog live sync, padrón lookups, carrier APIs |

### 8.3 Production Blockers

1. No FIEL/e.firma signing
2. No SAAI M3 fixed-width generator/transmitter
3. No live SAT catalog sync
4. No VUCEM/COVE integration
5. No e-AWB / air cargo feed
6. Hardcoded EM/tax/transport values
7. Two divergent prevalidators

---

## 9. Risk Matrix

| # | Risk | Likelihood | Impact | Priority |
|---|---|---|---|---|
| 1 | Pedimento builder violates T1 contribution rule | High | Critical | P0 |
| 2 | No government integration | Certain | Critical | P0 |
| 3 | No FIEL digital seal | Certain | Critical | P0 |
| 4 | Missing Ficha 124/125 → permit cancellation | High | Critical | P0 |
| 5 | JWT secret resolution hardening | Low | Medium | P1 |
| 6 | Legacy simulation engine reactivated | Medium | High | P0 |
| 7 | LFPDPPP non-compliance | High | High | P0 |
| 8 | No ISO 27001 | High | High | P1 |
| 9 | Validation engine evadable | High | High | P1 |
| 10 | Unencrypted PII fields | Medium | High | P1 |
| 11 | No global rate limiting | High | High | P1 |
| 12 | Dependency CVEs | Medium | High | P1 |
| 13 | No cancellation-trigger monitoring | High | High | P1 |
| 14 | No dedicated ANAM access channel | Medium | Medium | P2 |
| 15 | UX friction / manual re-entry | High | Medium | P2 |

---

## 10. Prioritized Roadmap

### Phase 1 — Production Blockers (0–4 weeks)
1. Harden JWT secret resolution; fail startup if `JWT_SECRET` missing or default in production.
2. Stop computing IVA contributions in T1 pedimento builder.
3. Force generic HS codes in pedimento builder.
4. Delete/quarantine legacy `src/engine/*` simulation code.
5. Unify RRNA detection in backend risk engine.
6. Add monthly address-level history.
7. Make RFC/CURP checksum validation an error.
8. Fix NaN and ambiguous number parsing.

### Phase 2 — ANAM Reporting & Operations (1–2 months)
9. Build Ficha 124/LA generator.
10. Build Ficha 125/LA generator.
11. Add reporting scheduler with deadline tracking.
12. Implement cancellation-trigger monitoring.
13. Add automated quarantine for prohibited/RRNA goods.
14. Create dedicated ANAM read-only API with scoped credentials.

### Phase 3 — Security & Privacy (1–2 months)
15. Encrypt/tokenize name, address, email, phone.
16. Add global rate limiting and brute-force protection.
17. Patch/replace vulnerable dependencies.
18. Make MFA mandatory for privileged roles.
19. Implement JWT refresh + revocation.
20. Publish aviso de privacidad and ARCO workflow.
21. Document retention, backup, and BCP policy.

### Phase 4 — Government Integration (2–4 months)
22. Implement FIEL/e.firma pipeline.
23. Build SAAI M3 fixed-width generator.
24. Integrate SEA/SAAI M3 transmission client.
25. Add VUCEM/COVE integration.
26. Implement live SAT catalog sync.
27. Add e-AWB / air cargo info integration.

### Phase 5 — Top-Tier Differentiation (3–6 months)
28. Initiate ISO 27001:2013 implementation.
29. Conduct independent penetration testing.
30. Add sanctions/denied-party screening.
31. Implement fuzzy entity resolution.
32. Build ML-based risk scoring with feedback loops.
33. Add AI document extraction from pedimento PDFs.
34. Implement customer self-service portal.
35. Add AEO / trusted-courier readiness module.

---

## 11. Conclusion

SGA Customs has built a **credible foundation** for a T1 risk-analysis platform. The architecture is clean, the audit trail is strong, and the line-level traffic-light risk scoring is a genuine market differentiator. However, the platform is **not yet ANAM-production-compliant** and **not yet top-tier**.

The path forward is clear:

1. **Close the production blockers** in pedimento generation, JWT secret, and legacy engine removal.
2. **Build the mandatory ANAM reports** (Ficha 124/LA and 125/LA).
3. **Integrate with SAT/ANAM systems** (FIEL, SAAI M3, SEA, VUCEM).
4. **Harden security and privacy** (encryption, rate limiting, privacy program, ISO 27001).
5. **Advance the validation engine** from Level 2 to Level 5 (fuzzy matching, sanctions screening, ML scoring).

If executed in this order, SGA can become the **AI-first T1 risk platform** for Mexican couriers — a whitespace no incumbent currently owns.

---

## 12. Appendix: Source Agent Reports

This report synthesizes findings from the following parallel agent investigations:

1. **Platform evaluation swarm** — `docs/ANAM_T1_platform_evaluation_swarm_report.md`
2. **Validation engine audit** — `docs/validation_engine_top_tier_audit.md`
3. **Full ANAM compliance audit** — `docs/full_anam_compliance_audit_2026-06-22.md`
4. Agent transcripts: codebase technical audit, competitor intelligence, ANAM regulatory mapping, top-tier capability benchmark, UX workflow evaluation, risk engine deep audit, prevalidation engine audit, parser validation audit, adversarial red-team tests, security/privacy audit, reporting/operational audit, technical integration audit.

*This report does not constitute legal advice. Final ANAM/SAT compliance strategy should be validated with Mexican customs counsel before submission.*
