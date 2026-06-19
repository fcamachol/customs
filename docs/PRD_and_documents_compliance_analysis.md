# Repo vs PRD v2 vs Production Documents — Compliance Analysis

**Repository:** `/Users/fernandocamacholombardo/customs` · `feat/t1-risk-platform`  
**PRD:** Análisis de Riesgo T1 · Capital Centennials v2.0 (Mayo 2026)  
**Production documents analyzed:**
- `Analisis de Riesgo 3.pdf` (UI/workflow spec)
- `Pedimento 2.pdf` (real 240-page T1 pedimento)
- `LayOut_sistema 2.xlsx` (34-column output template)
- `MANIFEST TEST 2.xlsx` (28-column input manifest)
- `Risk analysis 17 feb '25 2.xlsx` (8-signal risk engine)

**Date:** 2026-06-19

---

## 1. Executive Summary

The repository is **functionally aligned in spirit** with the PRD and production documents: it has the 6 modules, the 3 roles, the 8-signal risk engine, and the 34-column layout concept. However, **several critical discrepancies** exist between the PRD/source documents and the current implementation. The most serious:

1. **The repo generates pedimentos; the PRD says v1 only imports the agente aduanal’s PDF.**
2. **The repo calculates tax/tasa global; the PRD says it is only captured/read from the pedimento.**
3. **The repo actively detects RRNA; the PRD says RRNA = N/A in the T1 layout.**
4. **The repo’s manifest parser cannot read the real `MANIFEST_TEST.xlsx`** because it is keyed to output-layout headers instead of the 28 input headers.
5. **No chained-hash audit log, no MFA, no PII encryption** — PRD non-functional requirements are largely unmet.

### Overall readiness for AGACE evaluation
**Not ready.** The functional core is close, but the parser is broken for real data, several PRD mandates are contradicted by the code, and the security/compliance pillars required by ANAM are incomplete.

---

## 2. What the Production Documents Say

### 2.1 `Analisis de Riesgo 3.pdf` — UI/workflow source
- Defines the **6 sections** used in the repo sidebar.
- **Realizar Registro** is 3-step: upload manifest → run 8 validations → results table.
- Lists the **8 validations** that map to `shared/risk/signals.ts`.
- Results table columns: MWB, guía, destinatario, ciudad remitente, país remitente, Resultado, Motivo.
- **Seguimiento** imports pedimento PDF (40–80 MB) and captures import data; OCR is optional.
- **Reporte General** captures remitente + plataforma and merges into the layout XLS.
- **Consulta** shows the 3 artifacts: análisis de riesgo, pedimento, reporte general.

### 2.2 `Pedimento 2.pdf` — real T1 pedimento benchmark
- 240 pages, ~1,182 house guías, all fracción `99010001`.
- Header: CVE `T1`, Régimen `IMD`, pedimento `25 85 1653 5001684`, aduana `850`, patente `1653`.
- Tasa: IVA 19% visible; values all under $60 USD.
- Observation format: `GUIA JMX… VALOR … USD NOMBRE … RFC-CURP …`.
- Legal text cites RGCE 3.7.5, 3.7.35, NOM exemptions for mensajería.

### 2.3 `LayOut_sistema 2.xlsx` — 34-column T1 output template
- Real header row has 34 columns.
- Fixed output values: `Fracción arancelaria = 9901000100`, `Unidad de medida = PCS`, `RRNA = N/A`.
- `Tasa global` is a captured numeric field (sample `0.19`).
- Consignee block wants RFC **and** CURP; manifest only has one `ID` field.

### 2.4 `MANIFEST TEST 2.xlsx` — real 28-column input
- Headers: `MWB`, `Número de guía de embarque`, `Expedidor`, `Destinatario (CNNE)`, `ID`, `Valor total declarado`, `Peso`, `Unidad de peso`, etc.
- `Valor total declarado` is text with comma decimals (`"0,79"`).
- `Peso` is in grams; needs kg conversion.
- `Número de productos` is mostly `1`; LayOut quantities differ → report is aggregated/generated.

### 2.5 `Risk analysis 17 feb '25 2.xlsx` — authoritative 8-signal engine
- ~856,500 formulas across 17,133 rows.
- 8 rules, thresholds, and keyword/brand lists match the repo’s `shared/risk/` closely.
- Classification: `<2 flags = Verde`, `2–3 = Amarillo`, `≥4 = Rojo`.
- Prohibited keywords: maquillaje, liquido, pastilla, capsula, globo, pegamento, autoparte, pistola, droga, mariguana, suplemento, vitamina, medicamento.
- Piracy brands: Adidas, Nike, bimba y lola, gucci, samsung, apple, Louis Vuitton, dolce and gabbana, ray ban.
- Rule #4 (consignee repetition): the spreadsheet flags any consignee appearing more than once (COUNTIF > 1), i.e. threshold effectively `>1`.

---

## 3. Repo vs PRD — Detailed Comparison

### 3.1 Modules

