# T1 Risk Engine Core (Parity + Explainable Scorecard) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reproduce the client's Excel risk logic exactly (trust anchor) and add a weighted, explainable, deviation-based 0–100 scorecard that fixes the 92%-amarillo over-firing.

**Architecture:** Two pure scoring paths in `shared/risk/*`. `legacyParity.ts` reproduces `Risk analysis 17 feb '25.xlsx` formula-for-formula. The enhanced path converts the 8 boolean signals into **weighted graded points** summed to a 0–100 score with 4 bands (`verde/amarillo/rojo/gris`); the two repetition signals (`consignatarios`, `direcciones`) are reframed as **per-entity deviation** so normal repeat buyers stop firing them. Every row emits structured `ReasonCode[]` and a `sha256` ruleset hash for reproducibility.

**Tech Stack:** TypeScript (ESM), vitest, Node crypto (`sha256`), SheetJS (`xlsx`, already present). **No new dependencies.**

## Global Constraints

- Scoring core stays pure & deterministic — no I/O, no `Date.now()`/`Math.random()` in `shared/risk/*`.
- Do **not** commit the reference workbook `Risk analysis 17 feb '25.xlsx` (13 MB, contains real consignee PII). Parity is verified with synthetic fixtures + a documented local-only procedure.
- Back-compat: `ScoredShipment.color` (`verde|amarillo|rojo|gris`) and `incidences: string[]` must remain populated (derived) for existing consumers (`server/src/routes/risk.ts`, `ReportTabs`, exports).
- Reference parity rules (verbatim from the workbook formulas): ID valid iff `LEN ∈ {13,18}`; `cantidad > 10`; `monto < 1 || > 2500`; `consignatario COUNTIF ≠ 1` (≥2); `direccion COUNTIF ≠ 1` (≥2); prohibited = SEARCH of the 14 keywords in `lists.ts`; piratería = SEARCH of the 9 brands in `lists.ts`; bbdd = consignee present in monthly DB; bands `<2 Verde / 2–3 Amarillo / ≥4 Rojo`.
- Branch: create `feat/t1-risk-engine-core` off `main` before Task 1 (do not build on `feat/t1-compliance-sprint`).

---

### Task 0: Branch

- [ ] **Step 1: Create the working branch**

Run:
```bash
cd /Users/fernandocamacholombardo/customs
git checkout main && git checkout -b feat/t1-risk-engine-core
```
Expected: `Switched to a new branch 'feat/t1-risk-engine-core'`

---

### Task 1: Legacy parity scorer (reproduce the Excel)

**Files:**
- Create: `shared/risk/legacyParity.ts`
- Test: `shared/risk/legacyParity.test.ts`

**Interfaces:**
- Consumes: `Shipment` from `../types/shipment`; `PIRACY_BRANDS`, `PROHIBITED_KEYWORDS` from `./lists`.
- Produces:
  - `interface LegacyRow { resultado: 'Verde'|'Amarillo'|'Rojo'; suma: number; incidences: string[]; }`
  - `function scoreLegacyParity(shipments: Shipment[], monthlyDbNames: Set<string>): LegacyRow[]`
  - `monthlyDbNames` holds normalized consignee names present in `Base de datos mensual` (the bbdd VLOOKUP source). Normalization: `s.normalize('NFD').replace(/[̀-ͯ]/g,'').trim().toLowerCase()`.

- [ ] **Step 1: Write the failing test**

```ts
// shared/risk/legacyParity.test.ts
import { describe, expect, it } from 'vitest';
import { scoreLegacyParity } from './legacyParity';
import type { Shipment } from '../types/shipment';

function ship(over: Partial<Shipment> & { name: string; rfc?: string; curp?: string; address?: string }): Shipment {
  const { name, rfc, curp, address, ...rest } = over;
  return {
    id: 'x', mawbReference: 'M', description: 'camisa', hsCode: '6109',
    quantity: 1, unit: 'PCE', customsValueUsd: 100, currency: 'USD', originCountry: 'CN', guideId: 'g',
    consignee: { name, rfc: rfc ?? '', curp, address }, sender: { name: 'S' }, platform: { commercialName: 'P' },
    ...rest,
  } as Shipment;
}

describe('legacy parity (reproduces Risk analysis 17 feb 25.xlsx)', () => {
  it('ID fires unless length is exactly 13 or 18', () => {
    const rows = scoreLegacyParity([
      ship({ name: 'A', rfc: 'PERJ800101AA8' }),          // len 13 -> ok
      ship({ name: 'B', curp: 'AERA790828HBSRBR04' }),     // len 18 -> ok
      ship({ name: 'C', rfc: 'SHORT' }),                   // len 5 -> fires
    ], new Set());
    expect(rows[0].incidences).not.toContain('Falta RFC/CURP');
    expect(rows[1].incidences).not.toContain('Falta RFC/CURP');
    expect(rows[2].incidences).toContain('Falta RFC/CURP');
  });

  it('consignatarios fires at >=2 occurrences (COUNTIF != 1)', () => {
    const rows = scoreLegacyParity([
      ship({ name: 'Repeat', rfc: 'PERJ800101AA8', address: 'addr-a' }),
      ship({ name: 'Repeat', rfc: 'PERJ800101AA8', address: 'addr-b' }),
      ship({ name: 'Solo', rfc: 'PERJ800101AA8', address: 'addr-c' }),
    ], new Set());
    expect(rows[0].incidences).toContain('Varios paquetes por consignatario');
    expect(rows[2].incidences).not.toContain('Varios paquetes por consignatario');
  });

  it('bands: <2 Verde, 2-3 Amarillo, >=4 Rojo', () => {
    // one clean solo row -> 0 signals -> Verde
    const verde = scoreLegacyParity([ship({ name: 'Solo', rfc: 'PERJ800101AA8', address: 'u' })], new Set());
    expect(verde[0].resultado).toBe('Verde');
    // qty>10 + monto>2500 + bad id + prohibited = 4 -> Rojo
    const rojo = scoreLegacyParity([
      ship({ name: 'Solo', rfc: 'BAD', address: 'u', quantity: 11, customsValueUsd: 5000, description: 'maquillaje' }),
    ], new Set());
    expect(rojo[0].suma).toBeGreaterThanOrEqual(4);
    expect(rojo[0].resultado).toBe('Rojo');
  });

  it('bbdd fires when consignee name is present in the monthly DB', () => {
    const rows = scoreLegacyParity(
      [ship({ name: 'Known Buyer', rfc: 'PERJ800101AA8', address: 'u' })],
      new Set(['known buyer']),
    );
    expect(rows[0].incidences).toContain('Varias importaciones en el mes');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run shared/risk/legacyParity.test.ts`
