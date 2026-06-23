# SGA Customs — Agent Swarm Evaluation: ANAM T1 Platform vs. Top Tier

**Date:** 2026-06-22  
**Scope:** Evaluate the SGA Customs T1 risk-analysis platform against competitor aduana platforms and ANAM T1 permit requirements; identify gaps to reach top-tier status.  
**Method:** 5-agent parallel research swarm
- Codebase technical audit
- Competitor / reference-software intelligence
- ANAM T1 regulatory-requirements mapping
- Top-tier customs-platform capability benchmark
- UX / workflow evaluation

---

## 1. Executive Summary

SGA Customs has advanced rapidly from a compliance-audit backlog to a credible T1 risk-analysis foundation. The manifest parser now reads the real 28-column layout, the 8-signal risk engine is versioned and tested, audit logs are hash-chained, MFA and PII encryption are in place, and the authority portal + consolidated reports exist.

**However, the platform is not yet top-tier and is not production-ready for an ANAM-authorized courier operation.** The highest-impact gaps are:

1. **Government integration is missing** — no SAT/ANAM SEA/SAAI/VOCE/VUCEM client, no FIEL digital seal.
2. **Mandatory ANAM reports are missing** — Ficha 124/LA (recurrent operations) and Ficha 125/LA (monthly detail) are not generated.
3. **The pedimento builder contradicts the PRD** — it still calculates contributions and retains a legacy tax engine in `T1Context`. (The operative export already forces generic 9901 codes; the remaining work is removing the contribution calc, not adding generic-code forcing.)
4. **No denied-party / sanctions screening** — table stakes for trade compliance in 2026.
5. **UX still relies on manual re-entry** — no master-data autocomplete, no document extraction, weak progress feedback.
6. **No formal security / continuity program** — ISO 27001, rate limiting, CSRF, backup/BCP not implemented.

The good news: no incumbent owns the **AI-first, T1-specific risk-scoring lane**. CASA, VANTEC, SLAM, and CargoWise are either legacy desktop suites, enterprise-priced, or not purpose-built for mensajería y paquetería. There is clear white-space for SGA to become the top-tier T1 platform if it closes the government-integration, reporting, and compliance-automation gaps below.

---

## 2. Current Platform State (Snapshot)

> **Verification note (2026-06-22):** This report was re-checked against the actual codebase and authoritative sources with a 7-agent audit (4 code + 3 web/regulatory). All 12 "Implemented" items below verified TRUE. Corrections applied to the original draft:
> - The operative export **already forces generic 9901 codes** (`shared/export/layoutExport.ts:3,22`) — the real pedimento problem is the lingering contribution calculation / legacy tax engine, not generic-code passthrough.
> - Recurrent-operation detection **does exist** as the `bbdd` risk signal — the gaps are its threshold (`importacionesMes:1` vs. regulatory >3) and the absence of a formal Ficha 124 notice.
> - PDF upload limit is **100 MB**, not 80 MB (`server/src/routes/pedimentoUpload.ts:9`).
> - Prohibited-goods **detection exists** (`prohibidos` signal force-escalates to rojo); the gap is the lack of an automated block/quarantine action, not detection.
> - Alcohol/tobacco special rates live in **RGCE 3.7.36**, not 3.7.6 (renumbering artifact).
> - Master-data: a **client picker exists** (AutoridadView); the capture form (SeguimientoView) is where aduanas/agentes/patentes are still free-typed.
> - Competitive landscape: **CargoWise** reaches ~160 countries (not "45+"); **"Aduvanta"** could not be verified as a real vendor — confirm or remove.
> - Reporting deadlines (10/5-day) and `.zip ≤25 MB`/Julian-day format are plausible but only documented in SAT instructivo PDFs — confirm against the current Ficha 124/125 instructivos before relying.
>
> The §3/§4/§6/§7/§8 text below reflects these corrections.

