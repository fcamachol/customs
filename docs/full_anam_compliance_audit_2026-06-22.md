# Full ANAM/SAT Compliance Audit — SGA Customs

**Date:** 2026-06-22  
**Repository:** `/Users/fernandocamacholombardo/customs`  
**Branch:** `feat/t1-compliance-sprint`  
**Scope:** Complete codebase evaluated against ANAM/SAT requirements for an Empresa de Mensajería y Paquetería operating under the T1 simplified procedure  
**Method:** 5-agent parallel compliance swarm

---

## Executive Verdict

**SGA Customs is structurally aligned with many ANAM T1 requirements but is not yet ANAM-production-compliant.**

The platform has made substantial progress: real manifest ingestion, an 8-signal risk engine, hash-chained audit logs, MFA, PII encryption, RBAC, authority reporting, and configurable thresholds are all implemented. However, **multiple show-stoppers remain** that would block ANAM authorization or risk permit cancellation:

1. **The production pedimento builder calculates a forbidden IVA contribution** and does not force generic HS codes.
2. **No live SAT/ANAM/VUCEM/SEA/SAAI integration** exists.
3. **No cryptographic FIEL/e.firma digital seal / CADENA ORIGINAL**.
4. **Mandatory Ficha 124/LA and 125/LA reports are not generated**.
5. **Hardcoded JWT fallback secret** remains in the auth module.
6. **No formal privacy program** (aviso de privacidad, ARCO, retention, breach plan).
7. **No ISO 27001 / ISMS evidence**.
8. **Legacy simulation-only engine** still present and contradictory.

**Overall compliance score: ~55%** — strong foundation, not yet production-ready.

---

## 1. Compliance Scorecard by Area

| Area | Status | Score |
|---|---|---|
| **Data Model / LayOut_sistema** | 🟢 Mostly compliant | 7/10 |
| **Risk Engine / Sistema de Análisis de Riesgo** | 🟡 Functional, not top-tier | 6/10 |
| **Pedimento Generation / Prevalidation** | 🔴 Critical violations | 4/10 |
| **Auth / RBAC / Online Authority Access** | 🟡 Mostly compliant | 7/10 |
| **Audit Trail / Record Integrity** | 🟢 Strong | 8/10 |
| **Ingestion / Data Quality** | 🟡 Functional with gaps | 6/10 |
| **Reports / Ficha 124/125** | 🔴 Not compliant | 2/10 |
| **Security / Hardening** | 🟡 Partial | 5/10 |
| **Privacy / LFPDPPP** | 🔴 Non-compliant | 2/10 |
| **ISO 27001 / ISMS** | 🔴 Missing | 2/10 |
| **SAT/ANAM Integrations** | 🔴 Missing | 1/10 |
| **e.firma / CADENA ORIGINAL** | 🔴 Missing | 0/10 |
| **Operational Controls / Cancellation Triggers** | 🔴 Missing | 2/10 |

---

## 2. Detailed Compliance Matrix

### 2.1 Ley Aduanera Art. 88 Bis / 88 Ter — Authorization & Cancellation

| Requirement | Status | Evidence / Gap |
|---|---|---|
| Authorization to operate as EMyP | N/A — business process | Software supports authorized operator; does not grant authorization |
| Maintain RFC/e.firma/tax obligations current | 🟡 Partial | Company RFC stored in config; no live SAT status check |
| Cancellation grounds monitoring | ❌ Missing | Rules exist as stubs that always pass (`src/engine/t1Compliance.ts:312-320`) |

### 2.2 RGCE 3.7.3 — Registration & Operational Prerequisites

