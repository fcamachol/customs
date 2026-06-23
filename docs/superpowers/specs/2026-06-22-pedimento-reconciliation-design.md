# Manifest ↔ Pedimento Reconciliation — Design Spec

**Date:** 2026-06-22
**Status:** Approved (design); pending implementation plan
**Branch context:** `feat/t1-risk-platform`

## Context

Today a user uploads a manifest (xlsx → `shipments`) and can later upload the official
pedimento as a PDF (`POST /api/manifests/:id/pedimento-pdf`). But the uploaded PDF is only
**security-scanned** (malware / trojan-QR via the RF-08/RF-10 motors), stored, and used to lock
the manifest. Its **contents are never read** — `pdf-parse` is a dependency but is never
imported, and nothing compares the pedimento to the manifest. So "upload the pedimento after the
manifest" is purely archival and delivers no cross-validation.

This feature adds **manifest ↔ pedimento reconciliation**: extract the uploaded pedimento PDF's
fields and diff them against the expected pedimento (built from the manifest + import data),
then surface discrepancies as an exception-management report. This is where filing errors and
fraud surface — e.g. the per-consignee RFC/CURP mismatch this project already had to fix.

The pedimento PDF is the **Impresión Simplificada del Pedimento (Anexo 22)** — the standard
deliverable the agente aduanal must give the importer. The provided sample (`Pedimento 2.pdf`)
is a 240-page consolidated **T1** with a clean digital text layer (no OCR needed). Critically,
each line item ends with `OBSERVACIONES A NIVEL PARTIDA: GUIA <guía> VALOR <val> USD NOMBRE
<nombre> RFC-CURP <id>` — the **exact grammar `buildPedimento.ts` emits and `prevalidate.ts`
validates** — so the guía is a natural join key to manifest shipments.

## Decisions (from brainstorming)