### ✅ Implemented since last audit
| Capability | Evidence |
|---|---|
| Real 28-column manifest ingestion | `shared/parsing/headerSynonyms.ts`, `manifestParser.ts` |
| 8-signal risk engine + 3-bucket summary | `shared/risk/signals.ts`, `classify.ts`, `ruleset.ts` |
| Versioned ruleset per run | `shared/risk/ruleset.ts` |
| SHA-256 chained audit log + IP | `server/src/services/audit.ts`, `auditVerify.ts` |
| MFA (TOTP) | `server/src/auth/mfa.ts`, `src/components/LoginView.tsx` |
| PII AES-256-GCM at rest | `server/src/crypto/fieldCrypto.ts` |
| Client/platform catalog + validated RFCs | `server/src/routes/catalogs.ts` |
| Import-data capture (Seguimiento) | `server/src/routes/importData.ts` |
| Artifact persistence (risk/report XLSX) | `server/src/services/artifacts.ts` |
| Consolidated authority report | `server/src/routes/consolidated.ts` |
| PDF security scan | `server/src/services/pdfScan/` |
| Dashboard + navy/gold UI redesign | `src/components/DashboardView.tsx`, `Sidebar.tsx` |
| RBAC + shared capturista visibility | `server/src/auth/access.ts`, `server/test/routes/rbac.test.ts` |

### 🟡 Partial / needs hardening
- Pedimento generation still calculates contributions and keeps a legacy tax engine in `T1Context` (`buildPedimento.ts:30`, `T1Context.tsx:76`). The export layout already forces generic 9901 codes (`layoutExport.ts:3,22`); only the secondary `buildPedimento.ts:24` still echoes the input `hsCode`.
- `super_admin` role exists but cannot be created via API.
- ANAM authority portal exists but no dedicated scoped API/SSO or separate access log.
- No *global* rate limiting, CSRF tokens, or schema-validation library. (A 60 req/min per-user limiter does exist on the PII reports route — `reports.ts:31-43`.)
- Local disk file storage only; no object storage or resumable uploads for the 100 MB PDF ceiling (`pedimentoUpload.ts:9`).

### ❌ Missing / broken
- Live SAT/ANAM/VUCEM integration
- FIEL / e.firma digital seal (CADENA ORIGINAL)
- Ficha 124/LA and Ficha 125/LA generation
- Denied-party / sanctions screening (OFAC/BIS/EU/UN)
- ISO 27001 / formal ISMS
- Rate limiting / CSRF / schema validation
- Data retention / backup / BCP policy
- e-AWB / air-cargo info transmission (RGCE 1.9.10/1.9.15)

---

## 3. Competitive Landscape

### Incumbents in Mexico
| Platform | Positioning | Strengths | Weaknesses |
|---|---|---|---|
| **CASA** | Desktop broker suite (CSAAIwin, CCOVE, CVALwin) | Deep Mexican regulatory heritage | Legacy desktop, fragmented modules, no AI risk engine |
| **VANTEC / Darwin** | 37-year Mexican agency platform | Comprehensive document set, configurable rules | Traditional UI, no ML classification |
| **SLAM (OP-CBS)** | Cloud customs suite | Modern cloud, fast deployment | Smaller brand, no public pricing |
| **Aduvanta** ⚠️ *(unverified — no vendor by this name could be corroborated; confirm spelling/source or remove)* | Cloud all-in-one challenger | Transparent SaaS pricing, AI-assisted TIGIE, client portal | Newer entrant, less regulatory depth |
| **CAAAREM / CLAA Prevalidador** | SAT-aligned prevalidation service | Direct SAT/ANAM alignment | Service, not a full risk platform |

### Global reference platforms
| Platform | Key takeaway for SGA |
|---|---|
| **CargoWise** | Single global database, licensed across ~160 countries, high TCO (six-figure+ impl., now per-transaction pricing). Overkill for small T1 couriers. |
| **MIC-CUST** | Direct SAAI/VUCEM connectivity, ML classification (MIC CCS), multi-country. Enterprise focus. |
| **CBP ATS** | ML selectivity, intelligence fusion — government-only black box. |
| **ASYCUDA World** | ML dynamic selectivity, 100+ countries — government-only. |
| **Cotecna CRMS** | Item-level ML risk scoring, 80%+ hit-rate claims — sold to customs administrations. |
| **DHL / FedEx / UPS** | Clearance bundled with shipping; not standalone pedimento-prep systems. |