| Requirement | Status | Evidence |
|---|---|---|
| 3.7.3-A ANAM registry of courier | 🟡 Simulated | `src/engine/t1Compliance.ts:25-32` hardcoded "registered (simulated)" |
| 3.7.3-B Prohibit generic descriptions | ✅ Implemented | `shared/risk/signals.ts`, `src/engine/t1Compliance.ts:34-70` |
| 3.7.3-C Prohibit zero/negative value | ✅ Implemented | `shared/risk/signals.ts`, `shared/parsing/validateManifest.ts`, `src/engine/t1Compliance.ts:72-95` |
| 3.7.3-D Consignee RFC in observation | ✅ Implemented | `shared/pedimento/observation.ts`, `shared/pedimento/prevalidate.ts` |

### 2.3 RGCE 3.7.4 — Online Authority Access

| Requirement | Status | Evidence |
|---|---|---|
| Provide online access to ANAM | 🟡 Partial | `autoridad` role + portal UI exist (`src/components/AutoridadView.tsx`) |
| Read-only authority queries | ✅ Implemented | `server/src/routes/audit.ts`, `server/src/routes/records.ts` |
| Authority access logged | 🟡 Partial | Logged in general audit log; no separate ANAM access log |
| Dedicated ANAM credentials/SSO | ❌ Missing | Generic `autoridad` role only |

### 2.4 RGCE 3.7.5 — T1 Dispatch Mechanics

| Requirement | Status | Evidence |
|---|---|---|
| 3.7.5-A $2,500 USD value cap | ✅ Implemented | `shared/risk/ruleset.ts`, `shared/pedimento/prevalidate.ts`, `src/engine/t1Compliance.ts:123-146` |
| 3.7.5-B Generic HS codes 9901/9902 | 🟡 Partial | Layout export forces `9901000100`; pedimento builder does not (`shared/pedimento/buildPedimento.ts:24`) |
| 3.7.5-C Prohibit fractional shipments | 🟡 Partial | Detected within single manifest only; not across monthly history (`src/engine/t1Compliance.ts:175-211`) |
| 3.7.5-D Air/land transport only | ✅ Implemented | `src/engine/t1Compliance.ts:213-235` |
| 3.7.5-E Prohibit RRNA goods | 🟡 Partial | Risk engine flags keywords; richer RRNA taxonomy exists in legacy frontend only |

### 2.5 RGCE 3.7.35 — Tasa Global

| Requirement | Status | Evidence |
|---|---|---|
| Capture (not calculate) global rate | ✅ Implemented | `server/src/routes/importData.ts` captures tasa from user; warns on vigencia mismatch |
| 33.5% / 19% / 0% bands | ✅ Implemented | `src/components/ConfigurationView.tsx` TasaTab + `server/src/routes/importData.ts` |
| T-MEC $50/$117 bands | ✅ Configured | Stored in `tasa_vigencias` config |

### 2.6 Ficha 124/LA — Recurrent-Operation Notices

| Requirement | Status | Evidence |
|---|---|---|
| Detect >3 ops/consignee/month | ✅ Implemented | `shared/risk/ruleset.ts:25`, `shared/risk/signals.ts:50`, `server/src/services/monthlyHistory.ts` |
| Detect >3 ops/address/month | 🟡 Partial | Address counted within manifest only; no monthly address history |
| Generate official notice format | ❌ Missing | No `.txt`/`.zip` generator, no `veeemmnnn.ddd` naming |

### 2.7 Ficha 125/LA — Monthly Detailed Reports

| Requirement | Status | Evidence |
|---|---|---|
| Include all monthly operations | 🟡 Partial | Consolidated XLS exists but is not Ficha 125 format |
| Pipe-delimited ASCII `.txt` in `.zip` | ❌ Missing | All exports are `.xlsx` |
| Correct naming `reeemmnnn.ddd` | ❌ Missing | Files named `Consolidado_*.xlsx` |

### 2.8 Expediente Electrónico / 5-Year Retention

| Requirement | Status | Evidence |
|---|---|---|
| 5-year retention policy | ❌ Missing | Data persists but no retention/BCP policy |
| Immutable audit trail | ✅ Implemented | Append-only trigger + SHA-256 hash chain |
| Stored artifacts | 🟡 Partial | Risk/report XLSX + pedimento PDF stored; missing CFDI/invoice/payment/acuse docs |
| Per-operation digital file | 🟡 Partial | `ConsultaView` lists artifacts but no formal expediente envelope |

