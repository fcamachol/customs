# ANAM Remediation — Remaining / Missing Tasks

**As of:** 2026-06-24
**Branch:** all completed work is merged into `main` (`48be57d`).
**Source plan:** `docs/superpowers/plans/2026-06-23-anam-compliance-remediation.md`
**Full execution trail:** `.superpowers/sdd/progress.md` (per-task verdicts, fixes, reviewer notes)

This file tracks everything from the 25-finding remediation plan that is **NOT yet done**. The 18 completed findings (F01, F02, F05–F13, F14, F15, F16-T1, F18, F20a/b/c, F24, F08) are merged and verified on `main` (root 323 tests, server 246 tests, 0 high/critical CVEs).

---

## 1. Actionable now — docs / policy tasks (no external blocker)

These are low-collision (mostly new docs + a few routes/migrations) and can be done on `main` whenever. They are P1/P2/P3.

| ID | Title | Effort | What it needs | Key files |
|----|-------|--------|---------------|-----------|
| **F19** | Reclassify VUCEM/COVE/MVE/e-AWB as a documented boundary | M (P2) | Remove dead `coveAcuseValor` field; add `docs/INTEGRATION_BOUNDARIES.md` + a typed `NotImplementedGovTransport` seam; reclassify in the reports | `shared/types/pedimento.ts`, `server/src/services/manifestLock.ts`, `server/src/services/integrations/govTransport.ts` (new), `docs/INTEGRATION_BOUNDARIES.md` (new) |
| **F21** | LFPDPPP privacy program (aviso, ARCO, retention, breach) | L (P1) | 4 governance docs + an ARCO intake route/table (subject stored as blind-index) + a dry-run retention service + an Aviso UI page | `docs/privacy/*.md` (new), `server/src/routes/privacy.ts` (new), `server/src/services/retention.ts` (new), migrations for `arco_requests` + `data_retention_class`, `src/components/{AvisoPrivacidadView,ArcoRequestView}.tsx` (new) |
| **F23** | Data retention / backup / BCP-DRP + pluggable storage | L (P1) | 2 ops policies (5-yr retention, BCP/DRP RTO/RPO) + retention columns on `files` + a pluggable storage backend (S3 + local) + lifecycle sweep + backup scripts | `docs/ops/{DATA-RETENTION-POLICY,BCP-DRP}.md` (new), `server/src/storage/backends/*` (new), `server/src/storage/lifecycle.ts` (new), `server/src/jobs/retentionSweep.ts` (new), migration `files_retention_columns` |
| **F22** | ISO 27001 / ISMS evidence package | XL (P1) | ~15 ISMS docs under `docs/security/` (scope, policy, risk register, **Statement of Applicability** mapping Annex A → real controls, treatment plan, IR, BCP/DR, etc.). Also correct the reports' "required for prevalidators" wording → "expected/recommended target, not a published ANAM legal mandate." Pen-test itself is external (see §2). | `docs/security/00..14*.md` (new) |
| **F25** | Correct stale red-team report claims | S (P3) | Documentation-only: mark NaN→0, locale `1,000`, unweighted scoring, missing required-field enforcement, duplicate-header overwrite as RESOLVED on the production path (they are fixed in `validateManifest`/`normalize`/`scorecard`); add a dated correction note | `docs/validation_engine_top_tier_audit.md`, `docs/SGA_Customs_Full_Strategic_ANAM_Report_2026-06-22.md` |

> Note: F06's report correction (JWT "startup does not fail" refuted) was already applied during F06.

---

## 2. Externally blocked — need inputs only you can provide

These cannot be completed in-repo without third-party artifacts. The non-blocked portions were already shipped (e.g. F16 Track 1).

| ID | Blocked on | Notes |
|----|-----------|-------|
| **F03** Ficha 124/LA generator | The **official ANAM Ficha 124/LA `.txt` layout** (column order, pipe delimiter, Latin-1 encoding, header/trailer, `veeemmnnn.ddd` Julian filename) per the ANAM 78/LA reference | Recurrence detection already exists; only the statutory file format is missing. Build is ready once the layout is confirmed. |
| **F04** Ficha 125/LA monthly report | The **authoritative ANAM/DGIA-AGACE Ficha 125/LA field layout** + Julian-naming + encoding | Currently only a generic consolidated `.xlsx` exists. |
| **F16 Track 2** FIEL / e.firma signing + VUCEM transmission | **Valid CSD / e.firma certificates** + the **SAT/VUCEM web-service contract, endpoints, and accredited credentials** | Track 1 (delete toy seal, "not legally submittable" banner, decouple structural-vs-legal lock) is DONE and merged. Track 2 is the real signing+transmission pipeline. |
| **F17** SAAI M3 fixed-width generator/transmitter | The **Lineamientos Técnicos VOCE / Anexo 22 record layout** (positions/lengths/types for records 500/501/505/trailer) + a **SAT/ANAM sandbox endpoint + credentials** | Encoder + transmitter abstraction can be built once the layout + sandbox are available. |
| **F22 pen-test** (part of ISO) | Engagement of a **cybersecurity partner** to execute the penetration test (OWASP ASVS/Top 10) | The ISMS docs (F22 §1 above) can be authored without it; only the pen-test evidence is external. |

