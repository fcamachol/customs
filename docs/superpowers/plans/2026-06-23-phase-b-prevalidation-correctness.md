# Phase B — Prevalidation Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `shared/pedimento/prevalidate.ts` the single authoritative prevalidator that rejects what ANAM/SAT would reject — bad checksums, hard-RRNA goods, per-consignee >$2,500, bad catalog codes, undeclared origin — without over-rejecting legitimate courier shipments, and refuse to file a REJECTED pedimento.

**Architecture:** A pedimento is built from promoted `shipments` (`POST /api/manifests/:id/pedimento` → `buildPedimento` → `prevalidatePedimento`). This phase enriches `buildPedimento` (país split, operator-supplied origin, UMC normalization, consignee id, MXN→USD) and `prevalidatePedimento` (checksum-block, RRNA, per-consignee aggregate, catalog validation, header-totals, origin gate, currency), adds a REJECTED guard to the PDF-upload route, and retires the divergent frontend prevalidador.

**Tech Stack:** TypeScript, Express, Vitest + supertest, PostgreSQL (node-pg-migrate). No schema changes this phase.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-06-23-phase-b-prevalidation-correctness-design.md` (v2). Every task serves it.
- **Branch:** `main`. Working tree has unrelated WIP — **each task commits ONLY its listed files**, never `git add -A`.
- **Severity model:** `errors` → `REJECTED`; `warnings` never block. Hard-RRNA → error; NOM-only RRNA → warning. Per-consignee >$2,500 → error framed as **T1 ineligibility**, not fraud. Missing país de origen → error. Bad RFC/CURP checksum → error EXCEPT generic RFCs `XAXX010101000`/`XEXX010101000`.
- **No over-rejection:** RRNA matching MUST be word-boundary (not substring) and MUST drop the promiscuous tokens listed in Task 4; the hard block is gated by a corpus test.
- **País de origen is operator-supplied** at generation (`BuildOptions.partidaOrigins`, keyed by `guideId`); never fabricated.
- **Test commands:** shared → `npm test -- <path>`; server → `npm --prefix server test -- <path>`; typecheck → `npm run lint`.
- **Pure shared modules** (`shared/**`) must avoid `node:` imports (browser-bundled).

---

## File Structure

**Create:** `shared/pedimento/catalogs.ts` (+test) — `UMC_CODES`, `ADUANA_CODES`, `mapUnitToUmc`; `shared/pedimento/rrna.ts` (+test) — word-boundary hard/NOM RRNA detector.
**Modify:** `shared/parsing/taxId.ts` (`GENERIC_RFCS`); `shared/parsing/catalogs.ts` (`resolveCountry` alpha-3); `shared/types/pedimento.ts` (`consigneeId`, `sourceCurrency` on partida; `partidaOrigins` on `BuildOptions`); `shared/pedimento/buildPedimento.ts` (+test); `shared/pedimento/prevalidate.ts` (+test); `server/src/routes/pedimento.ts` (+test); `server/src/routes/pedimentoUpload.ts` (+test); `src/engine/rrnaDetector.ts` (delegate to shared); `src/context/T1Context.tsx` (remove prevalidador).
**Delete:** `src/engine/prevalidador.ts`.

---

## Task 1: Generic-RFC allowlist in taxId

**Files:** Modify `shared/parsing/taxId.ts`; Test `shared/parsing/taxId.test.ts`

**Interfaces:**
- Produces: `GENERIC_RFCS: ReadonlySet<string>` and `isGenericRfc(raw: string): boolean`.

- [ ] **Step 1: Append failing test to `shared/parsing/taxId.test.ts`**
```ts
import { isGenericRfc, GENERIC_RFCS } from './taxId';
describe('generic RFCs', () => {
  it('recognizes the two official generic RFCs', () => {
    expect(isGenericRfc('XAXX010101000')).toBe(true);
    expect(isGenericRfc('xexx010101000')).toBe(true); // case/space-insensitive
    expect(GENERIC_RFCS.has('XAXX010101000')).toBe(true);
  });
  it('rejects a normal RFC', () => expect(isGenericRfc('PERJ800101AA8')).toBe(false));
});
```
- [ ] **Step 2: Run — expect FAIL**: `npm test -- shared/parsing/taxId.test.ts`
- [ ] **Step 3: Implement (append to `shared/parsing/taxId.ts`)**
```ts
// Official SAT generic RFCs (público en general / extranjeros) — exempt from check-digit rejection.
export const GENERIC_RFCS: ReadonlySet<string> = new Set(['XAXX010101000', 'XEXX010101000']);
export function isGenericRfc(raw: string): boolean {
  return GENERIC_RFCS.has(cleanId(raw));
}
```
- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit**
```bash
git add shared/parsing/taxId.ts shared/parsing/taxId.test.ts
git commit -m "feat(taxId): official generic-RFC allowlist (checksum exemption)"
```

---

## Task 2: `resolveCountry` alpha-3 support

**Files:** Modify `shared/parsing/catalogs.ts`; Test `shared/parsing/catalogs.test.ts`

**Interfaces:**
- Produces: `resolveCountry` now also accepts ISO alpha-3 codes (e.g. `CHN`→`CN`, `MEX`→`MX`, `USA`→`US`).

- [ ] **Step 1: Append failing test**
```ts
describe('resolveCountry alpha-3', () => {
  it('maps alpha-3 to alpha-2', () => {
    expect(resolveCountry('CHN')).toBe('CN');
    expect(resolveCountry('MEX')).toBe('MX');
    expect(resolveCountry('USA')).toBe('US');
  });
  it('still maps alpha-2 and names', () => {
    expect(resolveCountry('CN')).toBe('CN');
    expect(resolveCountry('Porcelana')).toBe('CN');
  });
});
```
- [ ] **Step 2: Run — expect FAIL**: `npm test -- shared/parsing/catalogs.test.ts`
- [ ] **Step 3: Implement** — in `shared/parsing/catalogs.ts`, add an alpha-3→alpha-2 map for the existing countries and check it in `resolveCountry` before the name lookup:
```ts
// alpha-3 → alpha-2 for the countries we recognize.
const ALPHA3: Record<string, string> = {
  CHN: 'CN', MEX: 'MX', USA: 'US', CAN: 'CA', VNM: 'VN', KOR: 'KR', JPN: 'JP', DEU: 'DE', ESP: 'ES', GBR: 'GB', HKG: 'HK',
};
```
Then inside `resolveCountry`, after the alpha-2 check and before the name lookup:
```ts
  if (upper.length === 3 && ALPHA3[upper]) return ALPHA3[upper];
```
- [ ] **Step 4: Run — expect PASS** (also run full file: `npm test -- shared/parsing/catalogs.test.ts`)
- [ ] **Step 5: Commit**
```bash
git add shared/parsing/catalogs.ts shared/parsing/catalogs.test.ts
git commit -m "feat(catalogs): resolveCountry accepts ISO alpha-3"
```

---

## Task 3: Pedimento catalogs (UMC, aduana, unit mapping)

**Files:** Create `shared/pedimento/catalogs.ts`, `shared/pedimento/catalogs.test.ts`

**Interfaces:**
- Produces: `UMC_CODES: ReadonlySet<string>` (Apéndice 7, 21 codes "1".."21"); `ADUANA_CODES: ReadonlySet<string>` (SAT aduana claves, 2-digit); `mapUnitToUmc(unit: string): string` (token→code, default `'6'`).

- [ ] **Step 1: Write failing test `shared/pedimento/catalogs.test.ts`**
```ts
import { describe, expect, it } from 'vitest';
import { UMC_CODES, ADUANA_CODES, mapUnitToUmc } from './catalogs';
describe('UMC catalog', () => {
  it('has the 21 Apéndice-7 codes', () => { expect(UMC_CODES.size).toBe(21); expect(UMC_CODES.has('1')).toBe(true); expect(UMC_CODES.has('6')).toBe(true); });
});
describe('mapUnitToUmc', () => {
  it('maps common units', () => {
    expect(mapUnitToUmc('pieza')).toBe('6');
    expect(mapUnitToUmc('PZA')).toBe('6');
    expect(mapUnitToUmc('kg')).toBe('1');
    expect(mapUnitToUmc('gramo')).toBe('2');
    expect(mapUnitToUmc('litro')).toBe('8');
    expect(mapUnitToUmc('par')).toBe('9');
  });
  it('defaults blank/unknown to 6 (PIEZA)', () => { expect(mapUnitToUmc('')).toBe('6'); expect(mapUnitToUmc('xyz')).toBe('6'); });
  it('returns valid UMC codes', () => { expect(UMC_CODES.has(mapUnitToUmc('kg'))).toBe(true); });
});
describe('ADUANA catalog', () => {
  it('includes real aduanas and excludes junk', () => { expect(ADUANA_CODES.has('40')).toBe(true); expect(ADUANA_CODES.has('99')).toBe(false); });
});
```
- [ ] **Step 2: Run — expect FAIL**: `npm test -- shared/pedimento/catalogs.test.ts`
- [ ] **Step 3: Implement `shared/pedimento/catalogs.ts`**
```ts
// SAT Anexo 22 Apéndice 7 — unidades de medida (codes "1".."21").
export const UMC_CODES: ReadonlySet<string> = new Set(
  Array.from({ length: 21 }, (_, i) => String(i + 1)),
);

// SAT Apéndice 1 — aduana claves (2-digit). Seed of the ~50 active aduanas.
export const ADUANA_CODES: ReadonlySet<string> = new Set([
  '02','07','08','11','14','16','17','19','20','21','22','23','24','27','28','30','31','37','40','43',
  '44','45','46','47','48','50','51','52','53','64','65','66','67','73','75','80','81','82','83','84','85','86','87',
]);

const norm = (s: string): string => (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
const UNIT_TO_UMC: Record<string, string> = {
  kg: '1', kgs: '1', kilo: '1', kilos: '1', kilogramo: '1', kilogramos: '1',
  g: '2', gr: '2', gramo: '2', gramos: '2', gram: '2', grams: '2',
  m: '3', metro: '3', 'metro lineal': '3',
  m2: '4', 'metro cuadrado': '4', m3: '5', 'metro cubico': '5',
  pza: '6', pz: '6', pieza: '6', piezas: '6', pcs: '6', pc: '6', unidad: '6', unidades: '6', ea: '6',
  litro: '8', litros: '8', l: '8', lt: '8',
  par: '9', pares: '9', juego: '12', juegos: '12', tonelada: '14', toneladas: '14', t: '14',
  caja: '20', cajas: '20', botella: '21', botellas: '21', docena: '19', docenas: '19',
};
export function mapUnitToUmc(unit: string): string {
  return UNIT_TO_UMC[norm(unit)] ?? '6';
}
```
- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit**
```bash
git add shared/pedimento/catalogs.ts shared/pedimento/catalogs.test.ts
git commit -m "feat(pedimento): UMC/aduana catalogs + unit->UMC mapper"
```

---

## Task 4: Shared RRNA detector (word-boundary, hard vs NOM)

**Files:** Create `shared/pedimento/rrna.ts`, `shared/pedimento/rrna.test.ts`

**Interfaces:**
- Produces: `detectRrna(description: string): { hard: string[]; nom: string[] }` — `hard` = categories requiring a federal permit (block T1); `nom` = NOM-compliance categories (warn).

**Context for implementer:** the legacy lists live in `src/constants/rrnaCategories.ts` (categories like `COFEPRIS_FOOD/COSMETICS/MEDICAL`, `SENASICA_AGRICULTURAL`, `SEMARNAT_ENVIRONMENTAL`, `CITES_WILDLIFE`, plus SEDENA/SCT/NOM categories further down). Port a CURATED keyword set into shared with these rules: (a) match on **word boundaries** (`\b<kw>\b`, accent/case-insensitive), never substring; (b) **DROP these promiscuous tokens** entirely: `oil`, `te `, `gel`, `spray`, `cream`, `solution`, `serum`, `scope`, `lead`, `armor`, `pan`, `nut`, `log`, `coral`, `soy`, `bean`, `root`; (c) classify categories as **hard** (COFEPRIS_*, SENASICA_*, CITES_*, SEMARNAT hazardous, SEDENA weapons) vs **nom** (electronics/textiles/toys NOM-compliance categories).

- [ ] **Step 1: Write failing test `shared/pedimento/rrna.test.ts`**
```ts
import { describe, expect, it } from 'vitest';
import { detectRrna } from './rrna';
describe('detectRrna — hard categories block, NOM warns', () => {
  it('flags a real COFEPRIS good as hard', () => { expect(detectRrna('vitamin supplement capsules').hard.length).toBeGreaterThan(0); });
  it('flags wildlife (CITES) as hard', () => { expect(detectRrna('genuine ivory carving').hard).toContain('CITES_WILDLIFE'); });
  it('does NOT flag promiscuous false positives', () => {
    for (const d of ['aluminum foil roll', 'optical microscope', 'gel pen set', 'cream colored sweater', 'phone armor case', 'wooden picture frame']) {
      const r = detectRrna(d); expect(r.hard).toEqual([]); expect(r.nom).toEqual([]);
    }
  });
  it('returns empty for an innocuous description', () => { const r = detectRrna('cotton polo shirt'); expect(r.hard).toEqual([]); });
});
```
- [ ] **Step 2: Run — expect FAIL**: `npm test -- shared/pedimento/rrna.test.ts`
- [ ] **Step 3: Implement `shared/pedimento/rrna.ts`** — define `HARD_RRNA` and `NOM_RRNA` as `Record<string,string[]>` curated from `rrnaCategories.ts` (drop the promiscuous tokens above; keep multi-word and unambiguous single-word terms like `ivory`, `vitamin`, `supplement`, `cosmetic`, `perfume`, `seed`, `pesticide`, `mercury`, `asbestos`, `firearm`, `ammunition`). Matching helper:
```ts
const norm = (s: string): string => (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
function hits(desc: string, keywords: string[]): boolean {
  const d = norm(desc);
  return keywords.some((kw) => new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(d));
}
export function detectRrna(description: string): { hard: string[]; nom: string[] } {
  const hard = Object.entries(HARD_RRNA).filter(([, kws]) => hits(description, kws)).map(([c]) => c);
  const nom = Object.entries(NOM_RRNA).filter(([, kws]) => hits(description, kws)).map(([c]) => c);
  return { hard, nom };
}
```
(Curate `HARD_RRNA`/`NOM_RRNA` so the test's false-positive descriptions produce no matches. Iterate the keyword lists until Step 4 passes.)
- [ ] **Step 4: Run — expect PASS** (the false-positive corpus is the gate)
- [ ] **Step 5: Point the frontend detector at the shared module** — in `src/engine/rrnaDetector.ts`, keep the existing `detectRRNA(shipment)` signature/return but compute keyword categories by calling `detectRrna(shipment.description)` and mapping `hard`+`nom` into the existing `RRNACategory[]` (preserve the ZERO_VALUE/GENERIC_DESCRIPTION/DIFFICULT_IDENTIFICATION special rules as-is). Run `npm test` to confirm no frontend regressions.
- [ ] **Step 6: Commit**
```bash
git add shared/pedimento/rrna.ts shared/pedimento/rrna.test.ts src/engine/rrnaDetector.ts
git commit -m "feat(pedimento): shared word-boundary RRNA detector (hard vs NOM); frontend delegates"
```

---

## Task 5: Pedimento type additions

**Files:** Modify `shared/types/pedimento.ts`

**Interfaces:**
- Produces: `PedimentoPartida.consigneeId?: string`; `PedimentoPartida.sourceCurrency?: string`; `BuildOptions.partidaOrigins?: Record<string, string>` (in `buildPedimento.ts`, see Task 6).

- [ ] **Step 1: Add fields** — in `shared/types/pedimento.ts`, inside `PedimentoPartida` (after `description`):
```ts
  consigneeId?: string;        // curp ?? rfc — for per-consignee aggregation
  sourceCurrency?: string;     // set only when value could NOT be converted to USD
```
- [ ] **Step 2: Typecheck** — `npm run lint` → clean (additive optional fields).
- [ ] **Step 3: Commit**
```bash
git add shared/types/pedimento.ts
git commit -m "feat(types): PedimentoPartida consigneeId + sourceCurrency"
```
> No standalone test — exercised by Tasks 6–8.

---

## Task 6: `buildPedimento` — país split, origin, consigneeId, UMC, USD

**Files:** Modify `shared/pedimento/buildPedimento.ts`; Test `shared/pedimento/buildPedimento.test.ts`

**Interfaces:**
- Consumes: `mapUnitToUmc` (Task 3).
- Produces: `BuildOptions.partidaOrigins?: Record<string, string>` (keyed by shipment `guideId`). Partidas get `paisOrigenDestino` from operator origin, `paisVendedor` from platform/procedence, `consigneeId`, normalized `umc`, USD-converted value + `sourceCurrency` flag.

- [ ] **Step 1: Add/adjust tests in `shared/pedimento/buildPedimento.test.ts`** (and fix any existing fixture using `originCountry:'CHN'`, aduana `'4'/'850'` → use real values like `customsEntryCode:'40'`, `customsClearanceCode:'40'`):
```ts
it('splits país fields and applies operator origin', () => {
  const s = { /* minimal Shipment */ } as any;
  s.guideId = 'G1'; s.hsCode='99010001'; s.quantity=1; s.unit='pieza'; s.customsValueUsd=6.03; s.currency='USD';
  s.originCountry=''; s.procedenceCountry='CN'; s.platform={commercialName:'X'}; s.consignee={name:'A', curp:'AERA790828HBSRBR04', rfc:''};
  const ped = buildPedimento([s], { ...baseOpts, partidaOrigins: { G1: 'VN' } });
  expect(ped.partidas[0].paisOrigenDestino).toBe('VN');   // operator-supplied origin
  expect(ped.partidas[0].paisVendedor).toBe('CN');         // procedence fallback
  expect(ped.partidas[0].consigneeId).toBe('AERA790828HBSRBR04');
  expect(ped.partidas[0].umc).toBe('6');                   // mapUnitToUmc('pieza')
});
it('converts MXN to USD via tipoCambio', () => {
  const s = { guideId:'G2', hsCode:'99010001', quantity:1, unit:'pieza', customsValueUsd: 200, currency:'MXN', originCountry:'CN', procedenceCountry:'CN', platform:{commercialName:'X'}, consignee:{name:'A', rfc:'PERJ800101AA8'} } as any;
  const ped = buildPedimento([s], { ...baseOpts, tipoCambio: 20 });
  expect(ped.partidas[0].valorAduanaUsd).toBeCloseTo(10);  // 200 MXN / 20
  expect(ped.partidas[0].sourceCurrency).toBeUndefined();  // converted, not flagged
});
it('flags a non-convertible currency', () => {
  const s = { guideId:'G3', hsCode:'99010001', quantity:1, unit:'pieza', customsValueUsd: 5, currency:'EUR', originCountry:'CN', procedenceCountry:'CN', platform:{commercialName:'X'}, consignee:{name:'A', rfc:'PERJ800101AA8'} } as any;
  const ped = buildPedimento([s], baseOpts);
  expect(ped.partidas[0].sourceCurrency).toBe('EUR');
});
```
(Define `baseOpts` with all required `BuildOptions` fields; `tipoCambio: 20` default.)
- [ ] **Step 2: Run — expect FAIL**: `npm test -- shared/pedimento/buildPedimento.test.ts`
- [ ] **Step 3: Implement** — add `partidaOrigins?: Record<string, string>` to `BuildOptions`; import `mapUnitToUmc`; replace the partida mapping in `buildPedimento`:
```ts
  const partidas: PedimentoPartida[] = shipments.map((s, idx) => {
    const cur = (s.currency || 'USD').toUpperCase();
    let valorAduanaUsd = s.customsValueUsd;
    let sourceCurrency: string | undefined;
    if (cur === 'USD') { /* passthrough */ }
    else if (cur === 'MXN' && Number.isFinite(opts.tipoCambio) && opts.tipoCambio > 0) { valorAduanaUsd = s.customsValueUsd / opts.tipoCambio; }
    else { sourceCurrency = cur; } // non-convertible → prevalidation rejects
    return {
      secuencia: idx + 1,
      fraccion: s.hsCode.replace(/\./g, ''),
      umc: mapUnitToUmc(s.unit), cantidadUmc: s.quantity || 1,
      paisOrigenDestino: (opts.partidaOrigins?.[s.guideId] ?? s.originCountry ?? '').toUpperCase(),
      paisVendedor: (s.platform.countryOfOrigin || s.procedenceCountry || '').toUpperCase(),
      consigneeId: s.consignee.curp ?? s.consignee.rfc,
      sourceCurrency,
      description: s.description,
      valorAduanaUsd,
      precioPagado: valorAduanaUsd,
      contribuciones: [{ concepto: 'IVA', tasa: 19, importe: Math.round(valorAduanaUsd * opts.tipoCambio * 0.19 * 100) / 100 }],
      observation: partidaObservation({ guideId: s.guideId, valueUsd: valorAduanaUsd, consigneeName: s.consignee.name, id: (s.consignee.curp ?? s.consignee.rfc) }),
    };
  });