Expected: FAIL — `Cannot find module './legacyParity'`.

- [ ] **Step 3: Write the implementation**

```ts
// shared/risk/legacyParity.ts
import type { Shipment } from '../types/shipment';
import { PIRACY_BRANDS, PROHIBITED_KEYWORDS } from './lists';

export interface LegacyRow {
  resultado: 'Verde' | 'Amarillo' | 'Rojo';
  suma: number;
  incidences: string[];
}

const norm = (s: string): string =>
  (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
const idLen = (id: string): number => (id ?? '').replace(/\s+/g, '').length;
const search = (desc: string, terms: string[]): boolean => {
  const d = norm(desc);
  return terms.some((t) => d.includes(norm(t)));
};

/** Faithful reproduction of the client Excel risk logic (8 equal-weight signals, <2/2-3/>=4 bands). */
export function scoreLegacyParity(shipments: Shipment[], monthlyDbNames: Set<string>): LegacyRow[] {
  const nameCount = new Map<string, number>();
  const addrCount = new Map<string, number>();
  for (const s of shipments) {
    const n = norm(s.consignee.name);
    const a = norm(s.consignee.address ?? '');
    nameCount.set(n, (nameCount.get(n) ?? 0) + 1);
    if (a) addrCount.set(a, (addrCount.get(a) ?? 0) + 1);
  }
  return shipments.map((s) => {
    const idRaw = (s.consignee.curp ?? s.consignee.rfc ?? '');
    const len = idLen(idRaw);
    const n = norm(s.consignee.name);
    const a = norm(s.consignee.address ?? '');
    const inc: string[] = [];
    let suma = 0;
    const fire = (cond: boolean, label: string) => { if (cond) { suma += 1; inc.push(label); } };

    fire(!(len === 13 || len === 18), 'Falta RFC/CURP');
    fire(s.quantity > 10, 'Demasiados productos');
    fire(s.customsValueUsd < 1 || s.customsValueUsd > 2500, 'Valor declarado incorrecto');
    fire((nameCount.get(n) ?? 0) !== 1, 'Varios paquetes por consignatario');
    fire(!!a && (addrCount.get(a) ?? 0) !== 1, 'Misma dirección de entrega');
    fire(search(s.description, PROHIBITED_KEYWORDS), 'Articulos prohibidos');
    fire(search(s.description, PIRACY_BRANDS), 'Piratería');
    fire(monthlyDbNames.has(n), 'Varias importaciones en el mes');

    const resultado = suma < 2 ? 'Verde' : suma < 4 ? 'Amarillo' : 'Rojo';
    return { resultado, suma, incidences: inc };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run shared/risk/legacyParity.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add shared/risk/legacyParity.ts shared/risk/legacyParity.test.ts
git commit -m "feat(risk): legacy parity scorer reproducing client Excel logic"
```

---

### Task 2: Document the local parity-distribution verification

**Files:**
- Create: `shared/risk/PARITY.md`

This records how to confirm full-distribution parity against the PII-bearing reference workbook **without committing it**.

- [ ] **Step 1: Write the doc**

```markdown
# Legacy parity verification (local only)

The client reference `Risk analysis 17 feb '25.xlsx` (Resumen: Amarillo 92.2% / Rojo 5.4% / Verde 2.4%
over 17,130 rows) contains real PII and is NOT committed. To confirm `scoreLegacyParity` reproduces it:

1. Place the workbook at `~/Downloads/Risk analysis 17 feb '25.xlsx`.
2. Run the throwaway script below (delete after). Map the `Manifiesto` input columns to `Shipment`
   via the same fields the parser uses, build `monthlyDbNames` from the `Base de datos mensual`
   sheet's `Destinatario (CNNE)` column (normalized), and score.
3. Assert the band split is within ±1pp of 92.2 / 5.4 / 2.4.