### White-space opportunity
No competitor is positioning as a **low-cost, AI-first, T1-specific risk-analysis layer** for Mexican couriers. SGA's traffic-light line-level risk scoring is a genuine differentiator — most broker tools only flag header-level errors. The opportunity is to own the T1 pre-clearance risk layer and wrap government submission through brokers/prevalidators.

---

## 4. ANAM T1 Permit Requirements & Gaps

### Business/operator requirements (Ficha 78/LA)
To obtain or renew an Empresa de Mensajería y Paquetería authorization, the operator must prove:
- Mexican corporate entity, active RFC, e.firma, up-to-date tax obligations
- Paid-in capital ≥ MXN $2,000,000 *(uncorroborated in the public Ficha 78/LA instructivo, which foregrounds the USD $1M fixed-asset test — verify)*
- Fixed-asset investment ≥ USD $1,000,000 (can be group company)
- Premises registered with SAT, legal occupancy ≥ 3 years
- Air-route registration with AFAC (if applicable)
- Warehouse custody concession or 2-year contract
- Courier/parcel-service permit from competent authority
- Written description of the risk-analysis system

**Software gap:** SGA does not yet have an authorization-management module to track these documents, renewal dates, or group-company investments.

### Software obligations (RGCE 3.7.4 / Art. 88 Bis)
The risk system must preserve and analyze:
- Value, description, nature, and origin of goods
- Country of origin
- Generic vs. specific descriptions
- Monthly operation counts/values per consignee and per delivery address
- Customs of entry
- Consignee/shipper master data (name, RFC/CURP/foreign tax ID/passport, address, phone, email)
- E-commerce platform data (commercial name, country, corporate name)
- Provide online access to ANAM/SAT

**Gaps:**
- Ficha 124/LA and 125/LA are not generated.
- No dedicated ANAM read-only API/portal with scoped credentials and separate access log.
- Recurrent-operation detection *does* exist as the `bbdd` risk signal (`monthlyHistory.ts`, `signals.ts:42` — "Varias importaciones en el mes"), but (a) its threshold is `importacionesMes:1` (`ruleset.ts:22`) — it fires on the first repeat, not the regulatory >3 ops/consignee/month — and (b) it is not surfaced as a formal Ficha 124 notice queue.

### T1 operational rules (RGCE 3.7.3, 3.7.5, 3.7.35)
- Value limit: USD 2,500 per consignee
- Generic HS codes: 9901.00.01 00, 9901.00.02 00, 9901.00.05 00
- Default global rate: 33.5% (non-treaty) — set by RGCE 3.7.35 (4th Resolution RGCE 2025, in force 15 Aug 2025)
- T-MEC bands (RGCE 3.7.35): ≤USD 50 exempt IGI/IVA; USD 50–117 = 17%; >USD 117 = 19% — *verify against RGCE 2026 (DOF 27 Dec 2025); this band structure is recent and volatile*
- Special rates for alcohol/tobacco (RGCE 3.7.36)
- Prohibited: powders/liquids/pharma requiring analysis, split shipments, zero-value goods, generic descriptions like "regalo"

**Gaps:**
- Tax/contribution calculation is present in the operative path (`buildPedimento.ts:30`, `T1Context.tsx` `calculateBatchTax`) when the PRD says it should not be. *(Note: the export layout already forces the generic 9901 fraction — `layoutExport.ts:3,22` — so generic-code forcing is NOT a gap; only the contribution calc and the legacy `buildPedimento` raw-`hsCode` path remain to be retired.)*
- No special-rate handling for alcohol/tobacco (RGCE 3.7.36).
- Prohibited-goods *detection* exists (the `prohibidos` signal flags `PROHIBITED_KEYWORDS` and force-escalates the row to rojo — `signals.ts:40`, `classify.ts:71`), but there is no automated block/quarantine workflow beyond flagging for human review.
- The legacy tax engine's bands are themselves non-compliant (it computes 0% or 33.5%, never the regulatory 17%/19% T-MEC bands) — a further reason to remove it from the operative path rather than fix it.

### Reporting obligations
| Report | Trigger | Deadline | SGA Status |
|---|---|---|---|
| Ficha 124/LA | >3 operations/consignee or address/month | First 10 days of next month | ❌ Missing |
| Ficha 125/LA | All monthly operations | First 5 days of next month | ❌ Missing |

