# ANAM T1 Compliance Audit — SGA Customs

**Repository:** `/Users/fernandocamacholombardo/customs`  
**Branch:** `feat/t1-risk-platform`  
**Date:** 2026-06-19  
**Scope:** Determine whether the codebase meets the obligations of a Mexican customs T1 (courier simplified procedure) risk-analysis system under ANAM / SAT rules.

---

## 1. Executive Summary

### Important clarification
**"T1" is not an ANAM software-authorization category.** It is the *clave de pedimento* (customs declaration type) for the simplified clearance procedure used by **Empresas de Mensajería y Paquetería** (courier/express carriers) under Art. 88 Bis of the Ley Aduanera and RGCE 3.7.3–3.7.5.

ANAM does not certify "T1 software." Instead, the authorized courier must operate a **sistema de análisis de riesgo** that:
- Verifies customs and foreign-trade obligations.
- Preserves documentation on value, description, nature, and origin of goods.
- Provides **online access** to ANAM.
- Supports recurrent-operation notices (ficha 124/LA) and monthly reports (ficha 125/LA).

### Overall verdict
The SGA Customs platform implements **many of the functional pieces** required for a T1 courier risk-analysis system (risk scoring, RGCE rule engine, pedimento prevalidation, audit logging, reporting, RBAC). However, several **production-readiness and compliance gaps** remain before it could be used to support an ANAM-authorized courier operation.

| Readiness | Count of items |
|-----------|----------------|
| ✅ Satisfied | 14 |
| 🟡 Partial / needs hardening | 4 |
| ❌ Missing / simulated | 6 |

---

## 2. ANAM / SAT Requirements vs. Codebase Status

### 2.1 Courier authorization (operator obligation, not software obligation)

| Requirement | Status | Evidence / Notes |
|-------------|--------|------------------|
| Company must be authorized via ficha 78/LA as Empresa de Mensajería y Paquetería. | N/A — business process | Software does not grant authorization; it supports the authorized operator. |
| Submit certified copy of courier-service permit (RGCE 2026). | N/A — business process | Courier operator responsibility. |
| Maintain RFC, e.firma, tax obligations current. | N/A — business process | Operator responsibility. |

### 2.2 Risk-analysis system (software-relevant obligations)

| Requirement | Status | Evidence |
|-------------|--------|----------|
| Maintain a **sistema de análisis de riesgo**. | ✅ Implemented | `shared/risk/signals.ts`, `shared/risk/classify.ts`, `src/engine/t1Compliance.ts` |
| Verify customs and foreign-trade obligations. | ✅ Implemented | RGCE rule engine covers 3.7.3, 3.7.5, 3.7.35, 3.7.34; RRNA detector (`src/engine/rrnaDetector.ts`) |
| Preserve value, description, nature, and origin of goods. | ✅ Implemented | 34-column `LayOut_sistema` model (`shared/types/shipment.ts`), PostgreSQL persistence |
| Provide **online access** to ANAM. | 🟡 Partial | `autoridad` role + audit endpoint exist, but no dedicated ANAM read-only API or SSO/access-token mechanism is implemented. |
| Support ficha 124/LA recurrent-operation notices. | ❌ Missing | Recurrent consignee/address detection exists (`shared/risk/signals.ts`, `server/src/services/monthlyHistory.ts`) but no formal 124/LA report generation. |
| Support ficha 125/LA monthly detailed report. | ❌ Missing | Exports exist, but no ficha 125/LA formatted report. |
| Air-cargo information transmission (RGCE 1.9.10 / 1.9.15). | ❌ Missing | No live e-AWB or cargo-info integration. |

### 2.3 Pedimento generation and prevalidation