### 2.9 LFPDPPP Privacy

| Requirement | Status | Evidence |
|---|---|---|
| Aviso de privacidad | ❌ Missing | No privacy notice in UI or docs |
| Consent management | ❌ Missing | No consent capture/withdrawal |
| ARCO rights workflow | ❌ Missing | No access/rectification/cancellation/opposition workflow |
| PII encryption at rest | 🟡 Partial | RFC/CURP/passport encrypted; name/address/email/phone plaintext |
| Data retention policy | ❌ Missing | No retention/deletion schedule |
| Breach notification plan | ❌ Missing | No incident response documented |

### 2.10 Prevalidación Electrónica / ISO 27001

| Requirement | Status | Evidence |
|---|---|---|
| Structural prevalidation | ✅ Implemented | `shared/pedimento/prevalidate.ts` |
| RFC/CURP checksum validation | ✅ Implemented | `shared/parsing/taxId.ts` |
| Live prevalidator integration | ❌ Missing | No CAAAREM/CLAA/ANAM client |
| ISO 27001 ISMS | ❌ Missing | No policies, risk assessment, SoA, pen-test evidence |
| Rate limiting / CSRF | 🟡 Partial | One route rate-limited; no global protection; CSRF not applicable to JWT but no origin binding |
| Input schema validation | ❌ Missing | Ad-hoc validation only; no Zod/Joi |

### 2.11 VOCE-SAAI M3 / e.firma

| Requirement | Status | Evidence |
|---|---|---|
| SAAI M3 record modeling | 🟡 Partial | Header/partidas modeled; records 505/551/557 not fully validated |
| Fixed-width M3 export | ❌ Missing | All output is JSON/XLSX |
| e.firma fields in model | 🟡 Partial | `certificateSerial` exists but not populated |
| CADENA ORIGINAL computation | ❌ Missing | No canonicalization logic |
| Digital SELLO application | ❌ Missing | No RSA-SHA256 signing |
| SAT Certifica integration | ❌ Missing | No OCSP/certificate validation |

### 2.12 Air Cargo / e-AWB

| Requirement | Status | Evidence |
|---|---|---|
| e-AWB integration | ❌ Missing | No airline/CCS API client |
| MAWB handling | 🟡 Partial | `mawbReference` captured from manifest |
| RGCE 1.9.10/1.9.15 transmission | ❌ Missing | No cargo-info transmission endpoint |

---

## 3. Critical Findings (Show-Stoppers)

### 🔴 CR-1: Pedimento builder calculates forbidden IVA contribution
**Location:** `shared/pedimento/buildPedimento.ts:30`
```ts
contribuciones: [{ concepto: 'IVA', tasa: 19, importe: Math.round(s.customsValueUsd * opts.tipoCambio * 0.19 * 100) / 100 }]
```
**Impact:** T1/IMD pedimentos use a global composite rate under RGCE 3.7.35 and do not declare per-partida IVA/IGI/DTA contributions. This violates the PRD and ANAM expectations.
**Fix:** Set `contribuciones: []` in T1 output; store captured global rate only.

### 🔴 CR-2: Pedimento builder does not force generic HS codes
**Location:** `shared/pedimento/buildPedimento.ts:24`
```ts
fraccion: s.hsCode.replace(/\./g, '')
```
**Impact:** Real LIGIE HS codes can flow into pedimento output. Prevalidation rejects them later, but the builder itself is non-compliant.
**Fix:** Map unit to generic code (`9901.00.01/02/05`) or reject non-generic input before build.

### 🔴 CR-3: No live SAT/ANAM/VUCEM/SEA/SAAI integration
**Impact:** The platform cannot submit pedimentos, receive validation responses, or obtain línea de captura. It is a back-office workbench, not a customs-filing system.
**Fix:** Implement SEA/SAAI M3 transmission client, VUCEM/COVE integration, and SAT catalog sync.