Both must be pipe-delimited ASCII `.txt` inside a `.zip` ≤25 MB, named with Julian-day convention. *(Deadlines and this file-format spec are documented only in the SAT instructivos — confirm against the current Ficha 124/LA and 125/LA instructivos before implementing.)*

### Cancellation triggers to avoid (RGCE 3.7.34 / Art. 88 Ter)
- False documentation
- >3 failures to submit 124/125 in a year
- Adverse SAT listings (Arts. 69, 69-B, 69-B Bis, 17-H Bis, 49 Bis)
- "No localizado" fiscal domicile
- <5 clearances/month in last 6 months

**Implication:** automated reporting and SAT-status monitoring are not optional — they are permit-survival features.

---

## 5. Top-Tier Capability Benchmark (2026)

### Table stakes (must have to be credible)
- Rule-based + ML risk scoring
- Fuzzy name/entity matching
- Multi-list denied-party screening (OFAC/UN/EU/UK/BIS)
- Pedimento / invoice / AWB parsing
- VUCEM/SAT connectivity
- Immutable audit trail
- RBAC + MFA + encryption
- 5-year data retention
- Authority-ready exports

### Differentiators (top tier)
- **Machine-learned risk scoring** trained on clearance outcomes
- **Entity resolution / network analysis** to detect shells and transshipment
- **Per-item, per-fraud-type risk decomposition**
- **AI-assisted HS classification** with rationale and confidence
- **Dynamic valuation benchmarking** against historical/public prices
- **Real-time sanctions/PEP/adverse-media screening**
- **Customer self-service portal**
- **Pre-arrival data capture** (e-AWB, MVE, ICS2-style)
- **AEO/CTPAT readiness module**
- **ISO 27001 + SOC 2 Type II**

### Future-proof (2027–2030)
- LLM-powered classification assistants
- Blockchain/DID document notarization
- CBAM / EUDR / carbon reporting
- Cross-border risk-intelligence mesh
- No-code regulatory rule authoring

---

## 6. What's Missing to Be Top Tier — Consolidated Gap Matrix

| # | Gap | Why it blocks top-tier | Priority |
|---|---|---|---|
| 1 | **No SAT/ANAM/VUCEM integration** | Cannot submit, prevalidate, or get línea de captura. Platform is back-office only. | P0 |
| 2 | **No FIEL / CADENA ORIGINAL signing** | Generated documents are not legally sealable/submittable. | P0 |
| 3 | **Ficha 124/LA + 125/LA not generated** | Direct ANAM reporting obligation; >3 omissions/year risks permit cancellation. | P0 |
| 4 | **Pedimento builder contradicts PRD §10** | Operative path still calculates contributions / keeps a legacy tax engine in `T1Context` — compliance risk. (Generic 9901 codes are *already* forced in the export layout, so that part is done.) | P0 |
| 5 | **No denied-party / sanctions screening** | Table stakes for trade compliance; legal/regulatory exposure. | P1 |
| 6 | **No ISO 27001 / formal security program** | Required for prevalidators; expected for regulated customs systems. | P1 |
| 7 | **No *global* rate limiting / CSRF / schema validation** | Application-security hardening incomplete. (Only the PII reports route is rate-limited today.) | P1 |
| 8 | **No data retention / backup / BCP policy** | 5-year retention and operational resilience are regulatory expectations. | P1 |
| 9 | **UX: no master-data autocomplete in the capture form** | A client picker exists in the authority view, but the main capture form (`SeguimientoView`) free-types aduanas, agentes, patentes — causing errors and slowing operations. | P2 |
| 10 | **UX: no document extraction from PDFs** | Competitors auto-fill pedimento fields from PDFs; SGA requires full manual capture. | P2 |
| 11 | **UX: weak progress feedback + state loss on errors** | Erodes trust with large manifests and large PDFs (100 MB ceiling). | P2 |
| 12 | **PII exposure in XLSX exports** | On-screen Consulta is already redaction-gated for `autoridad` (`reports.ts:79-88`), but the downloadable Excel artifacts (`exports.ts`, `consolidated.xlsx`) ship unredacted RFC/CURP/name/address/email to any authenticated user. | P2 |
| 13 | **No e-AWB / air-cargo integration** | RGCE 1.9.10/1.9.15 requires air-cargo info transmission. | P2 |
| 14 | **No authorization-management module** | Ficha 78/LA tracking, renewal alerts, group-investment docs are manual. | P3 |
| 15 | **No AEO / trusted-courier readiness module** | Future competitive moat and ANAM facilitation lane. | P3 |