---

## 3. Deferred enhancements surfaced during the work

| Item | Why deferred | What's needed to do it |
|------|--------------|------------------------|
| **Cross-manifest fuzzy recurrence (F14)** | F14 ships **in-manifest** fuzzy entity resolution only. The cross-manifest version was removed because it required persisting a phonetic `consignee_name_block_key` — a lossy, name-derived value that partially re-introduces what F20 encrypted, and it was never wired into scoring. | A **privacy review** of storing a comparable (phonetic/blind-ish) key for cross-manifest typo clustering, then wiring `resolveNameClusters` over DB block-keys in `risk.ts`. |
| **Sanctions list operationalization (F18)** | `ingestSanctions.ts` parses a local OFAC SDN CSV fixture; BIS/EU/UN parsers are stubs and there's no scheduled refresh. | Implement BIS/EU/UN parsers + a cron refresh (the repo has scheduled-task infra) to keep `denied_parties` current. |
| **JWT auto-logout on remote revocation (F09)** | `clearSessionOnRevocation()` exists but isn't wired to an API interceptor, so a token revoked remotely only clears on the next explicit logout, not automatically on a 401. | Wire an API-layer 401 interceptor in the frontend to call `clearSessionOnRevocation()`. |
| **Rate-limit production hardening (F07)** | `trust proxy: true` allows X-Forwarded-For spoofing of the rate-limit key; in-memory store is per-process. | Tighten `trust proxy` to the known proxy hop count and add `rate-limit-redis` for multi-instance deployments. |

---

## 4. Known minor follow-ups (cosmetic / coverage — non-blocking)

Collected from per-task reviews; none block anything. Triage at leisure.

- **F05:** add a prevalidate integration test for a valid **CURP in the importer field** (unit-proven, route-untested).
- **F09:** add a dedicated route test for `PATCH /api/users/:id/role`.
- **F10:** remove the dead `rejectEnrollmentScope` import in `server/src/app.ts` (enforcement lives in `requireAuth`); frontend `enrollMfa` duplicates fetch logic instead of reusing `apiPost`.
- **F11:** `updateClientBody` zod schema is defined but `PUT /catalogs/clients/:id` isn't validated yet.
- **F20:** add a CI grep-gate for raw `.consignee.`/`.sender.`/`.platform.` SQL reads outside decrypt helpers (would have caught the consolidated-export ciphertext leak that was fixed).
- **F08:** `audit.yml` `setup-node` cache only covers the root lockfile (add `cache-dependency-path: '**/package-lock.json'`); consider **vendoring the xlsx CDN tarball** so CI `npm ci` doesn't depend on `cdn.sheetjs.com` being reachable.

---

## 5. Operational — required after this merge

- **Already done on this merge:** `npm install` (root + server) was run — bcrypt^6 native rebuild, node-pg-migrate^8, server vitest^4, xlsx pinned to the SheetJS CDN tarball. `npm audit --audit-level=high` passes (0 high/critical) in both.
- **Test infra flake:** the full server suite occasionally fails on a Postgres **`TRUNCATE` deadlock** in `test/helpers/db.ts` (shared test DB). It passes on isolated re-run. Worth fixing with per-test transactions or a serialized/ordered truncate.
- **Dev gotcha:** `server/.env` sets `MFA_ENFORCEMENT=warn` (so privileged users aren't locked out in dev). Enforce-mode tests pin `enforce` themselves; don't read MFA-enforcement test failures as a code regression.

---

## Suggested next order

1. **F25** (S) + **F19** (M) — quick wins, mostly docs.
2. **F21** + **F23** (L each) — the privacy + retention/BCP programs (share retention concepts; coordinate).
3. **F22** ISMS docs (XL) — author the package; pen-test runs in parallel once a partner is engaged.
4. **F03/F04/F16-T2/F17** — unblock by obtaining the official ANAM layouts + SAT/VUCEM credentials, then build.