| PRD Module | Status | Notes |
|------------|--------|-------|
| Realizar Registro | 🟡 Partial | UI exists, 8 validations implemented, but **parser broken for real manifest**. |
| Seguimiento | 🟡 Partial | PDF upload works, form exists, but **import-data capture is mocked** (no backend save). |
| Reporte General | 🔴 Missing/Stub | Form exists, no catalog, report is only 7 columns, not the full 34-col layout. |
| Consulta | 🟡 Partial | Search + downloads work, but UI lists 4 artifacts instead of 3 and files are regenerated per request. |
| Dashboard | 🟡 Partial | KPIs exist; real charts, “tiempos,” and expediente status are missing. |
| Acerca de | 🟡 Partial | Missing marco legal and Capital Centennials RFC/company data. |

### 3.2 Functional Requirements

| ID | Requirement | Status | Gap |
|----|-------------|--------|-----|
| RF-01 | Import any Excel `.xls/.xlsx` | 🟡 Partial | Synonym table does not include real 28-column headers. |
| RF-02 | Normalize decimals, weight, empties | 🔴 Missing | `0,79` parses as `0`; grams not converted to kg. |
| RF-03 | 8 risk validations | ✅ Yes | Implemented in `shared/risk/`. |
| RF-04 | Semáforo + Motivo + summary | 🟡 Partial | Summary uses `rojos` bucket instead of PRD’s `No identificados`. |
| RF-05 | Export risk analysis XLS | 🟡 Partial | Only 3 columns exported; missing Motivo and PRD columns. |
| RF-06 | Save risk analysis as file #1 | 🔴 Missing | Scores persisted in DB, not as immutable file artifact. |
| RF-07 | Search by MAWB/cliente | ✅ Yes | Works. |
| RF-08 | Import pedimento PDF 40–80 MB | 🟡 Partial | 100 MB limit, but in-memory storage, no MIME/size validation. |
| RF-09 | Capture import data | 🔴 Missing | Form is mocked; no backend table/route. |
| RF-10 | OCR auto-read pedimento | 🔴 Missing | Not implemented. |
| RF-11 | Capture remitente/plataforma with catalog | 🔴 Missing | No catalog backend. |
| RF-12 | Generate Reporte General XLS | 🔴 Missing | 7-column stub; no layout merge. |
| RF-13 | Save report as file #3 | 🔴 Missing | Not implemented. |
| RF-14/15 | View/download 3 files | 🟡 Partial | Works but regenerates files. |
| RF-16/17 | Dashboard charts | 🟡 Partial | Text/bars only; no charts. |
| RF-18 | Expediente status view | 🔴 Missing | Not implemented. |
| RF-19 | Acerca de legal/company data | 🟡 Partial | Incomplete. |
| RF-20 | Configurable branding | 🔴 Missing | Hardcoded text; no DB config. |
| RF-21 | Audit log + chained hash | 🔴 Missing | Append-only trigger only; no hash, no IP. |
| RF-22 | Authority read-only access | 🟡 Partial | Role exists; some write routes lack server-side role enforcement. |
| RF-23 | Consolidated authority report | 🔴 Missing | Not implemented. |
| RF-24 | Catalog management | 🔴 Missing | No tables/routes for clients, prohibited items, brands, params. |

### 3.3 Data Model

| PRD Source | Repo Status | Discrepancy |
|------------|-------------|-------------|
| 28-column manifest input | 🔴 Broken | `ShipmentCore` lacks real input fields; parser synonyms wrong. |
| 34-column layout output | 🟡 Partial | 34 columns emitted but **fixed values `9901000100`/`PCS`/`N/A` are not injected**. |
| Pedimento PDF header data | 🔴 Missing | No persistence of captured pedimento data. |
| Monthly history base | 🟡 Partial | Table exists; no `Valida` flag or consolidated report. |

### 3.4 Risk Engine

| Validation | Repo | PRD / Spreadsheet | Match? |
|------------|------|-------------------|--------|
| V1 ID length 13/18 | ✅ | ✅ | Yes |
| V2 Cantidad > 10 | ✅ | ✅ | Yes |
| V3 Monto <1 or >2500 | ✅ | ✅ | Yes |
| V4 Consignee repetition | `>1` | `>1` (COUNTIF) | Yes |
| V5 Address repetition | ✅ | ✅ | Yes |
| V6 Prohibited keywords | ✅ | ✅ | Yes |
| V7 Piracy brands | ✅ | ✅ | Yes |
| V8 Monthly history | ✅ | ✅ | Yes |
| Semáforo thresholds | `<2 / 2-3 / ≥4` | `<2 / 2-3 / ≥4` | Yes |

The risk engine itself is **faithful** to the spreadsheet.

### 3.5 Reports

| Report | Repo | PRD Need | Status |
|--------|------|----------|--------|
| Risk XLS | 3 columns | MWB + guía + destinatario + resultado + motivo + … | 🟡 Partial |
| Layout XLS | 34 columns but wrong values | Must force `9901000100`, `PCS`, `N/A` | 🟡 Partial |
| Reporte General | 7 columns | Full merge manifest + pedimento + client/platform | 🔴 Missing |
| Consolidated authority | None | Daily/monthly XLS to ANAM/SHCP | 🔴 Missing |

### 3.6 Security / Non-Functional Requirements (RNF)