---

## 7. Prioritized Roadmap to Top Tier

### Phase 1 — Production Compliance (0–3 months)
1. **Converge pedimento generation on PRD §10:** remove contribution calculation from the operative path, retire the legacy tax engine from `T1Context`, and retire `buildPedimento.ts`'s raw-`hsCode` path. (Generic 9901 codes are already forced in `layoutExport.ts` — no new work needed there.)
2. **Implement Ficha 124/LA + 125/LA generation** with correct pipe-delimited `.txt` + `.zip` naming and email dispatch to DGIA/AGACE.
3. **Build recurrent-operation detection** (>3 ops/consignee or address/month) and surface it as a formal notice queue.
4. **Add global rate limiting, CSRF protection, and Zod schema validation** to all API routes.
5. **Remove hard-coded JWT fallback secret** and require `JWT_SECRET` at boot.
6. **Document and implement backup/BCP policy** (RTO/RPO, 5-year retention).

### Phase 2 — Government Integration (3–6 months)
7. **Integrate with SAT/ANAM SEA / SAAI / VOCE** for pedimento submission and validation responses.
8. **Implement FIEL-based digital sealing** (CADENA ORIGINAL computation + SAT e.firma).
9. **Build dedicated ANAM read-only portal/API** with scoped credentials and separate access log.
10. **Add VUCEM/COVE/MVE linkage** and acuse de valor handling.
11. **Add e-AWB / air-cargo info transmission** per RGCE 1.9.10/1.9.15.

### Phase 3 — Intelligence & Automation (6–12 months)
12. **Add denied-party screening** (OFAC SDN, UN, EU, UK OFSI, BIS) as a 9th risk signal.
13. **Replace exact-string matching** with fuzzy + normalized entity resolution for piracy/consignee/address signals.
14. **Add valuation anomaly detection** using distributional unit-price outliers and historical benchmarks.
15. **Implement AI OCR extraction** from pedimento PDFs to auto-fill Seguimiento capture fields.
16. **Add master-data autocomplete** for aduanas, agentes, patentes, clients, platforms.
17. **Launch customer self-service portal** for document upload and status tracking.

### Phase 4 — Scale & Moat (12–18 months)
18. **Pursue ISO/IEC 27001:2013 certification** (and SOC 2 Type II if serving enterprise).
19. **Build machine-learned risk scoring** trained on historical clearance outcomes.
20. **Add AEO / trusted-courier readiness module**.
21. **Implement ERP/WMS/TMS connectors** (SAP, NetSuite, Dynamics, CargoWise).
22. **Prototype CBAM/EUDR data models** for future compliance expansion.

---

## 8. Strategic Conclusion

SGA Customs is **no longer a prototype** — it is a well-architected foundation with the hardest domain logic (RGCE rules, risk scoring, audit integrity) already in place. The next leap to top-tier requires three things:

1. **Close the ANAM permit-survival gaps:** government integration, FIEL signing, and 124/125 reporting.
2. **Stop the PRD contradiction:** remove tax calculation from the operative path (generic T1 codes are already enforced in the export layout).
3. **Invest in intelligence and UX automation:** denied-party screening, document extraction, master-data catalogs, and ML risk scoring.

If these are executed in order, SGA can credibly position as the **AI-first T1 risk platform** for Mexican couriers — a category no incumbent currently owns.

---

## 9. Agent Sources & Raw Findings

Detailed outputs from the 5-agent swarm are available in the agent transcripts used for this synthesis:
- Codebase technical audit
- Competitor landscape report
- ANAM T1 regulatory requirements map
- Top-tier customs capability benchmark
- UX workflow evaluation

*This report does not constitute legal advice. Final ANAM/SAT compliance strategy should be validated with Mexican customs counsel.*