### 🔴 CR-4: No FIEL/e.firma digital seal
**Impact:** Generated documents cannot be legally sealed or submitted. Legacy `src/engine/prevalidador.ts` uses a toy non-cryptographic hash.
**Fix:** Implement FIEL certificate storage, CADENA ORIGINAL computation, and RSA-SHA256 SELLO.

### 🔴 CR-5: No Ficha 124/LA or 125/LA generation
**Impact:** Direct statutory obligation; >3 omissions/year can cancel the T1 permit (RGCE 3.7.34 / Art. 88 Ter).
**Fix:** Build pipe-delimited ASCII `.txt` inside `.zip` generators with correct Julian-day naming.

### 🔴 CR-6: Hardcoded JWT fallback secret
**Location:** `server/src/auth/token.ts:4`
```ts
const SECRET = process.env.JWT_SECRET ?? 'change-me-in-production';
```
**Impact:** ANAM would flag this as a hardcoded credential. While production startup blocks the default, the fallback exists at module level.
**Fix:** Throw if `JWT_SECRET` is unset, mirroring `server/src/index.ts`.

### 🔴 CR-7: Legacy simulation-only engine still present
**Locations:** `src/engine/t1Compliance.ts`, `src/engine/prevalidador.ts`, `src/engine/taxCalculator.ts`
**Impact:** Contradictory prevalidators, simulated ANAM checks, toy digital seal, and forbidden tax calculation remain in the tree. Risk of accidental reactivation.
**Fix:** Delete or quarantine legacy engine; make `shared/pedimento/` authoritative.

### 🔴 CR-8: No formal privacy program
**Impact:** Direct LFPDPPP non-compliance; fines up to ~MXN $34M and criminal liability for intentional misuse.
**Fix:** Publish aviso de privacidad, implement consent/ARCO workflow, define retention, create breach plan.

### 🔴 CR-9: No ISO 27001 / ISMS evidence
**Impact:** Required for ANAM-authorized prevalidators; expected for any regulated customs system.
**Fix:** Initiate ISO 27001:2013 implementation with policies, risk assessment, SoA, pen-test, BCP.

### 🔴 CR-10: Unencrypted PII beyond core identity fields
**Impact:** Name, address, email, phone stored plaintext in `shipments.data` JSONB. Database breach exposes consignee PII.
**Fix:** Encrypt or tokenize these fields; use deterministic encryption or secure hashing with search index if deduplication requires plaintext.

---

## 4. High-Priority Findings

### 🟠 HP-1: RFC/CURP validation weak in active paths
- `shared/pedimento/prevalidate.ts` uses `isValidTaxId` which only checks shape; checksum is only a warning.
- Placeholder RFCs like `XXXX010101AAA` are accepted.

### 🟠 HP-2: RRNA detection split between frontend and backend
- Rich RRNA taxonomy in `src/engine/rrnaDetector.ts` and `src/constants/rrnaCategories.ts` is frontend-only.
- Backend risk engine uses only 14 keywords in `shared/risk/lists.ts`.

### 🟠 HP-3: Monthly address-level history missing
- `monthly_history` tracks consignee names only.
- RGCE requires tracking operations per delivery address.

### 🟠 HP-4: No global rate limiting / brute-force protection
- Only one route rate-limited.
- Login endpoint has no account lockout or CAPTCHA.

### 🟠 HP-5: High/critical CVEs in dependencies
- `xlsx`, `tar`, `glob` have unpatched high-severity vulnerabilities.

### 🟠 HP-6: No cancellation-trigger monitoring
- Adverse SAT status, "no localizado" domicile, <5 clearances/month are not monitored.

### 🟠 HP-7: No dedicated ANAM read-only API/portal
- `autoridad` role is generic; no ANAM-scoped credentials or separate access log.