- **Direction:** build reconciliation; keep the manifest-first flow (do NOT invert to
  pedimento-first — that's a rare edge case not worth a multi-table refactor).
- **Depth:** full — header + per-line (by guía) + totals.
- **Severity:** advisory only. Always store the PDF and lock the manifest; the report is for
  triage (verde/amarillo/rojo), never blocks.
- **Trigger:** auto-run on PDF upload right after the security scan passes; plus a manual re-run
  endpoint.
- **Surfaces:** one report object rendered in four places — Seguimiento (primary), Consulta
  (read-only), per-trámite drawer badge, downloadable XLSX.
- **Extraction strategy:** **A (deterministic text)** then **B (positional/table firm-up)**,
  with **C (LLM)** as a hard fallback only when A+B leave critical fields unresolved (off by
  default, auditable, expected rare).

## Architecture & module boundaries

Pure, isomorphic logic in `shared/`; Node-only PDF work in `server/`. One report object.

```
shared/pedimento/
  observationGrammar.ts   factor out { format, parse } of
                          "GUIA … VALOR … USD NOMBRE … RFC-CURP …"
                          (reused by buildPedimento + the new parser — one grammar)
  parsePedimentoText.ts   Approach A: text → ExtractedPedimento (partida observations + contiguous fields)
  reconcile.ts            pure matching engine: (expected, actual) → ReconciliationReport
shared/types/reports.ts   add ExtractedPedimento + ReconciliationReport types (shared client/server)
shared/export/reconciliationReport.ts   XLSX builder for the report artifact

server/src/services/pdfExtract/
  index.ts                extractPedimentoPdf(buffer): run A, then B to firm up, C if needed
  textLayer.ts            pdf-parse getText (feeds A)
  positional.ts           Approach B: pdfjs-dist coordinates / getTable for header + numeric grid
  aiFallback.ts           Approach C: Claude extraction, gated + off by default

src/components/
  ReconciliationPanel.tsx exception view (used by Seguimiento + Consulta)
```

**Rationale:** extracting the observation grammar into one module guarantees the string we
*write* (buildPedimento) and the string we *parse* (the PDF) are identical. The matching engine
is pure → unit-testable without any PDF.

## Extraction pipeline (A → B → C)

`extractPedimentoPdf(buffer) → { header, partidas[], extractionMethod, confidence, warnings[] }`

- **A — text (core):** `pdf-parse` text layer → parse every `OBSERVACIONES A NIVEL PARTIDA`
  block with `observationGrammar.parse` → `{ guia, valorUsd, nombre, id }` per line. Reliable
  because observations are contiguous in the text stream. The guía is the join key.
- **B — positional (firm-up):** the Anexo 22 header (núm. pedimento, importer/agent RFC, clave,
  tipo cambio, aduana, totals) and the partida numeric grid (fracción, val aduana USD) are NOT
  reliably adjacent in the text stream, so reconstruct them from `pdfjs-dist` item coordinates /
  `getTable()`. B fills/overrides A for those fields.
- **C — AI (hard fallback):** only if A+B leave critical fields unresolved or a sanity check
  fails (e.g. parsed-observation count ≪ fracción count). Off by default, behind a config flag;
  stamps `extractionMethod: 'ai'` for audit. Expected rare.

Always records `confidence` + `warnings[]` so the UI can show "extracted deterministically
(high)" vs "AI fallback used."

`extractionMethod: 'deterministic' | 'ai'` — `deterministic` covers the A+B path (text core,
positional firm-up); `ai` means the C fallback was invoked. A separate `usedPositional: boolean`
records whether B contributed, for diagnostics.

## Reconciliation engine & report shape

`reconcile(expected, actual)` — pure. **expected** = built on the fly from the manifest's
shipments via `buildPedimento` (+ `import_data` for header). **actual** = the extraction.
Degrades gracefully: line-level always runs (shipments always exist); header-level is skipped
with a note if no `import_data`/pedimento captured.

```ts
ReconciliationReport = {
  generatedAt: string;
  extractionMethod: 'deterministic' | 'ai';
  usedPositional: boolean;
  confidence: number;
  header: FieldDiff[];     // numeroPedimento, importerRfc, agentRfc, clave, aduana, tipoCambio
  totals: FieldDiff[];     // partidaCount, totalValorUsd, totalBultos
  lines: LineResult[];     // keyed by guía
  summary: {
    matched: number; mismatched: number;
    missingInPedimento: number; extraInPedimento: number;
    color: 'verde' | 'amarillo' | 'rojo';
  };
  notes: string[];         // e.g. "header skipped: no import data"
};
LineResult = {
  guia: string;
  status: 'matched' | 'mismatch' | 'missing_in_pedimento' | 'extra_in_pedimento';
  diffs: FieldDiff[];      // valorUsd, nombre, rfcCurp — expected vs actual
};
FieldDiff = { field: string; expected: string | number | null; actual: string | number | null; ok: boolean };
```

Match rules:
- guía: exact after trim (join key).
- valorUsd: equal within a small epsilon (float tolerance).
- nombre: equal after the existing `norm` (NFD + lowercase + trim).
- rfc/curp: equal after `cleanId` (uppercase + strip whitespace).
- Status taxonomy: `matched` (all diffs ok); `mismatch` (guía present both sides, ≥1 diff);
  `missing_in_pedimento` (manifest guía absent in PDF); `extra_in_pedimento` (PDF guía absent in
  manifest).

Color rollup (advisory triage, never blocks): `rojo` if any header/totals critical diff or any
`missing/extra` line; `amarillo` if only field-level line mismatches; `verde` if all matched.

## Data model & API

Mirrors the existing `pedimento_scan` (latest) + `pedimento_scans` (history) pattern:
- **Migration:** add `manifests.pedimento_reconciliation` JSONB (latest report) + a
  `pedimento_reconciliations` history table (`id, manifest_id uuid NOT NULL FK CASCADE, report
  jsonb, created_by, created_at`).
- **Auto-run:** in `pedimentoUpload.ts`, after a non-blocked scan + file save → extract →
  reconcile (build expected from shipments + import_data) → persist latest + history → include
  the report in the upload response. Also add the missing **manifest-exists guard** (the route
  currently does `UPDATE ... WHERE id=$1` that silently affects 0 rows when the id is wrong).
- **Manual re-run:** `POST /api/manifests/:id/pedimento/reconcile` — re-extract (or reuse stored
  extraction) and re-reconcile; useful after import_data changes or to force the AI fallback.
- **Read:** report rides along on the existing manifest/records fetch for Consulta. XLSX via
  `shared/export/reconciliationReport.ts` wired into the records artifacts route.

## UI

- **`ReconciliationPanel.tsx`** (Seguimiento primary; Consulta read-only): a summary strip
  (match %, counts by status, verde/amarillo/rojo) over a **filterable line table** (filter by
  status); each row expands to field-level expected-vs-actual. A header/totals comparison block
  sits above. Shows the extraction method/confidence badge.
- **`TramiteDetailDrawer.tsx`**: per-guía reconciliation badge + that shipment's field diffs.
- **Download:** reconciliation XLSX alongside Risk / Reporte General / LayOut.

## Testing

- **Pure unit (no PDF):**
  - `observationGrammar` round-trip (`format` → `parse` → equal); tolerant of the real PDF's
    spacing/casing.
  - `parsePedimentoText` against a trimmed **text fixture** captured from the real PDF.
  - `reconcile` across matched / value-mismatch / missing / extra / header-mismatch /
    no-import-data cases; color rollup.
- **Server:**
  - `extractPedimentoPdf` against a small committed fixture (trimmed text — NOT the 4.4 MB PDF);
    asserts A+B field population and that C is not invoked for the standard format.
  - upload route → report persisted (latest + history) & returned; manifest-exists guard.
  - manual reconcile endpoint.
- Full root + server suites stay green.

## Non-goals / future

- Pedimento-first / order-independent flow (not building; manifest-first stays).
- Blocking on discrepancies (advisory only this round; could add admin-configurable severity
  later).
- OCR for scanned image pedimentos (text-layer only; image PDFs fall to the C fallback or are
  flagged as unparseable).
- The `unbind/unlock` gap and broader audit P1 items remain separate follow-ons.
