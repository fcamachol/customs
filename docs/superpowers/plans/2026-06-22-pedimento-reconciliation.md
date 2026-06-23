# Manifest ↔ Pedimento Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract an uploaded Anexo-22 pedimento PDF and reconcile it line-by-line (by guía) against the manifest, surfacing discrepancies as an advisory exception report in four UI surfaces.

**Architecture:** Pure, isomorphic logic in `shared/` (observation grammar parse, text parser, reconciliation engine); Node-only PDF I/O in `server/src/services/pdfExtract/` (text layer A, positional firm-up B, AI fallback C). The report is one object persisted on the manifest (latest + history) and rendered by a shared React panel. Reconciliation auto-runs after the existing security scan on PDF upload; it is advisory only and never blocks the lock.

**Tech Stack:** TypeScript (strict), vitest, Express, `pdf-parse` v2 (`PDFParse` class), `pdfjs-dist` (legacy build), `node-pg-migrate`, React.

## Global Constraints

- Reuse `shared/parsing/taxId.ts` `cleanId` for RFC/CURP normalization; never re-implement.
- Reuse the risk `norm` from `shared/risk/signals.ts` for name normalization (NFD + lowercase + trim).
- The observation grammar string MUST stay identical between writer (`partidaObservation`) and reader (`parseObservation`) — they live in the same file.
- `pdf-parse` v2 API: `const r = await new PDFParse({ data: new Uint8Array(buf) }).getText(); r.text` (string), `r.total` (page count). It is ESM — import with `import { PDFParse } from 'pdf-parse'`.
- Reconciliation is advisory: always store/lock as today; the report's `summary.color` is triage only.
- Do NOT commit the real 4.4 MB PDF. Tests use small text/JSON fixtures; the real PDF (`~/Downloads/Pedimento 2.pdf`) is used only in documented manual verification steps.
- A parallel refactor of `shared/parsing/manifestParser.ts` (adds `mapRowToShipment`, `procedenceCountry`) is in flight and independent of this work — do not depend on or revert it.
- Money compare tolerance: values equal within `1e-2` (one cent).
- Run `npx vitest run shared` (root) and `cd server && npm test` to verify; both must stay green.

---

### Task 1: Observation grammar — add a parser next to the writer

**Files:**
- Modify: `shared/pedimento/observation.ts`
- Test: `shared/pedimento/observation.test.ts`

**Interfaces:**
- Consumes: existing `partidaObservation(i: ObservationInput): string`.
- Produces: `parseObservation(line: string): ObservationInput | null` — inverse of `partidaObservation`. `valueUsd` is a number; returns `null` when the line is not in grammar.

- [ ] **Step 1: Write the failing test**

Add to `shared/pedimento/observation.test.ts` (create if absent; if present, append the `describe`):

```ts
import { describe, expect, it } from 'vitest';
import { partidaObservation, parseObservation } from './observation';

describe('parseObservation', () => {
  it('round-trips with partidaObservation', () => {
    const s = partidaObservation({ guideId: 'JMX600026618783', valueUsd: 3.86, consigneeName: 'Aarón Arce', id: 'AERA790828HBSRBR04' });
    expect(parseObservation(s)).toEqual({ guideId: 'JMX600026618783', valueUsd: 3.86, consigneeName: 'AARÓN ARCE', id: 'AERA790828HBSRBR04' });
  });
  it('parses a real PDF observation with 3-decimal value and multi-word name', () => {
    const r = parseObservation('GUIA JMX101245831553 VALOR 60.110 USD NOMBRE MAURICIO TORRES MONTEJO RFC-CURP TOMM020922D40');
    expect(r).toEqual({ guideId: 'JMX101245831553', valueUsd: 60.11, consigneeName: 'MAURICIO TORRES MONTEJO', id: 'TOMM020922D40' });
  });
  it('returns null for non-grammar text', () => {
    expect(parseObservation('OBSERVACIONES A NIVEL PARTIDA')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run shared/pedimento/observation.test.ts`
Expected: FAIL — `parseObservation is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `shared/pedimento/observation.ts`:

```ts
const OBS_RE = /^GUIA\s+(\S+)\s+VALOR\s+([\d.,]+)\s+USD\s+NOMBRE\s+(.+?)\s+RFC-CURP\s+(\S+)\s*$/;