This is a manual gate, not CI, because the input cannot be committed.
```

- [ ] **Step 2: Commit**

```bash
git add shared/risk/PARITY.md
git commit -m "docs(risk): local parity-distribution verification procedure"
```

---

### Task 3: Extend the ruleset with weights, bands, and config floors

**Files:**
- Modify: `shared/risk/ruleset.ts`
- Test: `shared/risk/ruleset.test.ts`

**Interfaces:**
- Produces:
  - `type Weights = Record<'id'|'cantidad'|'monto'|'direcciones'|'prohibidos'|'pirateria'|'bbdd', number>`
  - `type Bands = { amarillo: number; rojo: number }` (0–100 cutoffs)
  - `RULESET.weights: Weights`, `RULESET.bands: Bands`, `RULESET.thresholds.addressDistinctConsignees: number`
  - `function resolveWeights(overrides?): Weights`
  - `function resolveBands(overrides?): Bands`
  - `function maxPoints(w: Weights): number`
- Note: `consignatarios` is intentionally **not** in `Weights` — it is subsumed into the `bbdd` (Ficha-124) recurrence signal in Task 5. `direcciones` is reframed to a smurfing signal (distinct consignees per address).

- [ ] **Step 1: Write the failing test**

```ts
// shared/risk/ruleset.test.ts
import { describe, expect, it } from 'vitest';
import { resolveWeights, resolveBands, maxPoints, RULESET } from './ruleset';