### 🟠 HP-8: Catalog validation missing
- Aduanas, países, UMC/UMT, monedas, patentes not validated against SAT catalogs.

---

## 5. Strengths to Preserve

| Strength | Evidence |
|---|---|
| Hash-chained immutable audit log | `server/src/services/audit.ts`, `auditVerify.ts`, append-only trigger |
| PII encryption for core identity fields | `server/src/crypto/fieldCrypto.ts` |
| Configurable risk thresholds and lists | `shared/risk/ruleset.ts`, `server/src/routes/catalogs.ts` |
| Real 28-column manifest ingestion | `shared/parsing/headerSynonyms.ts`, `manifestParser.ts` |
| 8-signal risk engine with severity override | `shared/risk/signals.ts`, `classify.ts` |
| RBAC + MFA primitives | `server/src/auth/*` |
| 34-column LayOut_sistema export | `shared/export/layoutExport.ts` |
| Authority consolidated reporting | `server/src/routes/consolidated.ts` |
| Strong test coverage | 132/132 server tests passing |

---

## 6. Priority Remediation Roadmap

### Phase 1 — Production Blockers (0–4 weeks)
1. Remove JWT fallback secret; fail startup if `JWT_SECRET` missing.
2. Stop computing contributions in T1 pedimento builder.
3. Force generic HS codes in pedimento builder.
4. Delete/quarantine legacy `src/engine/*` simulation code.
5. Unify RRNA detection in backend risk engine.
6. Add monthly address-level history.
7. Make RFC/CURP checksum validation an error, not a warning.

### Phase 2 — ANAM Reporting & Operations (1–2 months)
8. Build Ficha 124/LA generator (consignee + address recurrent operations).
9. Build Ficha 125/LA generator (monthly detailed operations).
10. Add reporting scheduler with deadline tracking.
11. Implement cancellation-trigger monitoring (SAT status, domicile, clearance frequency).
12. Add automated quarantine for prohibited/RRNA goods.

### Phase 3 — Security & Privacy (1–2 months)
13. Encrypt/tokenize name, address, email, phone.
14. Add global rate limiting and brute-force protection.
15. Patch/replace vulnerable dependencies.
16. Make MFA mandatory for admin/super_admin/autoridad.
17. Implement JWT refresh + revocation.
18. Publish aviso de privacidad and ARCO workflow.
19. Document retention, backup, and BCP policy.

### Phase 4 — Government Integration (2–4 months)
20. Implement FIEL/e.firma pipeline (certificate storage, CADENA ORIGINAL, SELLO).
21. Build SAAI M3 fixed-width generator.
22. Integrate SEA/SAAI M3 transmission client.
23. Add VUCEM/COVE integration.
24. Implement live SAT catalog sync.
25. Add e-AWB / air cargo info integration.

### Phase 5 — Certification & Future-Proofing (3–6 months)
26. Initiate ISO 27001:2013 implementation.
27. Conduct independent penetration testing.
28. Separate audit-log storage (WORM/immutable store).
29. Add sanctions/denied-party screening.
30. Implement ML-based risk scoring with feedback loops.

---

## 7. Conclusion

SGA Customs is a **well-architected T1 risk-analysis foundation** with strong audit, encryption, and role-based access controls. However, it is **not yet ANAM-production-compliant** due to critical gaps in pedimento generation, government integration, mandatory reporting, security hardening, privacy program, and ISO 27001 evidence.

The most urgent actions are:
1. Fix the pedimento builder (contributions + generic HS codes).
2. Remove the JWT fallback secret.
3. Delete/quarantine legacy simulation code.
4. Build Ficha 124/LA and 125/LA generators.
5. Begin FIEL/SAAI M3/SEA integration planning.

Closing these gaps will put the platform on a credible path to supporting an ANAM-authorized courier operation.

---

*This audit is based on code inspection and prior audit documents. Final compliance interpretation should be validated with Mexican customs counsel before ANAM/SAT submission.*