export function parseObservation(line: string): ObservationInput | null {
  const m = (line ?? '').trim().match(OBS_RE);
  if (!m) return null;
  return {
    guideId: m[1],
    valueUsd: Number(m[2].replace(/,/g, '')),
    consigneeName: m[3].trim(),
    id: m[4],
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run shared/pedimento/observation.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add shared/pedimento/observation.ts shared/pedimento/observation.test.ts
git commit -m "feat(pedimento): add parseObservation grammar reader"
```

---

### Task 2: Reconciliation + extraction types

**Files:**
- Modify: `shared/types/reports.ts`

**Interfaces:**
- Produces: `ExtractedPedimentoLine`, `ExtractedPedimentoHeader`, `ExtractedPedimento`, `FieldDiff`, `LineResult`, `ReconciliationReport`, `ExpectedPedimento`. Consumed by Tasks 3–11.

This task is type-only (no runtime test); it is verified by `tsc` in later tasks.

- [ ] **Step 1: Add the types**

Append to `shared/types/reports.ts`:

```ts
// ---- Manifest ↔ pedimento reconciliation ----

export interface ExtractedPedimentoLine {
  guia: string;
  valueUsd: number | null;
  consigneeName: string | null;
  id: string | null;            // RFC or CURP as printed
  fraccion?: string | null;     // firmed up by positional pass
  valAduanaUsd?: number | null;
}

export interface ExtractedPedimentoHeader {
  numeroPedimento: string | null;
  clave: string | null;
  importerRfc: string | null;
  agentRfc: string | null;
  customsClearanceCode: string | null;
  tipoCambio: number | null;
  totalBultos: number | null;
}

export interface ExtractedPedimento {
  header: ExtractedPedimentoHeader;
  lines: ExtractedPedimentoLine[];
  extractionMethod: 'deterministic' | 'ai';
  usedPositional: boolean;
  confidence: number;           // 0..1
  warnings: string[];
}

/** Built from the manifest's shipments (+ optional import data) — the "should be" side. */
export interface ExpectedPedimento {
  header: Partial<ExtractedPedimentoHeader>;
  lines: { guia: string; valueUsd: number; consigneeName: string; id: string }[];
}

export interface FieldDiff {
  field: string;
  expected: string | number | null;
  actual: string | number | null;
  ok: boolean;
}

export interface LineResult {
  guia: string;
  status: 'matched' | 'mismatch' | 'missing_in_pedimento' | 'extra_in_pedimento';
  diffs: FieldDiff[];           // valorUsd, nombre, rfcCurp
}

export interface ReconciliationReport {
  generatedAt: string;
  extractionMethod: 'deterministic' | 'ai';
  usedPositional: boolean;
  confidence: number;
  header: FieldDiff[];
  totals: FieldDiff[];
  lines: LineResult[];
  summary: {
    matched: number;
    mismatched: number;
    missingInPedimento: number;
    extraInPedimento: number;
    color: RiskResultado;       // reuse 'verde' | 'amarillo' | 'rojo' | 'gris'
  };
  notes: string[];
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run lint`
Expected: exit 0 (no type errors).

- [ ] **Step 3: Commit**

```bash
git add shared/types/reports.ts
git commit -m "feat(reports): add reconciliation + extraction types"
```

---

### Task 3: Text parser (Approach A) — text → ExtractedPedimento

**Files:**
- Create: `shared/pedimento/parsePedimentoText.ts`
- Test: `shared/pedimento/parsePedimentoText.test.ts`

**Interfaces:**
- Consumes: `parseObservation` (Task 1); types (Task 2).
- Produces: `parsePedimentoText(text: string): ExtractedPedimento`. Scans the whole text for observation lines (the per-partida join data) and best-effort header fields via anchored regexes. `extractionMethod: 'deterministic'`, `usedPositional: false`, `confidence` set from how many lines parsed.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { parsePedimentoText } from './parsePedimentoText';

// Trimmed text captured from a real Anexo-22 pedimento (2 partidas).
const SAMPLE = `
DATOS DEL IMPORTADOR / EXPORTADOR
NUM. PEDIMENTO: CVE. PEDIMENTO:
25 85 1653 5001684
ADM130509UQ0
ADMERCE SA DE CV
T1
PARTIDAS
99010001	001 00 0 1 6 1.000 6 CHN CHN
TRAJE
OBSERVACIONES A NIVEL PARTIDA
GUIA JMX101245831553 VALOR 60.110 USD NOMBRE MAURICIO TORRES MONTEJO RFC-CURP TOMM020922D40
99010001	002 00 0 1 6 1.000 6 CHN CHN
COJIN
OBSERVACIONES A NIVEL PARTIDA
GUIA JMX101255006278 VALOR 12.000 USD NOMBRE ANA LOPEZ RUIZ RFC-CURP PERJ800101AA8
GLG1502247K9
`;

describe('parsePedimentoText', () => {
  it('extracts every partida observation as a line keyed by guía', () => {
    const out = parsePedimentoText(SAMPLE);
    expect(out.lines).toHaveLength(2);
    expect(out.lines[0]).toMatchObject({ guia: 'JMX101245831553', valueUsd: 60.11, consigneeName: 'MAURICIO TORRES MONTEJO', id: 'TOMM020922D40' });
    expect(out.lines[1].guia).toBe('JMX101255006278');
  });
  it('extracts header fields via anchored regexes', () => {
    const out = parsePedimentoText(SAMPLE);
    expect(out.header.numeroPedimento).toBe('258516535001684');
    expect(out.header.clave).toBe('T1');
    expect(out.header.importerRfc).toBe('ADM130509UQ0');
  });
  it('marks deterministic extraction with confidence > 0', () => {
    const out = parsePedimentoText(SAMPLE);
    expect(out.extractionMethod).toBe('deterministic');
    expect(out.usedPositional).toBe(false);
    expect(out.confidence).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run shared/pedimento/parsePedimentoText.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
import type { ExtractedPedimento, ExtractedPedimentoLine } from '../types/reports';
import { parseObservation } from './observation';

const NUMERO_RE = /\b(\d{2})\s+(\d{2})\s+(\d{4})\s+(\d{7})\b/;       // "25 85 1653 5001684"
const RFC_RE = /\b[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}\b/g;

export function parsePedimentoText(text: string): ExtractedPedimento {
  const t = text ?? '';
  const lines: ExtractedPedimentoLine[] = [];
  for (const raw of t.split(/\r?\n/)) {
    const obs = parseObservation(raw);
    if (obs) lines.push({ guia: obs.guideId, valueUsd: obs.valueUsd, consigneeName: obs.consigneeName, id: obs.id });
  }

  const num = t.match(NUMERO_RE);
  const numeroPedimento = num ? num[1] + num[2] + num[3] + num[4] : null;
  const clave = /\bT1\b/.test(t) ? 'T1' : null;
  const rfcs = t.match(RFC_RE) ?? [];
  const importerRfc = rfcs[0] ?? null;     // first RFC on the page is the importer block

  const warnings: string[] = [];
  if (lines.length === 0) warnings.push('No se encontraron observaciones a nivel partida en el texto.');

  return {
    header: {
      numeroPedimento, clave, importerRfc,
      agentRfc: null, customsClearanceCode: null, tipoCambio: null, totalBultos: null,
    },
    lines,
    extractionMethod: 'deterministic',
    usedPositional: false,
    confidence: lines.length > 0 ? 0.9 : 0.1,
    warnings,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run shared/pedimento/parsePedimentoText.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add shared/pedimento/parsePedimentoText.ts shared/pedimento/parsePedimentoText.test.ts
git commit -m "feat(pedimento): text-layer extraction (approach A)"
```

---

### Task 4: Reconciliation engine + expected-from-manifest builder

**Files:**
- Create: `shared/pedimento/reconcile.ts`
- Test: `shared/pedimento/reconcile.test.ts`

**Interfaces:**
- Consumes: types (Task 2); `cleanId` from `shared/parsing/taxId`; `norm` from `shared/risk/signals`; `Shipment` type.
- Produces:
  - `buildExpectedFromManifest(shipments: Shipment[], header?: Partial<ExtractedPedimentoHeader>): ExpectedPedimento`
  - `reconcile(expected: ExpectedPedimento, actual: ExtractedPedimento): ReconciliationReport`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { buildExpectedFromManifest, reconcile } from './reconcile';
import type { ExtractedPedimento, ExpectedPedimento } from '../types/reports';
import type { Shipment } from '../types/shipment';

function ship(over: Partial<Shipment>): Shipment {
  return {
    id: 'x', mawbReference: 'M', description: 'camisa', hsCode: '99010001',
    quantity: 1, unit: 'PCE', customsValueUsd: 10, currency: 'USD', originCountry: 'CN', guideId: 'G1',
    consignee: { name: 'Ana Lopez', rfc: 'PERJ800101AA8' }, sender: { name: 'S' }, platform: { commercialName: 'P' },
    ...over,
  } as Shipment;
}
function actual(over: Partial<ExtractedPedimento> = {}): ExtractedPedimento {
  return {
    header: { numeroPedimento: null, clave: 'T1', importerRfc: null, agentRfc: null, customsClearanceCode: null, tipoCambio: null, totalBultos: null },
    lines: [{ guia: 'G1', valueUsd: 10, consigneeName: 'ANA LOPEZ', id: 'PERJ800101AA8' }],
    extractionMethod: 'deterministic', usedPositional: false, confidence: 0.9, warnings: [],
    ...over,
  };
}

describe('reconcile', () => {
  it('marks a fully matching line as matched → verde', () => {
    const exp = buildExpectedFromManifest([ship({})]);
    const rep = reconcile(exp, actual());
    expect(rep.lines[0].status).toBe('matched');
    expect(rep.summary.color).toBe('verde');
  });
  it('flags a value mismatch as mismatch → amarillo', () => {
    const exp = buildExpectedFromManifest([ship({})]);
    const rep = reconcile(exp, actual({ lines: [{ guia: 'G1', valueUsd: 99, consigneeName: 'ANA LOPEZ', id: 'PERJ800101AA8' }] }));
    expect(rep.lines[0].status).toBe('mismatch');
    expect(rep.lines[0].diffs.find((d) => d.field === 'valorUsd')?.ok).toBe(false);
    expect(rep.summary.color).toBe('amarillo');
  });
  it('flags a manifest guía absent from the pedimento as missing → rojo', () => {
    const exp = buildExpectedFromManifest([ship({ guideId: 'G1' }), ship({ id: 'y', guideId: 'G2' })]);
    const rep = reconcile(exp, actual()); // only G1 present
    expect(rep.summary.missingInPedimento).toBe(1);
    expect(rep.summary.color).toBe('rojo');
  });
  it('flags a pedimento guía absent from the manifest as extra → rojo', () => {
    const exp = buildExpectedFromManifest([ship({ guideId: 'G1' })]);
    const rep = reconcile(exp, actual({ lines: [
      { guia: 'G1', valueUsd: 10, consigneeName: 'ANA LOPEZ', id: 'PERJ800101AA8' },
      { guia: 'G9', valueUsd: 5, consigneeName: 'X', id: 'PERJ800101AA8' },
    ] }));
    expect(rep.summary.extraInPedimento).toBe(1);
    expect(rep.summary.color).toBe('rojo');
  });
  it('compares header fields when expected header is provided', () => {
    const exp: ExpectedPedimento = { header: { numeroPedimento: '258516535001684', importerRfc: 'ADM130509UQ0' }, lines: [] };
    const act = actual({ header: { ...actual().header, numeroPedimento: '258516535001684', importerRfc: 'OTHER010101AAA' } });
    const rep = reconcile(exp, act);
    expect(rep.header.find((d) => d.field === 'numeroPedimento')?.ok).toBe(true);
    expect(rep.header.find((d) => d.field === 'importerRfc')?.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run shared/pedimento/reconcile.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
import type { Shipment } from '../types/shipment';
import type {
  ExpectedPedimento, ExtractedPedimento, ExtractedPedimentoHeader,
  FieldDiff, LineResult, ReconciliationReport,
} from '../types/reports';
import type { RiskResultado } from '../types/reports';
import { cleanId } from '../parsing/taxId';
import { norm } from '../risk/signals';

const MONEY_EPS = 1e-2;

export function buildExpectedFromManifest(
  shipments: Shipment[],
  header: Partial<ExtractedPedimentoHeader> = {},
): ExpectedPedimento {
  return {
    header,
    lines: shipments.map((s) => ({
      guia: s.guideId.trim(),
      valueUsd: s.customsValueUsd,
      consigneeName: s.consignee.name,
      id: s.consignee.curp ?? s.consignee.rfc ?? '',
    })),
  };
}

const diff = (field: string, expected: string | number | null, actual: string | number | null, ok: boolean): FieldDiff =>
  ({ field, expected, actual, ok });

const moneyOk = (a: number | null | undefined, b: number | null | undefined): boolean =>
  a != null && b != null && Math.abs(a - b) <= MONEY_EPS;

export function reconcile(expected: ExpectedPedimento, actual: ExtractedPedimento): ReconciliationReport {
  const notes: string[] = [];

  // Header comparison — only for fields the expected side provides.
  const header: FieldDiff[] = [];
  for (const field of ['numeroPedimento', 'importerRfc', 'agentRfc', 'clave', 'customsClearanceCode'] as const) {
    const exp = (expected.header as any)[field];
    if (exp == null) continue;
    const act = (actual.header as any)[field];
    const ok = field.endsWith('Rfc') ? cleanId(String(exp)) === cleanId(String(act ?? ''))
      : String(exp) === String(act ?? '');
    header.push(diff(field, exp, act ?? null, ok));
  }
  if (Object.keys(expected.header).length === 0) notes.push('Comparación de encabezado omitida: sin datos de pedimento/import-data.');

  // Line comparison keyed by guía.
  const actualByGuia = new Map(actual.lines.map((l) => [l.guia.trim(), l]));
  const seen = new Set<string>();
  const lines: LineResult[] = [];
  let matched = 0, mismatched = 0, missing = 0;

  for (const e of expected.lines) {
    const a = actualByGuia.get(e.guia);
    if (!a) { lines.push({ guia: e.guia, status: 'missing_in_pedimento', diffs: [] }); missing++; continue; }
    seen.add(e.guia);
    const diffs: FieldDiff[] = [
      diff('valorUsd', e.valueUsd, a.valueUsd, moneyOk(e.valueUsd, a.valueUsd)),
      diff('nombre', e.consigneeName, a.consigneeName, norm(e.consigneeName) === norm(a.consigneeName ?? '')),
      diff('rfcCurp', e.id, a.id, cleanId(e.id) === cleanId(a.id ?? '')),
    ];
    const ok = diffs.every((d) => d.ok);
    lines.push({ guia: e.guia, status: ok ? 'matched' : 'mismatch', diffs });
    ok ? matched++ : mismatched++;
  }

  let extra = 0;
  for (const a of actual.lines) {
    if (seen.has(a.guia.trim())) continue;
    lines.push({ guia: a.guia, status: 'extra_in_pedimento', diffs: [] });
    extra++;
  }

  const totals: FieldDiff[] = [
    diff('partidaCount', expected.lines.length, actual.lines.length, expected.lines.length === actual.lines.length),
  ];

  const headerBad = header.some((d) => !d.ok);
  const color: RiskResultado =
    headerBad || missing > 0 || extra > 0 ? 'rojo'
    : mismatched > 0 ? 'amarillo'
    : 'verde';

  return {
    generatedAt: '',                    // stamped by caller (Date is unavailable in some contexts)
    extractionMethod: actual.extractionMethod,
    usedPositional: actual.usedPositional,
    confidence: actual.confidence,
    header, totals, lines,
    summary: { matched, mismatched, missingInPedimento: missing, extraInPedimento: extra, color },
    notes,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run shared/pedimento/reconcile.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add shared/pedimento/reconcile.ts shared/pedimento/reconcile.test.ts
git commit -m "feat(pedimento): pure reconciliation engine + expected builder"
```

---

### Task 5: Positional firm-up (Approach B) — pure reconstruction over text items

**Files:**
- Create: `server/src/services/pdfExtract/positional.ts`
- Create: `server/test/services/positional.fixture.json`
- Test: `server/test/services/positional.test.ts`

**Interfaces:**
- Consumes: types (Task 2).
- Produces:
  - `interface TextItem { str: string; x: number; y: number; page: number }`
  - `reconstructHeader(items: TextItem[]): Partial<ExtractedPedimentoHeader>` — pairs known Anexo-22 labels with the nearest value to their right/below by coordinates. Pure; testable from a JSON fixture.

This firms up header fields A leaves null (agentRfc, customsClearanceCode, tipoCambio, totalBultos). Line numeric columns can be added later; not required for MVP.

- [ ] **Step 1: Create the fixture**

`server/test/services/positional.fixture.json` (hand-authored, coordinates approximate; label then value to its right on the same y):

```json
[
  { "str": "TIPO CAMBIO:", "x": 120, "y": 700, "page": 1 },
  { "str": "20.45680", "x": 230, "y": 700, "page": 1 },
  { "str": "ADUANA E/S:", "x": 320, "y": 700, "page": 1 },
  { "str": "850", "x": 410, "y": 700, "page": 1 },
  { "str": "PATENTE:", "x": 120, "y": 200, "page": 1 },
  { "str": "1653", "x": 200, "y": 200, "page": 1 },
  { "str": "GLG1502247K9", "x": 120, "y": 180, "page": 1 }
]
```

- [ ] **Step 2: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { reconstructHeader, type TextItem } from '../../src/services/pdfExtract/positional';

const items = JSON.parse(readFileSync(new URL('./positional.fixture.json', import.meta.url), 'utf8')) as TextItem[];

describe('reconstructHeader', () => {
  it('pairs tipo de cambio and aduana de despacho with the value to their right', () => {
    const h = reconstructHeader(items);
    expect(h.tipoCambio).toBeCloseTo(20.4568, 4);
    expect(h.customsClearanceCode).toBe('850');
  });
  it('finds the agent RFC token', () => {
    const h = reconstructHeader(items);
    expect(h.agentRfc).toBe('GLG1502247K9');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd server && npx vitest run test/services/positional.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write minimal implementation**

`server/src/services/pdfExtract/positional.ts`:

```ts
import type { ExtractedPedimentoHeader } from '../../../../shared/types/reports';

export interface TextItem { str: string; x: number; y: number; page: number }

const RFC_RE = /\b[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}\b/;

/** Value item immediately to the right of a label on (approximately) the same line. */
function valueRightOf(items: TextItem[], labelRe: RegExp): string | null {
  const label = items.find((i) => labelRe.test(i.str));
  if (!label) return null;
  const sameRow = items
    .filter((i) => i.page === label.page && Math.abs(i.y - label.y) <= 3 && i.x > label.x && i.str.trim())
    .sort((a, b) => a.x - b.x);
  return sameRow[0]?.str.trim() ?? null;
}

export function reconstructHeader(items: TextItem[]): Partial<ExtractedPedimentoHeader> {
  const tc = valueRightOf(items, /TIPO CAMBIO/i);
  const aduana = valueRightOf(items, /ADUANA E\/S|SECCION ADUANERA|ADUANA.*DESPACHO/i);
  const agentRfc = items.map((i) => i.str.trim()).find((s) => RFC_RE.test(s)) ?? null;
  return {
    tipoCambio: tc ? Number(tc.replace(/,/g, '')) : null,
    customsClearanceCode: aduana,
    agentRfc,
    totalBultos: null,
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd server && npx vitest run test/services/positional.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add server/src/services/pdfExtract/positional.ts server/test/services/positional.fixture.json server/test/services/positional.test.ts
git commit -m "feat(pdfExtract): positional header firm-up (approach B)"
```

---

### Task 6: PDF extraction orchestrator (A + B, C-gated) + text-item loader

**Files:**
- Create: `server/src/services/pdfExtract/textLayer.ts`
- Create: `server/src/services/pdfExtract/aiFallback.ts`
- Create: `server/src/services/pdfExtract/index.ts`

**Interfaces:**
- Consumes: `parsePedimentoText` (Task 3), `reconstructHeader`/`TextItem` (Task 5), types (Task 2).
- Produces: `extractPedimentoPdf(buffer: Buffer): Promise<ExtractedPedimento>`. Runs A (text), merges B (positional) into header, escalates to C only if `AI_PEDIMENTO_EXTRACTION=1` and A produced zero lines.

No unit test (PDF I/O). Verified by the route test (Task 8, stubbed) and the manual step (Task 13).

- [ ] **Step 1: Implement the text-item loader**

`server/src/services/pdfExtract/textLayer.ts`:

```ts
import { PDFParse } from 'pdf-parse';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { TextItem } from './positional';

export async function getPdfText(buffer: Buffer): Promise<string> {
  const r = await new PDFParse({ data: new Uint8Array(buffer) }).getText();
  return r.text ?? '';
}

export async function getPdfTextItems(buffer: Buffer): Promise<TextItem[]> {
  const doc = await getDocument({ data: new Uint8Array(buffer) }).promise;
  const out: TextItem[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    for (const it of content.items as Array<{ str: string; transform: number[] }>) {
      if (!it.str) continue;
      out.push({ str: it.str, x: it.transform[4], y: it.transform[5], page: p });
    }
  }
  return out;
}
```

- [ ] **Step 2: Implement the AI fallback stub**

`server/src/services/pdfExtract/aiFallback.ts`:

```ts
import type { ExtractedPedimento } from '../../../../shared/types/reports';

/** Approach C — last resort for non-standard PDFs. Off unless AI_PEDIMENTO_EXTRACTION=1. */
export function aiFallbackEnabled(): boolean {
  return process.env.AI_PEDIMENTO_EXTRACTION === '1';
}

export async function extractWithAi(_text: string): Promise<ExtractedPedimento> {
  // Intentionally not wired to a model yet; enabling the flag without an
  // implementation throws so it can never silently no-op in production.
  throw new Error('AI pedimento extraction (approach C) is not configured.');
}
```

- [ ] **Step 3: Implement the orchestrator**

`server/src/services/pdfExtract/index.ts`:

```ts
import type { ExtractedPedimento } from '../../../../shared/types/reports';
import { parsePedimentoText } from '../../../../shared/pedimento/parsePedimentoText';
import { getPdfText, getPdfTextItems } from './textLayer';
import { reconstructHeader } from './positional';
import { aiFallbackEnabled, extractWithAi } from './aiFallback';

export async function extractPedimentoPdf(buffer: Buffer): Promise<ExtractedPedimento> {
  const text = await getPdfText(buffer);
  const a = parsePedimentoText(text);

  // Approach B: firm up header fields A left null.
  try {
    const items = await getPdfTextItems(buffer);
    const h = reconstructHeader(items);
    a.header = {
      ...a.header,
      agentRfc: a.header.agentRfc ?? h.agentRfc ?? null,
      customsClearanceCode: a.header.customsClearanceCode ?? h.customsClearanceCode ?? null,
      tipoCambio: a.header.tipoCambio ?? h.tipoCambio ?? null,
      totalBultos: a.header.totalBultos ?? h.totalBultos ?? null,
    };
    a.usedPositional = true;
  } catch (e) {
    a.warnings.push('Firm-up posicional (B) no disponible: ' + (e as Error).message);
  }

  // Approach C: only when A found nothing and the flag is on.
  if (a.lines.length === 0 && aiFallbackEnabled()) {
    return extractWithAi(text);
  }
  return a;
}
```

- [ ] **Step 4: Verify it compiles**

Run: `cd server && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/pdfExtract/textLayer.ts server/src/services/pdfExtract/aiFallback.ts server/src/services/pdfExtract/index.ts
git commit -m "feat(pdfExtract): orchestrate A+B extraction with gated C fallback"
```

---

### Task 7: Migration — reconciliation column + history table

**Files:**
- Create: `server/migrations/1700001900000_pedimento_reconciliation.ts`

**Interfaces:**
- Produces: `manifests.pedimento_reconciliation` JSONB; table `pedimento_reconciliations (id, manifest_id FK CASCADE, report jsonb, created_by FK SET NULL, created_at)`.

- [ ] **Step 1: Write the migration**

```ts
import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('pedimento_reconciliations', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    manifest_id: { type: 'uuid', notNull: true, references: 'manifests', onDelete: 'CASCADE' },
    report: { type: 'jsonb' },
    created_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('pedimento_reconciliations', 'manifest_id');
  pgm.addColumn('manifests', { pedimento_reconciliation: { type: 'jsonb' } });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn('manifests', 'pedimento_reconciliation');
  pgm.dropTable('pedimento_reconciliations');
}
```

- [ ] **Step 2: Run the migration against the test DB**

Run: `cd server && npm run migrate`
Expected: "Migrations complete!" with `1700001900000_pedimento_reconciliation` applied.

- [ ] **Step 3: Commit**

```bash
git add server/migrations/1700001900000_pedimento_reconciliation.ts
git commit -m "feat(db): pedimento_reconciliation column + history table"
```

---

### Task 8: Auto-run reconciliation on PDF upload (+ manifest-exists guard)

**Files:**
- Modify: `server/src/routes/pedimentoUpload.ts`
- Create: `server/src/services/reconciliationService.ts`
- Test: `server/test/routes/pedimentoReconciliation.test.ts`

**Interfaces:**
- Consumes: `extractPedimentoPdf` (Task 6), `buildExpectedFromManifest`/`reconcile` (Task 4), decrypt of shipments (existing pattern in risk route).
- Produces: `runReconciliation(manifestId: string): Promise<ReconciliationReport | null>` — loads shipments (decrypted), builds expected from manifest + stored pedimento/import_data header, re-reads the stored PDF bytes, extracts, reconciles, stamps `generatedAt`, persists latest + history. Returns null if no shipments.

- [ ] **Step 1: Write the failing route test**

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../../src/services/pdfScan', () => ({
  loadScanPolicy: async () => ({}),
  scanPedimentoPdf: async () => ({ verdict: 'clean', motors: {}, findings: [] }),
}));
vi.mock('../../src/services/pdfExtract', () => ({
  extractPedimentoPdf: async () => ({
    header: { numeroPedimento: null, clave: 'T1', importerRfc: null, agentRfc: null, customsClearanceCode: null, tipoCambio: null, totalBultos: null },
    lines: [{ guia: 'G1', valueUsd: 10, consigneeName: 'ANA LOPEZ', id: 'PERJ800101AA8' }],
    extractionMethod: 'deterministic', usedPositional: true, confidence: 0.9, warnings: [],
  }),
}));

import { createApp } from '../../src/app';
import { signToken } from '../../src/auth/token';
import { hashPassword } from '../../src/auth/password';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';
import { encryptConsignee } from '../../src/crypto/fieldCrypto';

const app = createApp();
let token: string; let manifestId: string;

beforeEach(async () => {
  await truncateAll();
  const hash = await hashPassword('p');
  const u = await query(`INSERT INTO users (username,password_hash,role) VALUES ('c',$1,'capturista') RETURNING id`, [hash]);
  token = signToken({ userId: u.rows[0].id, role: 'capturista' });
  const m = await query(`INSERT INTO manifests (mawb_reference) VALUES ('369-1') RETURNING id`);
  manifestId = m.rows[0].id;
  const s = { id: crypto.randomUUID(), mawbReference: '369-1', description: 'camisa', hsCode: '99010001',
    quantity: 1, unit: 'PCE', customsValueUsd: 10, currency: 'USD', originCountry: 'CN', guideId: 'G1',
    consignee: encryptConsignee({ name: 'Ana Lopez', rfc: 'PERJ800101AA8' }), sender: { name: 'S' }, platform: { commercialName: 'P' } };
  await query('INSERT INTO shipments (id, manifest_id, data) VALUES ($1,$2,$3)', [s.id, manifestId, JSON.stringify(s)]);
});

describe('reconciliation on pedimento PDF upload', () => {
  it('runs reconciliation, returns and persists the report', async () => {
    const res = await request(app)
      .post(`/api/manifests/${manifestId}/pedimento-pdf`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('%PDF-1.6 fake'), { filename: 'p.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(201);
    expect(res.body.reconciliation.summary.matched).toBe(1);
    expect(res.body.reconciliation.summary.color).toBe('verde');
    const { rows } = await query('SELECT pedimento_reconciliation FROM manifests WHERE id=$1', [manifestId]);
    expect(rows[0].pedimento_reconciliation.summary.matched).toBe(1);
    const hist = await query('SELECT count(*)::int n FROM pedimento_reconciliations WHERE manifest_id=$1', [manifestId]);
    expect(hist.rows[0].n).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/routes/pedimentoReconciliation.test.ts`
Expected: FAIL — `res.body.reconciliation` undefined.

- [ ] **Step 3: Implement the service**

`server/src/services/reconciliationService.ts`:

```ts
import { query } from '../db/pool';
import { readFile } from '../storage/files';
import { decryptConsignee } from '../crypto/fieldCrypto';
import { extractPedimentoPdf } from './pdfExtract';
import { buildExpectedFromManifest, reconcile } from '../../../shared/pedimento/reconcile';
import type { ReconciliationReport, ExtractedPedimentoHeader } from '../../../shared/types/reports';
import type { Shipment } from '../../../shared/types/shipment';

export async function runReconciliation(manifestId: string, fileBytes: Buffer): Promise<ReconciliationReport | null> {
  const { rows } = await query<{ data: any }>('SELECT data FROM shipments WHERE manifest_id=$1', [manifestId]);
  if (rows.length === 0) return null;
  const shipments: Shipment[] = rows.map((r) => ({ ...r.data, consignee: decryptConsignee(r.data.consignee) }));

  const man = await query<{ pedimento: any; import_data: any }>('SELECT pedimento, import_data FROM manifests WHERE id=$1', [manifestId]);
  const ped = man.rows[0]?.pedimento;
  const imp = man.rows[0]?.import_data;
  const header: Partial<ExtractedPedimentoHeader> = {};
  if (ped?.header) {
    header.numeroPedimento = ped.header.numeroPedimento ?? null;
    header.importerRfc = ped.header.importer?.rfc ?? null;
    header.agentRfc = ped.header.agent?.agentRfc ?? null;
    header.clave = ped.header.clave ?? null;
  }
  if (imp?.claveAduanaDespacho) header.customsClearanceCode = imp.claveAduanaDespacho;

  const extracted = await extractPedimentoPdf(fileBytes);
  const report = reconcile(buildExpectedFromManifest(shipments, header), extracted);
  report.generatedAt = new Date().toISOString();
  return report;
}

export async function persistReconciliation(manifestId: string, userId: string, report: ReconciliationReport): Promise<void> {
  await query('UPDATE manifests SET pedimento_reconciliation=$1 WHERE id=$2', [JSON.stringify(report), manifestId]);
  await query('INSERT INTO pedimento_reconciliations (manifest_id, report, created_by) VALUES ($1,$2,$3)', [manifestId, JSON.stringify(report), userId]);
}
```

- [ ] **Step 4: Wire into the upload route**

In `server/src/routes/pedimentoUpload.ts`, add a manifest-exists guard after the file checks (line ~13) and run reconciliation after the existing persist (after line 55). Replace the final block:

```ts
  // Guard: the manifest must exist (UPDATE ... WHERE id=$1 silently affects 0 rows otherwise).
  const exists = await query('SELECT 1 FROM manifests WHERE id=$1', [req.params.id]);
  if (exists.rowCount === 0) { res.status(404).json({ error: 'manifest not found' }); return; }
```

Place that guard right after `if (!req.file) ...` (top of handler). Then, after the `ATTACH_PEDIMENTO_PDF` / scan audit records and before the final `res.status(201)`, add:

```ts
  let reconciliation = null;
  try {
    reconciliation = await runReconciliation(req.params.id, req.file.buffer);
    if (reconciliation) {
      await persistReconciliation(req.params.id, req.user!.userId, reconciliation);
      await recordAudit({ userId: req.user!.userId, action: 'PEDIMENTO_RECONCILED', entity: 'manifest', entityId: req.params.id, after: reconciliation.summary, ip: req.ip });
    }
  } catch (e) {
    reconciliation = null; // advisory — never fail the upload
  }
  res.status(201).json({ fileId: meta.id, scan, reconciliation });
```

Add the import at the top: `import { runReconciliation, persistReconciliation } from '../services/reconciliationService';`

- [ ] **Step 5: Run test to verify it passes**

Run: `cd server && npx vitest run test/routes/pedimentoReconciliation.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/pedimentoUpload.ts server/src/services/reconciliationService.ts server/test/routes/pedimentoReconciliation.test.ts
git commit -m "feat(reconcile): auto-run on PDF upload, persist latest + history, add manifest guard"
```

---

### Task 9: Manual re-run endpoint

**Files:**
- Modify: `server/src/routes/pedimentoUpload.ts` (add a second route) OR `server/src/routes/records.ts` if that is where reads live; place it on the manifests router as `POST /:id/pedimento/reconcile`.
- Test: extend `server/test/routes/pedimentoReconciliation.test.ts`

**Interfaces:**
- Consumes: `runReconciliation`/`persistReconciliation` (Task 8); the stored PDF bytes via `readFile(manifests.file_id)`.
- Produces: `POST /api/manifests/:id/pedimento/reconcile → { reconciliation }`.

- [ ] **Step 1: Write the failing test**

Append to `server/test/routes/pedimentoReconciliation.test.ts`:

```ts
it('re-runs reconciliation on demand against the stored PDF', async () => {
  await request(app).post(`/api/manifests/${manifestId}/pedimento-pdf`)
    .set('Authorization', `Bearer ${token}`)
    .attach('file', Buffer.from('%PDF-1.6 fake'), { filename: 'p.pdf', contentType: 'application/pdf' });
  const res = await request(app).post(`/api/manifests/${manifestId}/pedimento/reconcile`)
    .set('Authorization', `Bearer ${token}`).send();
  expect(res.status).toBe(200);
  expect(res.body.reconciliation.summary.matched).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/routes/pedimentoReconciliation.test.ts -t "re-runs"`
Expected: FAIL — 404.

- [ ] **Step 3: Implement the route**

In `server/src/routes/pedimentoUpload.ts` add:

```ts
pedimentoUploadRouter.post('/:id/pedimento/reconcile', requireAuth, requireRole('admin', 'capturista'), async (req, res) => {
  const m = await query<{ file_id: string | null }>('SELECT file_id FROM manifests WHERE id=$1', [req.params.id]);
  if (m.rowCount === 0) { res.status(404).json({ error: 'manifest not found' }); return; }
  const fileId = m.rows[0].file_id;
  if (!fileId) { res.status(409).json({ error: 'No hay pedimento PDF adjunto' }); return; }
  const bytes = await readFile(fileId);
  const reconciliation = await runReconciliation(req.params.id, bytes);
  if (!reconciliation) { res.status(409).json({ error: 'No hay partidas en el manifiesto' }); return; }
  await persistReconciliation(req.params.id, req.user!.userId, reconciliation);
  res.status(200).json({ reconciliation });
});
```

Add `import { readFile } from '../storage/files';` if not already imported (the module exports `saveFile`; confirm the read accessor name — use the existing files-storage read function).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run test/routes/pedimentoReconciliation.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/pedimentoUpload.ts server/test/routes/pedimentoReconciliation.test.ts
git commit -m "feat(reconcile): manual re-run endpoint"
```

---

### Task 10: XLSX export of the reconciliation report

**Files:**
- Create: `shared/export/reconciliationReport.ts`
- Test: `shared/export/reconciliationReport.test.ts`
- Modify: the records artifacts route (`server/src/routes/records.ts`) to serve it (follow the existing risk/report xlsx download pattern).

**Interfaces:**
- Consumes: `ReconciliationReport` (Task 2).
- Produces: `reconciliationRows(report: ReconciliationReport): Record<string, string>[]` — one row per line (guía, estado, campo-diffs flattened). Reuses the project's existing xlsx writer used by `reportBuilder`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { reconciliationRows } from './reconciliationReport';
import type { ReconciliationReport } from '../types/reports';

const rep: ReconciliationReport = {
  generatedAt: '2026-06-22T00:00:00Z', extractionMethod: 'deterministic', usedPositional: true, confidence: 0.9,
  header: [], totals: [],
  lines: [
    { guia: 'G1', status: 'matched', diffs: [] },
    { guia: 'G2', status: 'mismatch', diffs: [{ field: 'valorUsd', expected: 10, actual: 99, ok: false }] },
  ],
  summary: { matched: 1, mismatched: 1, missingInPedimento: 0, extraInPedimento: 0, color: 'amarillo' }, notes: [],
};

describe('reconciliationRows', () => {
  it('emits one row per line with status and flattened diffs', () => {
    const rows = reconciliationRows(rep);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ 'Guía': 'G1', 'Estado': 'matched' });
    expect(rows[1]['Diferencias']).toContain('valorUsd');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run shared/export/reconciliationReport.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
import type { ReconciliationReport } from '../types/reports';

export function reconciliationRows(report: ReconciliationReport): Record<string, string>[] {
  return report.lines.map((l) => ({
    'Guía': l.guia,
    'Estado': l.status,
    'Diferencias': l.diffs.filter((d) => !d.ok).map((d) => `${d.field}: esperado=${d.expected ?? ''} pedimento=${d.actual ?? ''}`).join('; '),
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run shared/export/reconciliationReport.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the download route**

In `server/src/routes/records.ts`, add a `GET /:id/reconciliation.xlsx` handler mirroring the existing `report.xlsx`/risk artifact handler: load `manifests.pedimento_reconciliation`, `reconciliationRows(...)` → the same `sheetToXlsx` helper the other artifacts use → `res.type('xlsx').send(buf)`. (Match the exact helper name and auth used by the sibling artifact routes.)

- [ ] **Step 6: Commit**

```bash
git add shared/export/reconciliationReport.ts shared/export/reconciliationReport.test.ts server/src/routes/records.ts
git commit -m "feat(reconcile): downloadable XLSX artifact"
```

---

### Task 11: ReconciliationPanel component (Seguimiento + Consulta)

**Files:**
- Create: `src/components/ReconciliationPanel.tsx`
- Modify: `src/components/SeguimientoView.tsx` (render after PDF upload, from the upload response `reconciliation`)
- Modify: `src/components/ConsultaView.tsx` (render read-only from fetched manifest `pedimento_reconciliation`)
- Test: `src/components/ReconciliationPanel.test.tsx`

**Interfaces:**
- Consumes: `ReconciliationReport` (Task 2).
- Produces: `<ReconciliationPanel report={report} />` — summary strip + status filter + line table with expandable field diffs. Pure presentational; no fetching.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ReconciliationPanel } from './ReconciliationPanel';
import type { ReconciliationReport } from '../../shared/types/reports';

const rep: ReconciliationReport = {
  generatedAt: '2026-06-22T00:00:00Z', extractionMethod: 'deterministic', usedPositional: true, confidence: 0.9,
  header: [], totals: [],
  lines: [
    { guia: 'G1', status: 'matched', diffs: [] },
    { guia: 'G2', status: 'mismatch', diffs: [{ field: 'valorUsd', expected: 10, actual: 99, ok: false }] },
  ],
  summary: { matched: 1, mismatched: 1, missingInPedimento: 0, extraInPedimento: 0, color: 'amarillo' }, notes: [],
};

describe('ReconciliationPanel', () => {
  it('shows the summary counts and each line', () => {
    render(<ReconciliationPanel report={rep} />);
    expect(screen.getByText(/1 coincidencias/i)).toBeInTheDocument();
    expect(screen.getByText('G1')).toBeInTheDocument();
    expect(screen.getByText('G2')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/ReconciliationPanel.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```tsx
import { useState } from 'react';
import type { ReconciliationReport, LineResult } from '../../shared/types/reports';

const STATUS_LABEL: Record<LineResult['status'], string> = {
  matched: 'Coincide', mismatch: 'Discrepancia',
  missing_in_pedimento: 'Falta en pedimento', extra_in_pedimento: 'Extra en pedimento',
};

export function ReconciliationPanel({ report }: { report: ReconciliationReport }) {
  const [filter, setFilter] = useState<'all' | LineResult['status']>('all');
  const s = report.summary;
  const lines = filter === 'all' ? report.lines : report.lines.filter((l) => l.status === filter);
  return (
    <section data-color={s.color}>
      <header>
        <strong>{s.matched} coincidencias</strong> · {s.mismatched} discrepancias ·{' '}
        {s.missingInPedimento} faltantes · {s.extraInPedimento} extra
        <span> ({report.extractionMethod}{report.usedPositional ? '+pos' : ''}, conf {Math.round(report.confidence * 100)}%)</span>
      </header>
      <select value={filter} onChange={(e) => setFilter(e.target.value as any)}>
        <option value="all">Todas</option>
        {Object.keys(STATUS_LABEL).map((k) => <option key={k} value={k}>{STATUS_LABEL[k as LineResult['status']]}</option>)}
      </select>
      <table>
        <thead><tr><th>Guía</th><th>Estado</th><th>Diferencias</th></tr></thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.guia}>
              <td>{l.guia}</td>
              <td>{STATUS_LABEL[l.status]}</td>
              <td>{l.diffs.filter((d) => !d.ok).map((d) => `${d.field}: ${d.expected ?? '—'} → ${d.actual ?? '—'}`).join('; ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/ReconciliationPanel.test.tsx`
Expected: PASS.

- [ ] **Step 5: Wire into the two views**

- `SeguimientoView.tsx`: store the `reconciliation` field returned by the pedimento-pdf POST response in state and render `{reconciliation && <ReconciliationPanel report={reconciliation} />}` inside the pedimento upload block.
- `ConsultaView.tsx`: read `manifest.pedimento_reconciliation` from the existing fetched record and render `{rec && <ReconciliationPanel report={rec} />}` read-only.

- [ ] **Step 6: Commit**

```bash
git add src/components/ReconciliationPanel.tsx src/components/ReconciliationPanel.test.tsx src/components/SeguimientoView.tsx src/components/ConsultaView.tsx
git commit -m "feat(ui): reconciliation panel in Seguimiento + Consulta"
```

---

### Task 12: Per-guía badge in the trámite drawer

**Files:**
- Modify: `src/components/TramiteDetailDrawer.tsx`
- Test: `src/components/TramiteDetailDrawer.test.tsx` (create if absent)

**Interfaces:**
- Consumes: `ReconciliationReport` (Task 2); the drawer already receives a `row` keyed by label (incl. the guía under "No. de guía aérea").
- Produces: an optional `reconciliation?: ReconciliationReport` prop; when present, shows that guía's status + diffs.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TramiteDetailDrawer } from './TramiteDetailDrawer';

it('shows the reconciliation status for the drawer guía', () => {
  const report: any = { lines: [{ guia: 'JMX1', status: 'mismatch', diffs: [{ field: 'valorUsd', expected: 1, actual: 2, ok: false }] }] };
  render(<TramiteDetailDrawer row={{ 'No. de guía aérea': 'JMX1' }} reconciliation={report} onClose={() => {}} />);
  expect(screen.getByText(/Discrepancia/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/TramiteDetailDrawer.test.tsx`
Expected: FAIL — prop not handled / text absent.

- [ ] **Step 3: Write minimal implementation**

Add to `TramiteDetailDrawer`'s props `reconciliation?: ReconciliationReport` and, near the top of the rendered drawer, derive and show the matching line:

```tsx
const guia = row['No. de guía aérea'];
const line = reconciliation?.lines.find((l) => l.guia === guia);
{line && (
  <div data-recon={line.status}>
    Conciliación: {line.status === 'matched' ? 'Coincide' : line.status === 'mismatch' ? 'Discrepancia' : line.status}
    {line.diffs.filter((d) => !d.ok).map((d) => <div key={d.field}>{d.field}: {String(d.expected ?? '—')} → {String(d.actual ?? '—')}</div>)}
  </div>
)}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/TramiteDetailDrawer.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/TramiteDetailDrawer.tsx src/components/TramiteDetailDrawer.test.tsx
git commit -m "feat(ui): per-guía reconciliation badge in trámite drawer"
```

---

### Task 13: Full-suite green + manual end-to-end verification

**Files:** none (verification only).

- [ ] **Step 1: Type-check both projects**

Run: `npm run lint && (cd server && npx tsc --noEmit)`
Expected: both exit 0.

- [ ] **Step 2: Run all tests**

Run: `npx vitest run && (cd server && npm test)`
Expected: all green (root + server), including the new suites.

- [ ] **Step 3: Manual extraction check against the real PDF**

Run from `server/`:

```bash
node --input-type=module -e "
import { extractPedimentoPdf } from './src/services/pdfExtract/index.ts';
import { readFile } from 'node:fs/promises';
const buf = await readFile('/Users/fernandocamacholombardo/Downloads/Pedimento 2.pdf');
const r = await extractPedimentoPdf(buf);
console.log('lines:', r.lines.length, 'method:', r.extractionMethod, 'usedPositional:', r.usedPositional);
console.log('first line:', r.lines[0]);
console.log('header:', r.header);
"
```

(If `.ts` import fails under plain node, run via `npx tsx` instead.)
Expected: `lines` in the hundreds; `header.clave === 'T1'`; a sane `header.numeroPedimento` and `importerRfc`.

- [ ] **Step 4: Final commit (if any verification fixups were needed)**

```bash
git add -A && git commit -m "test: reconciliation suites green + manual extraction verified"
```

---

## Self-Review

**Spec coverage:**
- Extraction A → Tasks 1,3; B → Tasks 5,6; C gated → Task 6. ✅
- Reconciliation engine + report shape → Tasks 2,4. ✅
- Auto-run on upload (advisory) + manifest guard → Task 8. ✅
- Manual re-run → Task 9. ✅
- Data model (latest col + history table) → Task 7. ✅
- Four UI surfaces: Seguimiento + Consulta (Task 11), drawer (Task 12), XLSX (Task 10). ✅
- Testing strategy (text/JSON fixtures, stubbed route, manual real-PDF) → Tasks 1,3,4,5,8,13. ✅

**Placeholder scan:** Tasks 10 (XLSX download wiring) and 11 (view wiring) reference "the existing helper/pattern" rather than exact lines because those sibling helpers must be matched verbatim at implementation time; every new module ships complete code. The implementer must open `records.ts` and the two views to match the local pattern.

**Type consistency:** `ExtractedPedimento`, `ReconciliationReport`, `LineResult`, `FieldDiff` defined in Task 2 are used unchanged in Tasks 3–12. `reconcile`/`buildExpectedFromManifest` signatures consistent between Tasks 4 and 8. `extractPedimentoPdf(buffer)` consistent between Tasks 6 and 8. `reconstructHeader`/`TextItem` consistent between Tasks 5 and 6.