| RNF | Status | Gap |
|-----|--------|-----|
| TLS 1.2+ / AES-256 at rest | 🔴 Missing | PII stored plaintext in JSONB. |
| MFA mandatory | 🔴 Missing | No TOTP/MFA implementation. |
| RBAC 3 roles, no shared accounts | 🟡 Partial | 3 roles exist, but capturista visibility is scoped to own records (PRD says all capturistas share). Some write routes only require `requireAuth`. |
| Secret management | 🟡 Partial | Hard-coded JWT fallback in source. |
| ISO/IEC 27001 | 🔴 Missing | No evidence. |
| Pen test passed | 🔴 Missing | No evidence. |
| Immutable audit log (who/when/IP/what) | 🟡 Partial | Append-only trigger only; no IP, no hash. |
| Chained hash integrity | 🔴 Missing | No `prev_hash`/`hash`. |
| Cloud DR / SLA 99.9% | 🔴 Missing | Not documented. |
| Large file object storage | 🔴 Missing | Local disk + memory storage. |
| Async batch processing | 🔴 Missing | Synchronous loop. |
| Real-time observability | 🔴 Missing | Console logging only. |

---

## 4. Critical Discrepancies (PRD says X, repo does Y)

| # | Topic | PRD / Source Document | Current Repo | Severity |
|---|-------|----------------------|--------------|----------|
| 1 | **Pedimento** | Import PDF only; generation/transmission is out of scope | `ManifestUploadView`, `T1Context`, `server/src/routes/pedimento.ts`, `shared/pedimento/buildPedimento.ts` generate/build pedimentos | 🔴 Critical |
| 2 | **Tasa global** | Captured/read from pedimento; system does NOT calculate | `src/engine/taxCalculator.ts` computes IGI/IVA/DTA; UI shows “Liquidación estimada MXN” | 🔴 Critical |
| 3 | **RRNA** | Layout field = `N/A`; no RRNA management in T1 | `src/engine/rrnaDetector.ts` actively categorizes RRNA goods | 🟡 High |
| 4 | **Manifest parser** | Must read 28-column `MANIFEST_TEST.xlsx` | Parser keyed to 34-column layout headers; real file maps 0 columns | 🔴 Critical |
| 5 | **Capturista visibility** | All capturistas see/continue each other’s records | `server/src/auth/access.ts` scopes `capturista` to own records | 🟡 High |
| 6 | **Audit log** | Chained hash, IP, before/after | Plain INSERT, no IP, no hash | 🔴 Critical |
| 7 | **Reporte General** | Full 34-column merge manifest + pedimento + client/platform | 7-column subset, no catalog | 🔴 Critical |
| 8 | **MFA / PII encryption** | Mandatory MFA, AES-256 at rest | Not implemented | 🔴 Critical |
| 9 | **Consolidated reports** | Daily/monthly authority report | Not implemented | 🟡 High |
| 10 | **Branding** | Configurable logo + RFC on screens and XLS | Hardcoded text | 🟡 Medium |

---

## 5. Priority Action Plan

### Block 0 — Fix before AGACE (this week)
1. **Rewrite `shared/parsing/headerSynonyms.ts`** to map the 28 real `MANIFEST_TEST` headers.
2. **Add input normalization:** comma→dot decimal parser, gram→kg conversion, lowercase country codes.
3. **Remove or quarantine** legacy pedimento generation and tax calculation from the active UI/server path.
4. **Inject fixed layout values** in `shared/export/layoutExport.ts`: `9901000100`, `PCS`, `N/A` for RRNA.
5. **Implement Seguimiento import-data persistence** (table + route + form wiring).
6. **Build the real Reporte General** (34-col merge + client/platform catalog).
7. **Add chained-hash audit log** with IP capture.
8. **Enforce server-side `autoridad` read-only** on all mutating routes.
9. **Restore capturista shared visibility** per PRD.
10. **Remove hard-coded JWT fallback** and require environment secret.

### Block 1 — Harden before evaluation
11. MFA (TOTP) for all users.
12. PII at-rest encryption (RFC/CURP/addresses/phones/emails).
13. Object storage with resumable upload for 80 MB pedimentos.
14. Rate limiting, input schema validation (Zod), CSRF protection.
15. Consolidated daily/monthly authority XLS report.
16. Configurable branding (logo + RFC) persisted in DB and rendered on XLS.

### Block 2 — Operational maturity
17. Async/batch processing for large manifests.
18. Real-time observability and structured logging.
19. Backup/DR policy and documented SLA.
20. ISO/IEC 27001 groundwork with a security partner.

---

## 6. Conclusion

The repo **already captures the domain model and risk engine** described in the PRD and production documents. Its biggest problems are not conceptual — they are **execution gaps and contradictions** with the PRD:

- The system tries to generate pedimentos and calculate taxes when the PRD explicitly says it must not.
- It cannot read the real manifest file it is supposed to process.
- It lacks the security, audit, and reporting foundations ANAM/AGACE will test.

Closing the Block 0 items above would make the platform coherent with the PRD and the production documents. Closing Block 1 and Block 2 would make it defensible in an AGACE cybersecurity and compliance evaluation.
