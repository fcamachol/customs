# Pedimento text extraction — golden fixture corpus

This directory pins the current output of `extractFromText()` (in
`server/src/services/pdfExtract/index.ts`, composing
`shared/pedimento/parsePedimentoText.ts` + `observation.ts` + `subdivision.ts`) against a corpus of
real-shaped pdf-parse TEXT outputs. It exists because that parser is regex-over-collapsed-text with
two known layouts (subdivision and consolidado), and its git history is a series of per-layout
patches — each one risks silently regressing the *other* layout. This corpus is the pedimento
equivalent of `shared/parsing/manifestGolden.test.ts` on the Excel/manifest side.

Each case is a pair:

- `<name>.txt` — the exact text `getPdfText()` would hand to `extractFromText()`. **Not a PDF.**
  The text layer is what the regexes actually consume, and what layout drift affects — a PDF fixture
  would only add pdf-parse itself as a variable we don't care about here.
- `<name>.expected.json` — the pinned `ExtractedPedimento` the parser currently returns for that
  text, checked by `../extractGolden.test.ts` via a recursive *subset* comparison: only the keys
  present in the JSON are asserted, so additive optional fields (e.g. a new optional
  `ExtractedPedimentoLine` field) don't break this corpus. Arrays (`lines`, `coveredGuias`,
  `warnings`, `subdivision.siblings`) are compared exactly (same length and order) since those are
  core semantic content, not extension points.

## Current cases

| fixture | covers |
|---|---|
| `subdivision-guia-valor` | Subdivision layout: `GUIA <n> VALOR <usd> USD NOMBRE <name> RFC-CURP <id>` partida observations, `SEGUNDA SUBDIVISION…` block with siblings/bultos/peso, `(GUIA/ORDEN EMBARQUE)/ID:` master-only list, ADUANA E/S + medios-de-transporte cluster, `DE DESPACHO:` address-then-code, `CLAVE/COMPL. IDENTIFICADOR` EM row, RFC-adjacent importer name, agentRfc/agencyRfc resolved from a window that also contains consignee RFC/CURP identifiers (see below — this was a known-wrong pin, now fixed). |
| `consolidado-consignatario` | Consolidado layout: `<guía> CONSIGNATARIO: <name> <id>` partida observations (VAL ADU→USD conversion via `valueUsdApprox`), `(GUIA/ORDEN EMBARQUE) / ID:` M/H list fragmented across a page-break, scattered ADUANA E/S / despacho / medios-de-transporte anchors, patente-line-before-razón-social agente parsing, value-before-label partida IVA row. Also the vehicle for the PAGO/ENTRADA open question below. |
| `print-date-before-fechas` | A `FECHA DE IMPRESION:` date printed before the `NUM. PEDIMENTO:`/`FECHAS` block, to confirm the FECHAS-anchored date scan doesn't let an earlier emission/print date shift entrada/pago. |
| `numero-15-contiguous` | `NUM. PEDIMENTO:` followed directly by 15 contiguous digits (no `CVE. PEDIMENTO:` text breaking the anchor), exercising the `anchoredNum` branch instead of the unanchored `dd dd dddd ddddddd` fallback. |
| `observaciones-unparseable` | An `OBSERVACIONES A NIVEL PARTIDA` section present in the text but using a grammar the parser doesn't recognize (`GUIA-NUM`/`IMPORTE`/`DESTINATARIO` instead of `GUIA`/`VALOR`/`NOMBRE`/`RFC-CURP`) — the production-incident signature (zero guías extracted silently). Pins the specific "se encontró la sección… pero no se pudo interpretar" warning, distinct from the generic no-section warning. |
| `empty-scanned` | Near-empty text (a couple of blank lines and a stray page number), simulating what pdf-parse returns for a scanned/image-only PDF with no real text layer. Pins the all-null header + generic warning + `confidence: 0.1` signature that `pedimentoUpload.test.ts`'s `sin_guias_cubiertas` gate depends on. |

### Known open question encoded here (Task 3)

In the consolidado layout, the `FECHAS` block lists **PAGO before ENTRADA** — but
`parsePedimentoText.ts` assumes the *first* `dd/mm/yyyy` after the `FECHAS` anchor is ENTRADA and
the second is PAGO. In every known real sample the two dates are identical, so this assumption is
currently **unobservable**: getting it backwards would produce a coincidentally-correct value, not a
wrong one. `consolidado-consignatario.txt` reproduces that (`entryDate === paymentDate ===
'2026-02-22'`), and `extractGolden.test.ts` has a dedicated `describe('golden: known open
question…')` block pinning that equality with a comment. If a real consolidado ever surfaces with
PAGO ≠ ENTRADA, add it as a new fixture here — that is the point where this pin will force an actual
decision about which date is which, instead of the ambiguity persisting silently.