```
Update the header `valorDolares`/`valorAduana` to sum the (possibly converted) `valorAduanaUsd` — change the reduce to sum `partidas` values rather than raw `s.customsValueUsd`:
```ts
  const valorDolares = partidas.reduce((a, p) => a + p.valorAduanaUsd, 0);
```
- [ ] **Step 4: Run — expect PASS**; then `npm run lint`.
- [ ] **Step 5: Commit**
```bash
git add shared/pedimento/buildPedimento.ts shared/pedimento/buildPedimento.test.ts
git commit -m "feat(pedimento): pais split, operator origin, consigneeId, UMC, MXN->USD"
```

---

## Task 7: Prevalidator — ported structural checks + checksum block + MJ warning

**Files:** Modify `shared/pedimento/prevalidate.ts`; Test `shared/pedimento/prevalidate.test.ts`

**Interfaces:**
- Consumes: `isValidTaxIdStrict`, `isGenericRfc` (Task 1).
- Produces: `prevalidatePedimento` now rejects bad checksums (generic-exempt), empty partidas, dup secuencia, qty≤0, short description; warns on MJ-eligible.

- [ ] **Step 1: Add failing tests** (append to `shared/pedimento/prevalidate.test.ts`; build a valid `Pedimento` helper `okPed()` and mutate):
```ts
it('rejects a bad importer RFC checksum but not a generic RFC', () => {
  const p = okPed(); p.header.importer.rfc = 'PERJ800101AAA'; // shape ok, checksum bad
  expect(prevalidatePedimento(p).status).toBe('REJECTED');
  const g = okPed(); g.header.importer.rfc = 'XAXX010101000';
  expect(prevalidatePedimento(g).errors.some(e => e.includes('importador'))).toBe(false);
});
it('rejects empty partidas and duplicate secuencia', () => {
  const e = okPed(); e.partidas = []; expect(prevalidatePedimento(e).status).toBe('REJECTED');
  const d = okPed(); d.partidas = [d.partidas[0], { ...d.partidas[0], secuencia: 1 }]; // dup
  expect(prevalidatePedimento(d).errors.some(x => x.toLowerCase().includes('secuencia'))).toBe(true);
});
it('rejects qty<=0 and short description', () => {
  const q = okPed(); q.partidas[0].cantidadUmc = 0; expect(prevalidatePedimento(q).status).toBe('REJECTED');
  const s = okPed(); s.partidas[0].description = 'ab'; expect(prevalidatePedimento(s).status).toBe('REJECTED');
});
it('warns (not errors) when all partidas <= $50 (MJ eligible)', () => {
  const p = okPed(); p.partidas.forEach(x => { x.valorAduanaUsd = 10; });
  const r = prevalidatePedimento(p); expect(r.warnings.some(w => w.includes('MJ'))).toBe(true); expect(r.status).toBe('APPROVED');
});
```
(`okPed()` returns a fully valid pedimento: 15-digit numero, clave T1, valid importer/agent RFC that passes checksum, one partida with fraccion `99010001`, valorAduanaUsd 100, cantidadUmc 1, description ≥3, paisOrigenDestino `'CN'`, paisVendedor `'CN'`, umc `'6'`, consigneeId set, valid observation, header identifiers `{EM:'143'}`, valorDolares matching, totalBultos 1, etc.)
- [ ] **Step 2: Run — expect FAIL**: `npm test -- shared/pedimento/prevalidate.test.ts`
- [ ] **Step 3: Implement** — in `prevalidate.ts`: import `isValidTaxIdStrict, isGenericRfc`; replace the checksum *warnings* (lines 24-27) with **errors** unless `isGenericRfc`; add empty-partidas, secuencia-uniqueness, `cantidadUmc>0`, `description>=3`, EM-identifier, and the MJ-eligible warning. Helper:
```ts
function checksumError(label: string, id: string, errors: string[]) {
  if (isGenericRfc(id)) return;
  if (isValidTaxId(id) && !isValidTaxIdStrict(id)) errors.push(`${label}: dígito verificador no coincide.`);
}
```
Call for importer/agent; add inside the existing structure. For partidas add a `Set<number>` secuencia guard, `cantidadUmc<=0`, `description.trim().length<3`, and the partida-consignee checksum. Empty-partidas + EM identifier at header level. MJ: `if (p.partidas.every(pa => pa.valorAduanaUsd <= 50)) warnings.push('Todas las partidas ≤$50 USD; considere complemento MJ de exención.')`.
- [ ] **Step 4: Run — expect PASS**; `npm run lint`.
- [ ] **Step 5: Commit**
```bash
git add shared/pedimento/prevalidate.ts shared/pedimento/prevalidate.test.ts
git commit -m "feat(prevalidate): checksum-block (generic-exempt), structural ports, MJ warning"
```

---

## Task 8: Prevalidator — RRNA, per-consignee aggregate, catalogs, totals, origin, currency

**Files:** Modify `shared/pedimento/prevalidate.ts`; Test `shared/pedimento/prevalidate.test.ts`

**Interfaces:**
- Consumes: `detectRrna` (Task 4), `UMC_CODES`/`ADUANA_CODES` (Task 3), `resolveCountry` (Task 2).

- [ ] **Step 1: Add failing tests**
```ts
it('rejects a hard-RRNA partida, warns on NOM-only', () => {
  const p = okPed(); p.partidas[0].description = 'genuine ivory carving';
  expect(prevalidatePedimento(p).status).toBe('REJECTED');
});
it('rejects per-consignee aggregate over $2,500 (ineligibility wording)', () => {
  const p = okPed(); const base = p.partidas[0];
  p.partidas = [ {...base, secuencia:1, valorAduanaUsd:1500, consigneeId:'AAA010101AAA'}, {...base, secuencia:2, valorAduanaUsd:1200, consigneeId:'AAA010101AAA'} ];
  p.header.valorDolares = 2700; p.header.totalBultos = 2;
  const r = prevalidatePedimento(p);
  expect(r.errors.some(e => e.includes('2,500') && e.toLowerCase().includes('simplificado'))).toBe(true);
});
it('rejects unknown UMC / aduana / país', () => {
  const u = okPed(); u.partidas[0].umc = '99'; expect(prevalidatePedimento(u).status).toBe('REJECTED');
  const a = okPed(); a.header.customsEntryCode = '99'; expect(prevalidatePedimento(a).status).toBe('REJECTED');
  const c = okPed(); c.partidas[0].paisOrigenDestino = 'ZZ'; expect(prevalidatePedimento(c).status).toBe('REJECTED');
});
it('rejects blank país de origen (operator must supply)', () => {
  const p = okPed(); p.partidas[0].paisOrigenDestino = '';
  expect(prevalidatePedimento(p).errors.some(e => e.toLowerCase().includes('país de origen') || e.toLowerCase().includes('origen no declarado'))).toBe(true);
});
it('rejects a non-convertible source currency', () => {
  const p = okPed(); p.partidas[0].sourceCurrency = 'EUR';
  expect(prevalidatePedimento(p).status).toBe('REJECTED');
});
it('rejects header totals that disagree with partidas (hand-crafted)', () => {
  const p = okPed(); p.header.valorDolares = p.partidas.reduce((a,x)=>a+x.valorAduanaUsd,0) + 100;
  expect(prevalidatePedimento(p).errors.some(e => e.toLowerCase().includes('total'))).toBe(true);
});
it('approves a clean pedimento', () => { expect(prevalidatePedimento(okPed()).status).toBe('APPROVED'); });
```
- [ ] **Step 2: Run — expect FAIL**: `npm test -- shared/pedimento/prevalidate.test.ts`
- [ ] **Step 3: Implement** — add to `prevalidatePedimento`:
  - **Origin gate:** per partida, `if (!pa.paisOrigenDestino?.trim()) errors.push('Partida N: país de origen no declarado.')`.
  - **País catalog:** `if (pa.paisOrigenDestino && !resolveCountry(pa.paisOrigenDestino)) errors.push(...)`; same for `pa.paisVendedor`.
  - **UMC:** `if (!UMC_CODES.has(pa.umc)) errors.push('Partida N: unidad de medida (UMC) inválida.')`.
  - **Aduana:** `if (!ADUANA_CODES.has(p.header.customsEntryCode)) errors.push('Aduana de entrada inválida.')`; same for `customsClearanceCode`.
  - **Patente:** `if (!/^\d{4}$/.test(p.header.agent.patente.trim())) errors.push('Patente inválida.')`.
  - **Currency:** `if (pa.sourceCurrency) errors.push('Partida N: moneda ' + pa.sourceCurrency + ' no convertible; declare en USD.')`.
  - **RRNA:** `const { hard, nom } = detectRrna(pa.description); if (hard.length) errors.push('Partida N: requiere regulación no arancelaria (' + hard.join(',') + '); no elegible para T1 simplificado.'); if (nom.length) warnings.push('Partida N: posible NOM aplicable (' + nom.join(',') + ').')`.
  - **Per-consignee aggregate:** group partidas by `consigneeId` (skip empty), sum `valorAduanaUsd`; `for (const [id, total] of groups) if (total > 2500) errors.push('Consignatario ' + id + ': valor agregado $' + total.toFixed(2) + ' excede $2,500 USD — no elegible para despacho simplificado T1 (regla 3.7.5); use pedimento ordinario.')`.
  - **Header totals:** `Σ valorAduanaUsd` vs `valorDolares` (±0.01), `totalBultos == partidas.length`; mismatch → error "Totales del encabezado no coinciden con las partidas." (pesoBruto compared only if the partidas carry weight — skip if not on the Pedimento model).
- [ ] **Step 4: Run — expect PASS**; `npm run lint`; run the whole prevalidate+buildPedimento+catalogs+rrna shared suite: `npm test -- shared/pedimento/`.
- [ ] **Step 5: Commit**
```bash
git add shared/pedimento/prevalidate.ts shared/pedimento/prevalidate.test.ts
git commit -m "feat(prevalidate): RRNA block, per-consignee \$2500, catalogs, totals, origin gate, currency"
```

---

## Task 9: Pedimento route — operator origin passthrough + integration test

**Files:** Modify `server/src/routes/pedimento.ts`; Test `server/test/routes/pedimento.test.ts`

**Interfaces:**
- Consumes: `BuildOptions.partidaOrigins` (Task 6).

- [ ] **Step 1: Add failing integration tests** (extend `server/test/routes/pedimento.test.ts`): seed a promoted manifest with one shipment, then:
  - POST `/:id/pedimento` WITHOUT `partidaOrigins` → `res.body.prevalidation.status === 'REJECTED'` (origin) ;
  - POST WITH `partidaOrigins: { [guideId]: 'CN' }` and otherwise-valid body → `'APPROVED'`.
- [ ] **Step 2: Run — expect FAIL**: `npm --prefix server test -- test/routes/pedimento.test.ts`
- [ ] **Step 3: Implement** — `req.body` is already passed to `buildPedimento` as `BuildOptions` (`pedimento.ts:37`), so `partidaOrigins` flows through automatically once it's in `BuildOptions`. Confirm `validatePedimentoInput` does NOT require `partidaOrigins` (it's optional). If the test needs the route to read it, no code change beyond confirming passthrough; otherwise add `partidaOrigins` to the object passed to `buildPedimento` explicitly: `buildPedimento(..., { ...req.body })`.
- [ ] **Step 4: Run — expect PASS**; run full server suite `npm --prefix server test`.
- [ ] **Step 5: Commit**
```bash
git add server/src/routes/pedimento.ts server/test/routes/pedimento.test.ts
git commit -m "feat(pedimento route): operator partidaOrigins -> origin gate (integration)"
```

---

## Task 10: Reject-blocks-filing guard

**Files:** Modify `server/src/routes/pedimentoUpload.ts`; Test `server/test/routes/pedimentoUpload.test.ts`

- [ ] **Step 1: Add failing test** — seed a manifest with `prevalidation = {status:'REJECTED'}`, attempt `POST /:id/pedimento-pdf` with a valid PDF → expect **422**; with `{status:'APPROVED'}` → succeeds (201).
- [ ] **Step 2: Run — expect FAIL**: `npm --prefix server test -- test/routes/pedimentoUpload.test.ts`
- [ ] **Step 3: Implement** — at the top of the handler, right after the `req.file` check:
```ts
  const pre = await query<{ prevalidation: { status?: string } | null }>('SELECT prevalidation FROM manifests WHERE id=$1', [req.params.id]);
  if (pre.rows[0]?.prevalidation?.status === 'REJECTED') {
    res.status(422).json({ error: 'No se puede adjuntar el pedimento: la prevalidación está RECHAZADA.' });
    return;
  }