| Requirement | Status | Evidence |
|-------------|--------|----------|
| Generate T1 pedimentos with correct fields. | ✅ Implemented | `shared/pedimento/buildPedimento.ts`, `shared/types/pedimento.ts` |
| Prevalidate pedimento structure and catalog data. | ✅ Implemented | `shared/pedimento/prevalidate.ts` checks 15-digit pedimento, T1 clave, RFC/CURP, generic HS codes, value thresholds, observations. |
| Use generic tariff codes (9901.xxxx / 9902.xxxx). | ✅ Implemented | Checked in prevalidation and RGCE rules. |
| Apply global tax rates (33.5% / 19% / 0% de minimis). | ✅ Implemented | `src/engine/taxCalculator.ts` |
| Attach correct per-partida observations. | ✅ Implemented | `shared/pedimento/observation.ts` produces `GUIA n VALOR usd USD NOMBRE name RFC-CURP id` |
| Generate SAAI M3 layout (records 500/501/505/551/800). | 🟡 Partial | Legacy client export in `src/components/PedimentoBuilderView.tsx`; not yet driven by the new server-side pedimento model. |
| Apply digital seal / e.firma. | ❌ Missing | Record 800 contains a hard-coded placeholder; no cryptographic FIEL/SELLO/CADENA ORIGINAL signing. |

### 2.4 External integrations

| Requirement | Status | Evidence |
|-------------|--------|----------|
| Integration with SEA / SAAI / VOCE. | ❌ Simulated | `src/engine/t1Compliance.ts` comments state checks are simulated. |
| Integration with VUCEM for COVE / eDocuments / permits. | ❌ Missing | No VUCEM client. |
| Integration with SAT Certifica / e.firma. | ❌ Missing | No signing client. |
| Online access point for ANAM authority. | 🟡 Partial | `autoridad` role and audit endpoint only. |

### 2.5 Security, audit, and record-keeping

| Requirement | Status | Evidence |
|-------------|--------|----------|
| Individual user accounts and RBAC. | ✅ Implemented | `server/src/auth/*`, `server/src/auth/access.ts`, role-aware UI (`src/nav.ts`) |
| Encrypted password storage. | ✅ Implemented | bcrypt at 12 rounds (`server/src/auth/password.ts`) |
| JWT session management. | 🟡 Partial | 8h expiry; falls back to hard-coded secret `'change-me-in-production'`. |
| Audit trail of user actions. | ✅ Implemented | Append-only `audit_log` table with DB trigger; `recordAudit` service and `/api/audit` endpoint. |
| Audit log tamper protection. | ✅ Implemented | Trigger blocks UPDATE/DELETE on `audit_log`. |
| File upload path traversal protection. | ✅ Implemented | `basename()` sanitization in `server/src/storage/files.ts`. |
| CORS allowlist. | ✅ Implemented | `server/src/app.ts` uses `CORS_ORIGIN` env var. |
| ISO/IEC 27001-aligned controls (if prevalidating for third parties). | ❌ Missing | No ISMS evidence; only basic app-level controls. |
| Rate limiting / DDoS protection. | ❌ Missing | Not implemented. |
| CSRF protection. | ❌ Missing | Not implemented. |
| Input schema validation library. | ❌ Missing | Validation is ad-hoc regex/hand-written. |
| Formal data retention / backup / BCP. | ❌ Missing | Data persists in Postgres but no retention or disaster-recovery policy is visible. |

---

## 3. Key Strengths

1. **Domain model is aligned with T1 requirements.** The 34-column `LayOut_sistema`, generic HS-code handling, value thresholds, and observation format match RGCE 3.7.5 expectations.
2. **Risk engine is testable and server-side.** Moving the scoring to `shared/risk/` makes it reusable and auditable.
3. **Audit log is immutable at the database layer.** The append-only trigger is a strong control.
4. **Role-based access is enforced end-to-end.** API routes, data queries, and UI navigation all respect the `capturista` / `admin` / `autoridad` roles.
5. **RGCE rule engine covers the major T1 compliance topics.** Registry, generic descriptions, zero value, RFC, value cap, fractional shipments, transport modes, RRNA, and global tax rates are all encoded.

---

## 4. Critical Gaps