### Fixed pin: agentRfc window collision (was "Known-wrong pin")

`subdivision-guia-valor.expected.json`'s `header.agentRfc` used to pin `"DOFR870512MD3"`, which is
a **consignee's** RFC/CURP from an OBSERVACIONES line, not the agente aduanal's own RFC
(`"SOVB680214FT4"`, printed via `RFC: SOVB680214FT4` right after the `NOMBRE O RAZ. SOC.:` label).
Root cause: the `agentRfc`/`agencyRfc` scan in `parsePedimentoText.ts` builds a window
`[anchorIndex - 300, anchorIndex + 400]` around each `NOMBRE O RAZ. SOC` anchor and used to take the
*first* RFC-shaped match **by document position** in that window — not the match closest to (or
after) the anchor. Because the partida OBSERVACIONES section is full of RFC/CURP-shaped identifiers
and commonly sits right before the agente block in real pedimentos, any such identifier within 300
characters of the anchor could win over the real agent RFC that appears *after* the label.

Fixed: the scan now picks the RFC-shaped match **closest to the anchor** (absolute distance, ties
broken toward after-the-anchor — see the "Agent RFCs" comment in `parsePedimentoText.ts`). The pin
is now `"SOVB680214FT4"`, the correct value. Regression coverage for the collision lives in
`shared/pedimento/parsePedimentoText.test.ts` (`SAMPLE_AGENT_COLLISION`).

## Adding a sanitized real sample

When a real pedimento PDF exposes a new layout quirk (a field pinned `null` that should be
populated, or a wrong value like the one above), add it here rather than only fixing the regex —
that's what keeps this corpus from rotting into "tests the parser against itself."

1. Dump the raw text pdf-parse sees, e.g. with a one-off node/tsx script:

   ```ts
   import { readFileSync } from 'node:fs';
   import { getPdfText } from '../index'; // server/src/services/pdfExtract/index.ts
   const buf = readFileSync('/path/to/real-pedimento.pdf');
   const text = await getPdfText(buf);
   console.log(text);
   ```

   (`getPdfText` is exported from `server/src/services/pdfExtract/index.ts`; the existing
   `server/test/routes/pedimentoUpload.test.ts` also has a `makeTextPdf()`/`pedimentoPdf()` helper
   if you'd rather build a synthetic PDF and run it through the real `pdf-parse` path once to sanity
   check line-wrapping/positional behavior before trimming it to a `.txt` fixture.)

2. **Sanitize before committing.** Real pedimentos carry PII: RFCs, CURPs, razones sociales,
   domicilios, guía numbers tied to real shipments. Replace every real identifier with a
   realistic-shaped fake of the same grammar the regex cares about:
   - RFC: `[A-ZÑ&]{3,4}` + 6 digits (date-shaped, doesn't need to be a real date) + 3 alphanumerics.
   - CURP-as-id in an observation: 4 letters + 6 digits + up to 8 more alphanumerics.
   - Names: swap for a plausible fake Mexican name of the same word count (name length affects the
     non-greedy `(.+?)` capture boundaries — keep it structurally similar).
   - Guía numbers / master guides / numero de pedimento: keep the same digit-count/shape, change
     the digits.
   - Addresses: keep the same rough structure (calle/colonia/CP/estado) with fake values.
   Do **not** just redact with `XXXX` — that changes the token shape the regex matches against and
   defeats the point of the fixture. Keep it *shaped* like the real thing, just not *the* real thing.

3. Trim surrounding noise you don't need (e.g. unrelated pages of a 800-partida consolidado) but
   keep enough surrounding context that the anchors this fixture is meant to exercise still fire the
   same way they did in the real document — a fixture that's minimal to the point of not resembling
   real pdf-parse output (e.g. missing the page-break artifacts, tab-vs-space column separators, or
   out-of-visual-order token scattering) won't catch the regressions this corpus exists to catch.

4. Run `extractFromText()` against the trimmed, sanitized text, **read the output yourself**, and
   only then write the `.expected.json` — don't hand-derive it from the regex source, verify it
   against the actual current behavior. If a field looks wrong, still pin the actual value (this is
   a regression corpus, not a correctness oracle) but write a note here (see the `agentRfc` example
   above) so the wrongness is documented instead of silently perpetuated.

5. Every new *production* layout incident (a pedimento that broke extraction in a way none of the
   existing fixtures would have caught) must land here as a fixture as part of the fix — that's the
   rule that keeps this corpus actually protective instead of just historical.
