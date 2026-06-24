# FIEL / e.firma Integration — Capability Gap

**Status:** Track 2 — EXTERNALLY BLOCKED (as of 2026-06-23)  
**Task:** F16 — FIEL/e.firma signing  
**Track 1 shipped:** structural-lock decoupling + simulation banner (this branch)

---

## Current state (Track 1 only)

This system performs **structural pre-validation** of pedimento data (field completeness, type
checks, cross-reference logic). It does **not** produce legally valid customs declarations.

Specifically, the following capabilities are **absent**:

| Capability | Status |
|---|---|
| FIEL / e.firma (CSD) signing of pedimento | Not implemented |
| RSA-SHA256 sello computation (cadena original) | Not implemented |
| SAT/VUCEM web-service transmission | Not implemented |
| Acuse de recibo from VUCEM | Not implemented |
| Cert store for CSD `.cer` / `.key` / `.pfx` | Not implemented |

Any document exported by this system (PDF pedimento, report) is a **pre-validation / simulation
output only**. It carries no legal standing and must not be presented to customs authorities as a
valid declaration.

---

## What Track 2 requires

Track 2 is blocked on two external dependencies:

1. **SAT certificates** — a valid CSD (Certificado de Sello Digital) and/or e.firma (FIEL)
   certificate pair (`.cer` + encrypted `.key`, or a `.pfx`) issued by the SAT to the authorized
   signer. Development cannot proceed without real test certs or SAT-provided sandbox certs.

2. **VUCEM web-service contract** — access to the SAT/VUCEM transmission API requires a formal
   contract and credentials. The endpoint schema, auth mechanism, and sandbox environment must be
   confirmed with VUCEM before implementation begins.

Once both blockers are resolved, Track 2 implementation will include:

- `server/src/crypto/certStore.ts` — load and validate CSD/e.firma certs against SAT trust roots,
  store cert material encrypted at rest via `fieldCrypto.ts`.
- `server/src/crypto/cfdiSigner.ts` — build the cadena original, compute RSA-SHA256 sello, return
  typed `Sello { sello, noCertificado, fechaSellado, cadenaHash }`.
- DB migration adding `sello`, `no_certificado`, `sello_at`, `cadena_hash`, `transmission_status`,
  `acuse`, `acuse_at` columns to the `manifests` table.
- `server/src/routes/pedimento.ts` update — sign only after structural pre-validation passes AND
  an authorized signer with a valid cert acts; persist real sello + audit entry.
- `server/src/services/transmission/vucemClient.ts` — submit signed pedimento to SAT/VUCEM,
  persist acuse, behind a feature flag and per-environment credentials.
- Update `manifestLock.computeLock()` to gate the immutable lock on a real sello and/or acuse
  presence, not on structural APPROVED status.

---

## What "legally submittable" means

A pedimento is legally submittable when:

1. Structural pre-validation passes (APPROVED).
2. An authorized signer (with a valid, non-expired CSD/e.firma) digitally signs the cadena original
   using RSA-SHA256, producing a sello.
3. The signed pedimento is transmitted to SAT/VUCEM and an acuse de recibo with numero de
   confirmacion is received and persisted.

Steps 2 and 3 are Track 2 work and are not yet available in this system.

---

## Lock proxy note

`server/src/services/manifestLock.ts` `computeLock()` currently locks edits when a pedimento
reaches structural APPROVED status. This is a **conservative local proxy** to prevent accidental
data mutations after pre-validation — it is **not** a legal seal. The jsdoc in that file explains
this distinction and notes that Track 2 must update the lock condition.

---

## Related tasks

- **F15** — deleted `src/engine/prevalidador.ts` which contained a non-cryptographic toy seal
  (`simpleHash` / `generateVistoBueno`). That toy seal no longer exists in the codebase.
- **F20** — PII tokenization; seal inputs must coordinate with tokenization before Track 2.
- **F16 Track 1** — this document, structural-lock comment, and simulation banner.
- **F16 Track 2** — blocked; requires SAT certs + VUCEM contract.