```
- [ ] **Step 4: Run — expect PASS**; full server suite.
- [ ] **Step 5: Commit**
```bash
git add server/src/routes/pedimentoUpload.ts server/test/routes/pedimentoUpload.test.ts
git commit -m "feat(pedimentoUpload): refuse PDF attach when prevalidation REJECTED (422)"
```

---

## Task 11: Retire the frontend prevalidador

**Files:** Delete `src/engine/prevalidador.ts`; Modify `src/context/T1Context.tsx`

- [ ] **Step 1: Confirm no routed consumer** — `grep -rn "engine/prevalidador\|PREVALIDATE_PEDIMENTO" src/` should show only `T1Context.tsx` (import + reducer case) and the file itself. If any routed view dispatches `PREVALIDATE_PEDIMENTO` or renders `state.pedimento.prevalidation`, STOP and report.
- [ ] **Step 2: Remove usage** — in `src/context/T1Context.tsx`, delete the `import { prevalidatePedimento } from '../engine/prevalidador'` (line ~21) and the `PREVALIDATE_PEDIMENTO` reducer case (~line 201-208); leave the rest of the reducer/provider intact.
- [ ] **Step 3: Delete the file** — `git rm src/engine/prevalidador.ts`.
- [ ] **Step 4: Verify** — `npm run lint` (clean) and `npm test -- src/` (frontend suite green; `ConfigurationView.test.tsx` still passes since `T1Provider` stays mounted).
- [ ] **Step 5: Commit**
```bash
git add src/context/T1Context.tsx
git commit -m "refactor: retire divergent frontend prevalidador; backend is sole authority"
```

---

## Final verification

- [ ] `npm run lint` → clean.
- [ ] `npm test` → frontend/shared green.
- [ ] `npm --prefix server test` → green.

---

## Self-Review (completed by plan author)

**Spec coverage:** §3 consolidation/MJ/empty-partidas → Tasks 7,11. §4.1 checksum → Task 7. §4.2 RRNA → Task 4 (+8 wiring). §4.3 aggregate → Task 8. §4.4 catalogs → Tasks 2,3,8. §4.5 totals → Task 8. §4.6 origin gate → Tasks 6,8,9. §4.7 currency → Tasks 6,8. §5 reject-blocks-filing → Task 10. §6 buildPedimento → Tasks 5,6. §7/§8 file list + tests → all tasks. Deferrals (§9) respected (no homoclave, no multi-FX, no padrón, no tasa-tiers).

**Placeholder scan:** none — Task 4's RRNA curation is an explicit iterate-until-corpus-passes step with the exact token denylist and classification rule, not a vague "handle edge cases."

**Type consistency:** `detectRrna→{hard,nom}` (Task 4) consumed in Task 8; `mapUnitToUmc`/`UMC_CODES`/`ADUANA_CODES` (Task 3) in Tasks 6,8; `isGenericRfc` (Task 1) in Task 7; `partidaOrigins`/`consigneeId`/`sourceCurrency` defined Tasks 5,6 and consumed Tasks 6,8,9; `resolveCountry` alpha-3 (Task 2) in Task 8.