describe('ruleset weights/bands floors', () => {
  it('rejects negative / non-finite weight overrides (cannot disable a signal)', () => {
    const w = resolveWeights({ prohibidos: -5, monto: NaN, id: 10 });
    expect(w.prohibidos).toBe(RULESET.weights.prohibidos); // override rejected
    expect(w.monto).toBe(RULESET.weights.monto);           // NaN rejected
    expect(w.id).toBe(10);                                  // valid override accepted
  });

  it('rejects inverted bands (rojo must be > amarillo)', () => {
    const b = resolveBands({ amarillo: 80, rojo: 20 });
    expect(b).toEqual(RULESET.bands); // inverted -> fall back to defaults
  });

  it('maxPoints sums all signal weights', () => {
    expect(maxPoints(RULESET.weights)).toBe(
      Object.values(RULESET.weights).reduce((a, b) => a + b, 0),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run shared/risk/ruleset.test.ts`
Expected: FAIL — `resolveWeights is not a function`.

- [ ] **Step 3: Implement (append to `shared/risk/ruleset.ts`)**

Add `addressDistinctConsignees: 3` to `RULESET.thresholds`, add the `Thresholds` field, and append:

```ts
export type Weights = Record<
  'id' | 'cantidad' | 'monto' | 'direcciones' | 'prohibidos' | 'pirateria' | 'bbdd',
  number
>;
export type Bands = { amarillo: number; rojo: number };

// Starting weights; calibrated in Task 7 so the 501-row fixture lands rojo ~5-10%.
(RULESET as { weights?: Weights }).weights = {
  id: 25, cantidad: 15, monto: 20, direcciones: 20, prohibidos: 60, pirateria: 60, bbdd: 18,
};
(RULESET as { bands?: Bands }).bands = { amarillo: 15, rojo: 45 };

export function resolveWeights(overrides?: Partial<Record<keyof Weights, unknown>>): Weights {
  const base: Weights = { ...RULESET.weights };
  if (!overrides) return base;
  for (const k of Object.keys(base) as (keyof Weights)[]) {
    const v = overrides[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) base[k] = v;
  }
  return base;
}

export function resolveBands(overrides?: Partial<Record<keyof Bands, unknown>>): Bands {
  const base: Bands = { ...RULESET.bands };
  if (!overrides) return base;
  const next: Bands = { ...base };
  for (const k of ['amarillo', 'rojo'] as (keyof Bands)[]) {
    const v = overrides[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100) next[k] = v;
  }
  if (next.rojo <= next.amarillo) return base; // inverted -> reject all
  return next;
}

export function maxPoints(w: Weights): number {
  return Object.values(w).reduce((a, b) => a + b, 0);
}
```

> Note: declare `weights`, `bands` and `addressDistinctConsignees` directly in the `RULESET`/`Thresholds` literals rather than the cast-assignment shown above if cleaner; the cast form avoids touching the existing `as const`. Either is acceptable as long as the tests pass and types export.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run shared/risk/ruleset.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add shared/risk/ruleset.ts shared/risk/ruleset.test.ts
git commit -m "feat(risk): add signal weights, score bands, and config floors"
```

---

### Task 4: Ruleset hashing (reproducibility spine)

**Files:**
- Create: `shared/risk/hash.ts`
- Test: `shared/risk/hash.test.ts`

**Interfaces:**
- Produces: `function rulesetHash(resolved: object): string` — canonical (sorted-key) JSON → `sha256` hex.

- [ ] **Step 1: Write the failing test**

```ts
// shared/risk/hash.test.ts
import { describe, expect, it } from 'vitest';
import { rulesetHash } from './hash';

describe('rulesetHash', () => {
  it('is stable across key ordering', () => {
    expect(rulesetHash({ a: 1, b: 2 })).toBe(rulesetHash({ b: 2, a: 1 }));
  });
  it('changes when any value changes', () => {
    expect(rulesetHash({ a: 1 })).not.toBe(rulesetHash({ a: 2 }));
  });
  it('returns a 64-char hex sha256', () => {
    expect(rulesetHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run shared/risk/hash.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// shared/risk/hash.ts
import { createHash } from 'node:crypto';

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    return Object.keys(v as Record<string, unknown>).sort().reduce<Record<string, unknown>>((o, k) => {
      o[k] = canonical((v as Record<string, unknown>)[k]);
      return o;
    }, {});
  }
  return v;
}

/** sha256 of the canonicalized (sorted-key) ruleset — lets a stored score be reproduced/replayed. */
export function rulesetHash(resolved: object): string {
  return createHash('sha256').update(JSON.stringify(canonical(resolved))).digest('hex');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run shared/risk/hash.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add shared/risk/hash.ts shared/risk/hash.test.ts
git commit -m "feat(risk): canonical sha256 ruleset hashing for reproducible scores"
```

---

### Task 5: Graded, entity-aware signals with reason codes

**Files:**
- Modify: `shared/risk/signals.ts`
- Test: `shared/risk/signals.test.ts` (extend; keep existing cases working or update them to the graded shape)

**Interfaces:**
- Consumes: `Shipment`; `cleanId`, `validateTaxId` from `../parsing/taxId`; `matchesBrand`, `matchesProhibited` from `./lists`; `resolveThresholds`, `resolveWeights`, `Thresholds`, `Weights` from `./ruleset`.
- Produces:
  - `interface ReasonCode { signalId: SignalId; points: number; weight: number; detail: string; evidence?: Record<string, unknown>; forcesBand?: 'rojo'; }`
  - `type SignalId = 'id'|'cantidad'|'monto'|'direcciones'|'prohibidos'|'pirateria'|'bbdd';`
  - `interface EntityContext { thresholds: Thresholds; weights: Weights; addressDistinctConsignees: Record<string, number>; entityMonthlyCount: Record<string, number>; piracyBrands?: string[]; prohibitedKeywords?: string[]; }`
  - `function entityKey(c: { rfc?: string; curp?: string; name: string }): string` — normalized RFC/CURP if present else normalized name.
  - `function gradeSignals(s: Shipment, ctx: EntityContext): ReasonCode[]` — returns one ReasonCode per fired signal (points > 0).
- Keep `export const norm` and the existing `RiskContext`/`runSignals` exports (legacy path / other consumers) untouched.

Design notes (the over-firing fix):
- **No standalone `consignatarios`/raw-`direcciones`.** Repetition of one buyer is normal e-commerce. Recurrence is captured by `bbdd` (Ficha-124).
- `direcciones` reframed: fires only when **distinct entities sharing one address** ≥ `thresholds.addressDistinctConsignees` (smurfing/aggregation), graded by excess.
- `bbdd` (Ficha-124): `entityMonthlyCount` (history + current per entity) `> 3` fires, graded by excess over 3.
- `monto`: below `montoMin` → full weight; above `montoMax` → graded by `(value-montoMax)/montoMax` clamped to 1.
- `cantidad`: graded by `(qty-cantidad)/cantidad` clamped to 1.
- `id`: missing or shape/checksum invalid → full weight.
- `prohibidos`/`pirateria`: hit → full weight + `forcesBand:'rojo'`.

- [ ] **Step 1: Write the failing test**

```ts
// append to shared/risk/signals.test.ts
import { describe, expect, it } from 'vitest';
import { gradeSignals, entityKey, type EntityContext } from './signals';
import { RULESET } from './ruleset';
import type { Shipment } from '../types/shipment';

function ship(over: Partial<Shipment> & { name: string; rfc?: string; curp?: string; address?: string }): Shipment {
  const { name, rfc, curp, address, ...rest } = over;
  return {
    id: 'x', mawbReference: 'M', description: 'camisa', hsCode: '6109',
    quantity: 1, unit: 'PCE', customsValueUsd: 100, currency: 'USD', originCountry: 'CN', guideId: 'g',
    consignee: { name, rfc: rfc ?? '', curp, address }, sender: { name: 'S' }, platform: { commercialName: 'P' },
    ...rest,
  } as Shipment;
}
const ctx = (over: Partial<EntityContext> = {}): EntityContext => ({
  thresholds: RULESET.thresholds, weights: RULESET.weights,
  addressDistinctConsignees: {}, entityMonthlyCount: {}, ...over,
});

describe('gradeSignals', () => {
  it('a normal repeat buyer (same name+address, in-band) fires NOTHING', () => {
    const codes = gradeSignals(ship({ name: 'Repeat', rfc: 'PERJ800101AA8', address: 'a' }), ctx());
    expect(codes).toEqual([]);
  });

  it('prohibited hit fires full weight and forces rojo', () => {
    const codes = gradeSignals(ship({ name: 'A', rfc: 'PERJ800101AA8', description: 'pastilla' }), ctx());
    const p = codes.find((c) => c.signalId === 'prohibidos')!;
    expect(p.points).toBe(RULESET.weights.prohibidos);
    expect(p.forcesBand).toBe('rojo');
  });

  it('Ficha-124 bbdd fires only when entity monthly count > 3, graded by excess', () => {
    const k = entityKey({ rfc: 'PERJ800101AA8', name: 'A' });
    const none = gradeSignals(ship({ name: 'A', rfc: 'PERJ800101AA8' }), ctx({ entityMonthlyCount: { [k]: 3 } }));
    expect(none.find((c) => c.signalId === 'bbdd')).toBeUndefined();
    const fires = gradeSignals(ship({ name: 'A', rfc: 'PERJ800101AA8' }), ctx({ entityMonthlyCount: { [k]: 6 } }));
    expect(fires.find((c) => c.signalId === 'bbdd')!.points).toBeGreaterThan(0);
  });

  it('direcciones fires on many distinct entities at one address, not on a single repeat buyer', () => {
    const single = gradeSignals(ship({ name: 'A', rfc: 'PERJ800101AA8', address: 'shared' }),
      ctx({ addressDistinctConsignees: { shared: 1 } }));
    expect(single.find((c) => c.signalId === 'direcciones')).toBeUndefined();
    const smurf = gradeSignals(ship({ name: 'A', rfc: 'PERJ800101AA8', address: 'shared' }),
      ctx({ addressDistinctConsignees: { shared: 5 } }));
    expect(smurf.find((c) => c.signalId === 'direcciones')!.points).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run shared/risk/signals.test.ts`
Expected: FAIL — `gradeSignals is not exported`.

- [ ] **Step 3: Implement (append to `shared/risk/signals.ts`)**

```ts
import { resolveWeights, type Weights } from './ruleset';

export type SignalId = 'id' | 'cantidad' | 'monto' | 'direcciones' | 'prohibidos' | 'pirateria' | 'bbdd';

export interface ReasonCode {
  signalId: SignalId;
  points: number;
  weight: number;
  detail: string;
  evidence?: Record<string, unknown>;
  forcesBand?: 'rojo';
}

export interface EntityContext {
  thresholds: Thresholds;
  weights: Weights;
  /** distinct entity count per normalized address (smurfing indicator) */
  addressDistinctConsignees: Record<string, number>;
  /** monthly operation count per entity key (history + current) for Ficha-124 */
  entityMonthlyCount: Record<string, number>;
  piracyBrands?: string[];
  prohibitedKeywords?: string[];
}

const cleanKey = (s: string): string =>
  (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, '').toUpperCase();

/** Entity identity: RFC/CURP when present (deterministic), else normalized name. */
export function entityKey(c: { rfc?: string; curp?: string; name: string }): string {
  const id = cleanKey(c.curp ?? c.rfc ?? '');
  return id || `name:${norm(c.name)}`;
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

export function gradeSignals(s: Shipment, ctx: EntityContext): ReasonCode[] {
  const t = ctx.thresholds;
  const w = ctx.weights;
  const out: ReasonCode[] = [];
  const add = (signalId: SignalId, frac: number, detail: string, evidence?: Record<string, unknown>, forces?: 'rojo') => {
    const points = Math.round(w[signalId] * clamp01(frac));
    if (points > 0) out.push({ signalId, points, weight: w[signalId], detail, evidence, forcesBand: forces });
  };

  // id
  const idRaw = cleanId(s.consignee.curp ?? s.consignee.rfc ?? '');
  const idCheck = validateTaxId(idRaw);
  if (!idRaw || !idCheck.shapeValid || !idCheck.checksumValid) {
    add('id', 1, !idRaw ? 'Falta RFC/CURP' : 'RFC/CURP inválido', { id: idRaw });
  }
  // cantidad (graded over the threshold)
  if (s.quantity > t.cantidad) add('cantidad', (s.quantity - t.cantidad) / t.cantidad, 'Demasiados productos', { quantity: s.quantity });
  // monto
  if (s.customsValueUsd < t.montoMin) add('monto', 1, 'Valor declarado incorrecto (muy bajo)', { value: s.customsValueUsd });
  else if (s.customsValueUsd > t.montoMax) add('monto', (s.customsValueUsd - t.montoMax) / t.montoMax, 'Valor declarado incorrecto (muy alto)', { value: s.customsValueUsd });
  // direcciones: smurfing (distinct entities at one address)
  const a = norm(s.consignee.address ?? '');
  const distinct = a ? (ctx.addressDistinctConsignees[a] ?? 0) : 0;
  if (distinct >= t.addressDistinctConsignees) add('direcciones', (distinct - (t.addressDistinctConsignees - 1)) / t.addressDistinctConsignees, 'Misma dirección de entrega', { distinctConsignees: distinct });
  // prohibidos / pirateria
  const prohibited = matchesProhibited(s.description, ctx.prohibitedKeywords);
  if (prohibited) add('prohibidos', 1, `Artículos prohibidos (${prohibited})`, { matched: prohibited }, 'rojo');
  const brand = matchesBrand(s.description, ctx.piracyBrands);
  if (brand) add('pirateria', 1, `Piratería (${brand})`, { matched: brand }, 'rojo');
  // bbdd: Ficha-124 recurrence (> 3 ops/month per entity)
  const mc = ctx.entityMonthlyCount[entityKey(s.consignee)] ?? 0;
  if (mc > 3) add('bbdd', (mc - 3) / 3, 'Varias importaciones en el mes', { monthlyCount: mc });

  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run shared/risk/signals.test.ts`
Expected: PASS (existing legacy cases + 4 new `gradeSignals` cases).

- [ ] **Step 5: Commit**

```bash
git add shared/risk/signals.ts shared/risk/signals.test.ts
git commit -m "feat(risk): graded entity-aware signals with reason codes (deviation-based)"
```

---

### Task 6: Scorecard — points → 0–100 → 4 bands

**Files:**
- Create: `shared/risk/scorecard.ts`
- Test: `shared/risk/scorecard.test.ts`

**Interfaces:**
- Consumes: `ReasonCode` from `./signals`; `Bands`, `Weights`, `maxPoints` from `./ruleset`.
- Produces:
  - `type Band = 'verde' | 'amarillo' | 'rojo' | 'gris';`
  - `interface ScoreResult { score: number; band: Band; reasons: ReasonCode[]; }`
  - `function scoreRow(reasons: ReasonCode[], opts: { weights: Weights; bands: Bands; insufficientData: boolean }): ScoreResult`
  - Rules: `gris` if `insufficientData`; else `score = round(100 * Σpoints / maxPoints(weights))`; band by `bands` cutoffs; any `forcesBand:'rojo'` → `rojo`.

- [ ] **Step 1: Write the failing test**

```ts
// shared/risk/scorecard.test.ts
import { describe, expect, it } from 'vitest';
import { scoreRow } from './scorecard';
import { RULESET } from './ruleset';
import type { ReasonCode } from './signals';

const opts = (insufficientData = false) => ({ weights: RULESET.weights, bands: RULESET.bands, insufficientData });

describe('scoreRow', () => {
  it('no reasons -> score 0 -> verde', () => {
    const r = scoreRow([], opts());
    expect(r.score).toBe(0);
    expect(r.band).toBe('verde');
  });
  it('insufficient data -> gris regardless of points', () => {
    expect(scoreRow([], opts(true)).band).toBe('gris');
  });
  it('forcesBand reason -> rojo even at low score', () => {
    const codes: ReasonCode[] = [{ signalId: 'prohibidos', points: 60, weight: 60, detail: 'x', forcesBand: 'rojo' }];
    expect(scoreRow(codes, opts()).band).toBe('rojo');
  });
  it('score crosses amarillo/rojo cutoffs', () => {
    const big: ReasonCode[] = [{ signalId: 'monto', points: 100, weight: 100, detail: 'x' }];
    // points exceed maxPoints fraction -> high score -> rojo
    expect(scoreRow(big, opts()).band).toBe('rojo');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run shared/risk/scorecard.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// shared/risk/scorecard.ts
import type { ReasonCode } from './signals';
import { maxPoints, type Bands, type Weights } from './ruleset';

export type Band = 'verde' | 'amarillo' | 'rojo' | 'gris';

export interface ScoreResult {
  score: number;
  band: Band;
  reasons: ReasonCode[];
}

export function scoreRow(
  reasons: ReasonCode[],
  opts: { weights: Weights; bands: Bands; insufficientData: boolean },
): ScoreResult {
  const sorted = [...reasons].sort((a, b) => b.points - a.points);
  if (opts.insufficientData) return { score: 0, band: 'gris', reasons: sorted };
  const raw = reasons.reduce((sum, r) => sum + r.points, 0);
  const max = maxPoints(opts.weights) || 1;
  const score = Math.min(100, Math.round((100 * raw) / max));
  const forced = reasons.some((r) => r.forcesBand === 'rojo');
  let band: Band;
  if (forced || score >= opts.bands.rojo) band = 'rojo';
  else if (score >= opts.bands.amarillo) band = 'amarillo';
  else band = 'verde';
  return { score, band, reasons: sorted };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run shared/risk/scorecard.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add shared/risk/scorecard.ts shared/risk/scorecard.test.ts
git commit -m "feat(risk): 0-100 scorecard with verde/amarillo/rojo/gris bands"
```

---

### Task 7: Wire the enhanced engine into `scoreManifest` + calibrate

**Files:**
- Modify: `shared/risk/classify.ts`
- Modify: `shared/risk/distribution.test.ts` (extend with the enhanced fields)
- Test: `shared/risk/enhanced.test.ts` (golden distribution against the 501-row fixture)

**Interfaces:**
- Consumes: `gradeSignals`, `entityKey`, `EntityContext`, `ReasonCode`, `norm` from `./signals`; `scoreRow`, `Band` from `./scorecard`; `resolveThresholds`, `resolveWeights`, `resolveBands` from `./ruleset`; `rulesetHash` from `./hash`.
- Produces (extend `ScoredShipment`):
  - add `score: number; band: Band; reasons: ReasonCode[]; ruleset_hash: string;`
  - keep `color: RiskColor` (now includes `'gris'`) and `incidences: string[]` derived (`color = band`, `incidences = reasons.map(r => r.detail)`).
- `RiskColor` in `classify.ts` becomes `'verde' | 'amarillo' | 'rojo' | 'gris'`.
- Data-sufficiency for `gris`: `insufficientData = !s.description?.trim() || !Number.isFinite(s.customsValueUsd) || !(s.consignee.curp ?? s.consignee.rfc ?? '').trim()`.

- [ ] **Step 1: Write the failing golden distribution test**

```ts
// shared/risk/enhanced.test.ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as XLSX from 'xlsx';
import { validateManifest } from '../parsing/validateManifest';
import { scoreManifest } from './classify';

describe('enhanced engine on the 501-row golden manifest', () => {
  const path = resolve(__dirname, '../parsing/__fixtures__/MANIFEST_TEST.xlsx');
  const wb = XLSX.read(readFileSync(path), { type: 'buffer' });
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', blankrows: false });
  const header = (aoa[0] as unknown[]).map((h) => String(h ?? '').trim());
  const r = validateManifest(header, aoa.slice(1), 'GOLDEN');
  const ships = r.rows.filter((row) => row.status !== 'error').map((row) => row.shipment);

  it('no longer over-fires: rojo is 3-12%, verde is a meaningful majority', () => {
    const scored = scoreManifest(ships, {});
    const n = scored.length;
    const pct = (b: string) => scored.filter((s) => s.band === b).length / n;
    expect(pct('rojo')).toBeGreaterThanOrEqual(0.03);
    expect(pct('rojo')).toBeLessThanOrEqual(0.12);
    expect(pct('verde')).toBeGreaterThan(0.4); // repeat buyers are no longer all amarillo
  });

  it('every row carries reasons-array, 0-100 score, and a ruleset hash', () => {
    const scored = scoreManifest(ships, {});
    expect(scored[0].ruleset_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof scored[0].score).toBe('number');
    expect(Array.isArray(scored[0].reasons)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run shared/risk/enhanced.test.ts`
Expected: FAIL — `band`/`reasons`/`ruleset_hash` undefined (scoreManifest not yet enhanced).

- [ ] **Step 3: Rewrite `scoreManifest` in `classify.ts`**

```ts
import { gradeSignals, entityKey, norm, type ReasonCode, type EntityContext } from './signals';
import { scoreRow, type Band } from './scorecard';
import { resolveThresholds, resolveWeights, resolveBands } from './ruleset';
import { rulesetHash } from './hash';

export type RiskColor = 'verde' | 'amarillo' | 'rojo' | 'gris';

export interface ScoredShipment {
  shipment: Shipment;
  score: number;          // 0-100
  band: Band;
  color: RiskColor;       // = band (back-compat alias)
  reasons: ReasonCode[];
  incidences: string[];   // derived from reasons (back-compat)
  ruleset_version: string;
  ruleset_hash: string;
}

export function scoreManifest(
  shipments: Shipment[],
  monthlyHistoryCounts: Record<string, number>,
  options?: ScoreOptions,
): ScoredShipment[] {
  const thresholds = resolveThresholds(options?.thresholds);
  const weights = resolveWeights((options as { weights?: Record<string, unknown> })?.weights);
  const bands = resolveBands((options as { bands?: Record<string, unknown> })?.bands);

  // PASS 1: per-entity monthly count (history + current) and distinct-entities-per-address.
  const entityMonthlyCount: Record<string, number> = { ...monthlyHistoryCounts };
  const addressEntities: Record<string, Set<string>> = {};
  for (const s of shipments) {
    const k = entityKey(s.consignee);
    entityMonthlyCount[k] = (entityMonthlyCount[k] ?? 0) + 1;
    const a = norm(s.consignee.address ?? '');
    if (a) (addressEntities[a] ??= new Set()).add(k);
  }
  const addressDistinctConsignees: Record<string, number> = {};
  for (const [a, set] of Object.entries(addressEntities)) addressDistinctConsignees[a] = set.size;

  const ctx: EntityContext = {
    thresholds, weights, addressDistinctConsignees, entityMonthlyCount,
    piracyBrands: options?.piracyBrands, prohibitedKeywords: options?.prohibitedKeywords,
  };
  const resolved = { version: RULESET.version, thresholds, weights, bands,
    lists: { piracyBrands: options?.piracyBrands ?? null, prohibitedKeywords: options?.prohibitedKeywords ?? null } };
  const version = options?.thresholds || (options as object as { weights?: unknown })?.weights ? `${RULESET.version}+cfg` : RULESET.version;
  const hash = rulesetHash(resolved);

  return shipments.map((s) => {
    const reasons = gradeSignals(s, ctx);
    const insufficientData = !s.description?.trim() || !Number.isFinite(s.customsValueUsd)
      || !(s.consignee.curp ?? s.consignee.rfc ?? '').trim();
    const { score, band } = scoreRow(reasons, { weights, bands, insufficientData });
    return {
      shipment: s, score, band, color: band, reasons,
      incidences: reasons.map((r) => r.detail),
      ruleset_version: version, ruleset_hash: hash,
    };
  });
}
```

Keep the existing `classifyScore`, `rulesetVersionFor`, `ScoreOptions` exports (extend `ScoreOptions` with optional `weights?` and `bands?` override bags). Remove the old flat-count body.

- [ ] **Step 4: Update `distribution.test.ts` to the new shape**

Change its assertions from `.color`/`.score` flat-count semantics to bands: clean rows → `band === 'verde'`; the crafted dirty row (`maquillaje Gucci`, qty 11, value 5000, bad id) → `band === 'rojo'`. (The `forcesBand` on prohibidos/pirateria guarantees rojo.)

```ts
expect(out.every((s) => s.band === 'verde')).toBe(true);
// ...
expect(dirty[0].band).toBe('rojo');
```

- [ ] **Step 5: Run tests; calibrate weights/bands until the distribution test passes**

Run: `npx vitest run shared/risk/enhanced.test.ts shared/risk/distribution.test.ts`
Expected: PASS. If `rojo`/`verde` are out of range, adjust `RULESET.weights` and `RULESET.bands` (Task 3) and re-run — lower repetition-related weights / raise the `rojo` cutoff to reduce rojo; the deviation reframing (Task 5) should already push the bulk of normal repeat-buyer rows to `verde`. Record the final calibrated constants.

- [ ] **Step 6: Run the full shared suite to catch consumers of the changed types**

Run: `npm test`
Expected: PASS. Fix any compile breaks in consumers that referenced the old `ScoredShipment` (they keep working via the derived `color`/`incidences`).

- [ ] **Step 7: Commit**

```bash
git add shared/risk/classify.ts shared/risk/enhanced.test.ts shared/risk/distribution.test.ts shared/risk/ruleset.ts
git commit -m "feat(risk): wire weighted deviation-based scorecard into scoreManifest + calibrate"
```

---

### Task 8: Monotonicity & hash-stability property tests

**Files:**
- Create: `shared/risk/properties.test.ts`

**Interfaces:** Consumes `scoreManifest` from `./classify`.

- [ ] **Step 1: Write the tests**

```ts
// shared/risk/properties.test.ts
import { describe, expect, it } from 'vitest';
import { scoreManifest } from './classify';
import type { Shipment } from '../types/shipment';

const ship = (over: Partial<Shipment> & { name: string }): Shipment => ({
  id: 'x', mawbReference: 'M', description: 'camisa', hsCode: '6109', quantity: 1, unit: 'PCE',
  customsValueUsd: 100, currency: 'USD', originCountry: 'CN', guideId: 'g',
  consignee: { name: over.name, rfc: 'PERJ800101AA8', address: 'a' },
  sender: { name: 'S' }, platform: { commercialName: 'P' }, ...over,
} as Shipment);

describe('engine properties', () => {
  it('worsening one input never lowers the score', () => {
    const base = scoreManifest([ship({ name: 'A' })], {})[0].score;
    const worse = scoreManifest([ship({ name: 'A', quantity: 50 })], {})[0].score;
    expect(worse).toBeGreaterThanOrEqual(base);
  });
  it('adding a clean unrelated row does not change another row score', () => {
    const a1 = scoreManifest([ship({ name: 'A' })], {})[0].score;
    const a2 = scoreManifest([ship({ name: 'A' }), ship({ name: 'B' })], {})[0].score;
    expect(a2).toBe(a1);
  });
  it('ruleset hash is identical across runs with same config', () => {
    const h1 = scoreManifest([ship({ name: 'A' })], {})[0].ruleset_hash;
    const h2 = scoreManifest([ship({ name: 'A' })], {})[0].ruleset_hash;
    expect(h1).toBe(h2);
  });
});
```

- [ ] **Step 2: Run; expected PASS**

Run: `npx vitest run shared/risk/properties.test.ts`
Expected: PASS (3 tests). If "adding a clean row changes score" fails, it means a signal still counts cross-row repetition incorrectly — fix the signal, not the test.

- [ ] **Step 3: Commit**

```bash
git add shared/risk/properties.test.ts
git commit -m "test(risk): monotonicity and hash-stability property tests"
```

---

### Task 9: Server wiring — persist score/band/reasons + parity verdict

**Files:**
- Modify: `server/src/routes/risk.ts`
- Modify: `server/test/routes/risk.test.ts`

**Interfaces:** Consumes the enhanced `ScoredShipment`. Persists `score`, `band`/`color`, `reasons` (JSON), `ruleset_version`, `ruleset_hash` to the existing risk columns; computes the legacy parity verdict (`scoreLegacyParity`) alongside for side-by-side display.

- [ ] **Step 1: Inspect current persistence**

Run: `sed -n '1,90p' server/src/routes/risk.ts`
Identify where `scoreManifest(...)` results are written (risk_score, risk_color, risk_incidences).

- [ ] **Step 2: Update the route**

Persist the new fields. Write `band` into the existing `risk_color` column (now 4-valued), `score` into `risk_score`, `reasons` JSON into the incidence/result column (or a new `risk_reasons` JSON column — if a migration is needed, add `server/migrations/<ts>_risk_reasons.ts` adding `shipments.risk_reasons jsonb`, `shipments.risk_score int`, `shipments.ruleset_hash text`). Build `monthlyDbNames`/parity in the same handler and return both verdicts in the response.

- [ ] **Step 3: Update the route test**

Assert the response/persistence includes `band`, `score`, `reasons[]`, `ruleset_hash`, and the legacy parity verdict. Assert a known dirty shipment is `rojo` and a clean repeat-buyer set is mostly `verde`.

- [ ] **Step 4: Run server tests**

Run: `npm --prefix server test -- risk`
Expected: PASS. Run migrations first if a column was added: `npm --prefix server run migrate up`.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/risk.ts server/test/routes/risk.test.ts server/migrations/ 2>/dev/null
git commit -m "feat(server): persist enhanced score/band/reasons + legacy parity verdict"
```

---

### Task 10: Full verification

- [ ] **Step 1: Run every suite**

Run:
```bash
npm test && npm --prefix server test
```
Expected: all green (root: shared + frontend; server). No skips.

- [ ] **Step 2: End-to-end diagnostic on the real manifest**

Write a throwaway `__diag_tmp.ts` at repo root (delete after) that ingests `~/Desktop/MANIFEST TEST 2.xlsx`, scores it, and prints the band distribution + a sample row's `reasons`. Confirm rojo ≈ 3–12%, verde a clear majority, every row has reasons + hash. Then `rm __diag_tmp.ts`.

- [ ] **Step 3: Commit any cleanup; summarize**

Report the before/after band distribution (was 78% amarillo → now ...), confirm parity tests pass, and note Phases C (fuzzy entity resolution, anti-evasion confusables library, undervaluation vs peer/fair-price, $1,000/$2,500 ceilings, calibration tuning) and D (ML-ready scaffolding) remain for follow-up plans.

---

## Self-Review

- **Spec coverage:** Parity (§3) → Tasks 1–2; weighted scorecard + 4 bands + floors (§4.1, §4.6) → Tasks 3,6; hashing/reason codes (§4.6) → Tasks 4,5,7; deviation-based per-entity (§4.2) → Tasks 5,7; gris (§4.4) → Tasks 6,7; upgraded "manifest test" (§6) → Tasks 7,8; server surfacing (§5) → Task 9. **Deferred (own plans):** fuzzy entity resolution + anti-evasion library + undervaluation + value-ceiling signals (§4.3, §4.5 library form, Phase C) and ML scaffolding (Phase D) — noted in Task 10.
- **Placeholder scan:** none — every code/test step has concrete content.
- **Type consistency:** `ReasonCode`, `EntityContext`, `entityKey`, `gradeSignals` (Task 5) ↔ `scoreRow`/`Band` (Task 6) ↔ `ScoredShipment` (Task 7); `Weights`/`Bands`/`maxPoints`/`resolveWeights`/`resolveBands` (Task 3) used consistently downstream; `RiskColor` widened to include `gris` once (Task 7).