| # | Gap | Risk | Priority |
|---|-----|------|----------|
| 1 | **No real SAT/ANAM/VUCEM integration** | Cannot submit or prevalidate pedimentos against government systems. | Critical |
| 2 | **No cryptographic e.firma / SELLO / CADENA ORIGINAL** | Generated M3 file cannot be legally sealed or submitted. | Critical |
| 3 | **Ficha 124/LA and 125/LA reports not generated** | Courier cannot meet recurrent-operation and monthly-reporting obligations. | High |
| 4 | **No dedicated ANAM online-access API/portal** | Authority oversight requirement is only partially met via the generic `autoridad` role. | High |
| 5 | **Hard-coded JWT fallback secret** | Production misconfiguration could allow token forgery. | High |
| 6 | **No ISO 27001 / formal security program** | Required if offering prevalidation; strongly expected for a regulated customs system. | High |
| 7 | **No rate limiting / CSRF / schema validation** | Application security hardening incomplete. | Medium |
| 8 | **No data retention / backup / BCP policy** | Record-keeping obligations could be compromised by operational incidents. | Medium |
| 9 | **Legacy client-only T1 views coexist with new server-backed UI** | `src/components/PedimentoBuilderView.tsx`, `AnamPortalView.tsx`, etc. may drift and create confusion. | Medium |

---

## 5. Recommendations

### Immediate (before production use)

1. **Remove or guard the hard-coded JWT secret.** Require `JWT_SECRET` from environment and fail startup if missing.
2. **Add server-side schema validation** (Zod or similar) to all API routes, especially file uploads, pedimento generation, and user management.
3. **Implement rate limiting** on authentication and file-upload endpoints.
4. **Add CSRF protection** if cookies are introduced; otherwise ensure all state-changing requests require the JWT and use `Authorization: Bearer` only.
5. **Document the data-retention, backup, and recovery policy** and implement automated backups.

### Short-term compliance work

6. **Build ficha 124/LA generation.** Detect consignees/addresses with >3 operations/month and produce the official notice format.
7. **Build ficha 125/LA generation.** Produce the monthly detailed operations report for DGIA/AGACE.
8. **Create a dedicated ANAM read-only API/portal** with scoped credentials, read-only queries, and an access-log separate from the main audit log.
9. **Reconcile the SAAI M3 export** with the new server-side pedimento model; remove the legacy placeholder signature.

### Long-term / strategic

10. **Integrate with SAT/ANAM SEA / SAAI / VOCE** for real pedimento submission, validation responses, and linea de captura.
11. **Implement FIEL-based digital sealing** using a certified SAT e.firma and CADENA ORIGINAL computation per Anexo 22.
12. **Pursue ISO/IEC 27001:2013 certification** if the software will prevalidate pedimentos for third parties.
13. **Engage ANAM / a customs-technology consultant** to validate the ficha 78/LA authorization package and reporting formats.

---

## 6. Regulatory Sources

- ANAM — Mensajería y paquetería: https://www.anam.gob.mx/mensajeria-y-paqueteria/
- RGCE 2026 (SAT PDF): https://www.sat.gob.mx/minisitio/NormatividadRMFyRGCE/documentos2026/rgce/rgce/ReglasGeneralesComercioExteriorpara2026.pdf
- Ficha 78/LA (2024): https://www.anam.gob.mx/wp-content/uploads/2024/02/78_LA_08ENE24.pdf
- VOCE-SAAI M3 Lineamientos Técnicos v8.9: https://www.anam.gob.mx/wp-content/uploads/2021/09/Lineamientos_tecnicos_registros_V8.9_15022021.pdf
- Prevalidación electrónica lineamientos ANAM: https://www.anam.gob.mx/wp-content/uploads/2022/10/lineamientos_para_prestar_los_servicios_de_prevalidacion_electronica_de_datos.pdf
- Anexo 22 RGCE 2025 compilado: https://www.sat.gob.mx/minisitio/NormatividadRMFyRGCE/documentos2025/rgce/compiladas/CompiladoAnexo22_1raRMRGCE2025.pdf

---

## 7. Conclusion

SGA Customs is a **well-structured foundation** for a T1 risk-analysis platform and already implements the core RGCE logic, data model, scoring, audit trail, and reporting expected by ANAM/SAT. It is **not yet production-compliant** because it lacks live government integration, cryptographic signing, the mandated ficha 124/LA and 125/LA reports, and a formal security/continuity program. Closing the gaps above would put it on a credible path to supporting an ANAM-authorized courier operation.
