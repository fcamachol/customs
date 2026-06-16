# Risk-Triage Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the platform's core: an 8-signal risk scorer that classifies every shipment Verde/Amarillo/Rojo with human-readable incidence reasons, including the four signals the current system lacks (piracy, repeat-importer, duplicate-address, >10-quantity), and the monthly-history store that powers repeat-importer detection.

**Architecture:** Pure, side-effect-free signal functions in `shared/risk/` (each takes a shipment + manifest context and returns a flag + incidence text). A `classify()` function sums flags → score → color using the spreadsheet's bands (`<2 Verde`, `2–3 Amarillo`, `≥4 Rojo`). The server exposes `POST /api/manifests/:id/risk` which loads shipments, runs the engine with monthly-history context, persists `risk_score`/`risk_color`, and returns the traffic-light table + summary buckets.

**Tech Stack:** TypeScript, `vitest`, `pg`. No new runtime deps.

**Depends on:** Plan 01 (auth/audit/db), Plan 02 (`Shipment` model, `manifests`/`shipments` tables).

---

### Task 1: Brand + prohibited-keyword constants

**Files:**
- Create: `shared/risk/lists.ts`
- Test: `shared/risk/lists.test.ts`

- [ ] **Step 1: Write the failing test**

`shared/risk/lists.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { matchesBrand, matchesProhibited } from './lists';

describe('lists', () => {
  it('detects piracy brands case-insensitively', () => {
    expect(matchesBrand('Tenis NIKE air')).toBe('Nike');
    expect(matchesBrand('bolsa louis vuitton')).toBe('Louis Vuitton');
    expect(matchesBrand('camisa lisa')).toBeNull();
  });
  it('detects prohibited keywords', () => {
    expect(matchesProhibited('caja de maquillaje')).toBe('maquillaje');
    expect(matchesProhibited('autoparte de motor')).toBe('autoparte');
    expect(matchesProhibited('libro')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd shared && npx vitest run risk/lists.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`shared/risk/lists.ts`:
```ts
// From Risk analysis 17 feb '25.xlsx — piracy brands (col BL) + prohibited keywords (col BA).
export const PIRACY_BRANDS = [
  'Adidas', 'Nike', 'Bimba y Lola', 'Gucci', 'Samsung',
  'Apple', 'Louis Vuitton', 'Dolce and Gabbana', 'Ray Ban',
];

export const PROHIBITED_KEYWORDS = [
  'maquillaje', 'liquido', 'pastilla', 'capsula', 'cápsula', 'globo',
  'pegamento', 'autoparte', 'pistola', 'droga', 'mariguana',
  'suplemento', 'vitamina', 'medicamento',
];

function norm(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export function matchesBrand(description: string): string | null {
  const d = norm(description);
  return PIRACY_BRANDS.find((b) => d.includes(norm(b))) ?? null;
}

export function matchesProhibited(description: string): string | null {
  const d = norm(description);
  return PROHIBITED_KEYWORDS.find((k) => d.includes(norm(k))) ?? null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd shared && npx vitest run risk/lists.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add shared/risk/lists.ts shared/risk/lists.test.ts
git commit -m "feat(risk): piracy brand + prohibited keyword lists"
```

---

### Task 2: The eight signal functions

**Files:**
- Create: `shared/risk/signals.ts`
- Test: `shared/risk/signals.test.ts`

- [ ] **Step 1: Write the failing test**

`shared/risk/signals.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { runSignals, type RiskContext } from './signals';
import type { Shipment } from '../types/shipment';

function ship(over: Partial<Shipment> = {}): Shipment {
  return {
    id: 'a', mawbReference: 'M', description: 'camisa', hsCode: '9901000100',
    quantity: 1, unit: 'PCE', customsValueUsd: 100, currency: 'USD',
    originCountry: 'CN', guideId: 'g1',
    consignee: { name: 'Juan Perez', rfc: 'PERJ800101AAA', address: 'Calle 1' },
    sender: { name: 'S' }, platform: { commercialName: 'P' },
    ...over,
  } as Shipment;
}

const emptyCtx: RiskContext = { nameCounts: {}, addressCounts: {}, monthlyHistoryNames: new Set() };

describe('runSignals', () => {
  it('flags missing/invalid ID length (not 13 or 18)', () => {
    const r = runSignals(ship({ consignee: { name: 'x', rfc: 'SHORT' } }), emptyCtx);
    expect(r.find((f) => f.id === 'id')?.flagged).toBe(true);
  });
  it('accepts an 18-char CURP', () => {
    const r = runSignals(ship({ consignee: { name: 'x', rfc: 'AERA790828HBSRBR04' } }), emptyCtx);
    expect(r.find((f) => f.id === 'id')?.flagged).toBe(false);
  });
  it('flags quantity > 10', () => {
    expect(runSignals(ship({ quantity: 11 }), emptyCtx).find((f) => f.id === 'cantidad')?.flagged).toBe(true);
  });
  it('flags value < $1 and > $2500', () => {
    expect(runSignals(ship({ customsValueUsd: 0.5 }), emptyCtx).find((f) => f.id === 'monto')?.flagged).toBe(true);
    expect(runSignals(ship({ customsValueUsd: 3000 }), emptyCtx).find((f) => f.id === 'monto')?.flagged).toBe(true);
    expect(runSignals(ship({ customsValueUsd: 100 }), emptyCtx).find((f) => f.id === 'monto')?.flagged).toBe(false);
  });
  it('flags duplicate consignee name and duplicate address from context', () => {
    const ctx: RiskContext = { nameCounts: { 'juan perez': 3 }, addressCounts: { 'calle 1': 2 }, monthlyHistoryNames: new Set() };
    const r = runSignals(ship(), ctx);
    expect(r.find((f) => f.id === 'consignatarios')?.flagged).toBe(true);
    expect(r.find((f) => f.id === 'direcciones')?.flagged).toBe(true);
  });
  it('flags prohibited goods and piracy', () => {
    const r = runSignals(ship({ description: 'maquillaje marca Gucci' }), emptyCtx);
    expect(r.find((f) => f.id === 'prohibidos')?.flagged).toBe(true);
    expect(r.find((f) => f.id === 'pirateria')?.flagged).toBe(true);
  });
  it('flags repeat importer found in monthly history', () => {
    const ctx: RiskContext = { nameCounts: {}, addressCounts: {}, monthlyHistoryNames: new Set(['juan perez']) };
    expect(runSignals(ship(), ctx).find((f) => f.id === 'bbdd')?.flagged).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd shared && npx vitest run risk/signals.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`shared/risk/signals.ts`:
```ts
import type { Shipment } from '../types/shipment';
import { matchesBrand, matchesProhibited } from './lists';

export interface RiskContext {
  nameCounts: Record<string, number>;       // normalized consignee name → count in this manifest
  addressCounts: Record<string, number>;    // normalized address → count in this manifest
  monthlyHistoryNames: Set<string>;          // normalized names seen in the monthly history store
}

export interface SignalResult {
  id: 'id' | 'cantidad' | 'monto' | 'consignatarios' | 'direcciones' | 'prohibidos' | 'pirateria' | 'bbdd';
  flagged: boolean;
  incidence?: string;
}

export const norm = (s: string): string =>
  (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

export function runSignals(s: Shipment, ctx: RiskContext): SignalResult[] {
  const id = (s.consignee.curp ?? s.consignee.rfc ?? '').replace(/\s/g, '');
  const name = norm(s.consignee.name);
  const addr = norm(s.consignee.address ?? '');
  const brand = matchesBrand(s.description);
  const prohibited = matchesProhibited(s.description);

  return [
    { id: 'id', flagged: !(id.length === 13 || id.length === 18), incidence: 'Falta RFC/CURP' },
    { id: 'cantidad', flagged: s.quantity > 10, incidence: 'Demasiados productos' },
    { id: 'monto', flagged: s.customsValueUsd < 1 || s.customsValueUsd > 2500, incidence: 'Valor declarado incorrecto' },
    { id: 'consignatarios', flagged: (ctx.nameCounts[name] ?? 0) > 1, incidence: 'Varios paquetes por consignatario' },
    { id: 'direcciones', flagged: !!addr && (ctx.addressCounts[addr] ?? 0) > 1, incidence: 'Misma dirección de entrega' },
    { id: 'prohibidos', flagged: !!prohibited, incidence: prohibited ? `Artículos prohibidos (${prohibited})` : undefined },
    { id: 'pirateria', flagged: !!brand, incidence: brand ? `Piratería (${brand})` : undefined },
    { id: 'bbdd', flagged: ctx.monthlyHistoryNames.has(name), incidence: 'Varias importaciones en el mes' },
  ].map((r) => ({ ...r, incidence: r.flagged ? r.incidence : undefined }));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd shared && npx vitest run risk/signals.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add shared/risk/signals.ts shared/risk/signals.test.ts
git commit -m "feat(risk): eight risk signal functions"
```

---

### Task 3: Classification + manifest scoring (context builder)

**Files:**
- Create: `shared/risk/classify.ts`
- Test: `shared/risk/classify.test.ts`

- [ ] **Step 1: Write the failing test**

`shared/risk/classify.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { classifyScore, scoreManifest } from './classify';
import type { Shipment } from '../types/shipment';

describe('classifyScore', () => {
  it('uses spreadsheet bands: <2 verde, 2-3 amarillo, >=4 rojo', () => {
    expect(classifyScore(0)).toBe('verde');
    expect(classifyScore(1)).toBe('verde');
    expect(classifyScore(2)).toBe('amarillo');
    expect(classifyScore(3)).toBe('amarillo');
    expect(classifyScore(4)).toBe('rojo');
    expect(classifyScore(8)).toBe('rojo');
  });
});

function ship(over: Partial<Shipment>): Shipment {
  return {
    id: Math.random().toString(), mawbReference: 'M', description: 'camisa',
    hsCode: '9901000100', quantity: 1, unit: 'PCE', customsValueUsd: 100, currency: 'USD',
    originCountry: 'CN', guideId: 'g',
    consignee: { name: 'Ana', rfc: 'PERJ800101AAA', address: 'Calle 1' },
    sender: { name: 'S' }, platform: { commercialName: 'P' }, ...over,
  } as Shipment;
}

describe('scoreManifest', () => {
  it('builds context across shipments and scores each', () => {
    const ships = [
      ship({ consignee: { name: 'Ana', rfc: 'PERJ800101AAA', address: 'Calle 1' } }),
      ship({ consignee: { name: 'Ana', rfc: 'PERJ800101AAA', address: 'Calle 1' } }),
    ];
    const out = scoreManifest(ships, new Set());
    // 'Ana' appears twice and address twice → both dup signals fire → score 2 → amarillo
    expect(out[0].color).toBe('amarillo');
    expect(out[0].incidences).toContain('Varios paquetes por consignatario');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd shared && npx vitest run risk/classify.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`shared/risk/classify.ts`:
```ts
import type { Shipment } from '../types/shipment';
import { norm, runSignals, type RiskContext } from './signals';

export type RiskColor = 'verde' | 'amarillo' | 'rojo';

export function classifyScore(score: number): RiskColor {
  if (score < 2) return 'verde';
  if (score <= 3) return 'amarillo';
  return 'rojo';
}

export interface ScoredShipment {
  shipment: Shipment;
  score: number;
  color: RiskColor;
  incidences: string[];
}

export function scoreManifest(shipments: Shipment[], monthlyHistoryNames: Set<string>): ScoredShipment[] {
  const nameCounts: Record<string, number> = {};
  const addressCounts: Record<string, number> = {};
  for (const s of shipments) {
    const n = norm(s.consignee.name);
    const a = norm(s.consignee.address ?? '');
    if (n) nameCounts[n] = (nameCounts[n] ?? 0) + 1;
    if (a) addressCounts[a] = (addressCounts[a] ?? 0) + 1;
  }
  const ctx: RiskContext = { nameCounts, addressCounts, monthlyHistoryNames };
  return shipments.map((s) => {
    const signals = runSignals(s, ctx);
    const fired = signals.filter((f) => f.flagged);
    const score = fired.length;
    return { shipment: s, score, color: classifyScore(score), incidences: fired.map((f) => f.incidence!).filter(Boolean) };
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd shared && npx vitest run risk/classify.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add shared/risk/classify.ts shared/risk/classify.test.ts
git commit -m "feat(risk): score bands + manifest-context scoring"
```

---

### Task 4: Monthly-history store migration + service

**Files:**
- Create: `server/migrations/1700000200000_monthly_history.ts`
- Create: `server/src/services/monthlyHistory.ts`
- Test: `server/test/services/monthlyHistory.test.ts`

- [ ] **Step 1: Write the migration**

`server/migrations/1700000200000_monthly_history.ts`:
```ts
import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('monthly_history', {
    id: { type: 'bigserial', primaryKey: true },
    consignee_name_norm: { type: 'text', notNull: true },
    period: { type: 'text', notNull: true },     // 'YYYY-MM'
    seen_count: { type: 'integer', notNull: true, default: 1 },
  });
  pgm.addConstraint('monthly_history', 'monthly_history_uniq', {
    unique: ['consignee_name_norm', 'period'],
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('monthly_history');
}
```

- [ ] **Step 2: Apply migrations**

Run: `cd server && npm run migrate up && DATABASE_URL=$TEST_DATABASE_URL npm run migrate up`
Expected: table created on both. Then add `monthly_history` to `truncateAll` in `server/test/helpers/db.ts`.

- [ ] **Step 3: Write the failing test**

`server/test/services/monthlyHistory.test.ts`:
```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { recordNames, loadHistoryNames } from '../../src/services/monthlyHistory';
import { truncateAll } from '../helpers/db';

describe('monthlyHistory', () => {
  beforeEach(truncateAll);

  it('records names and loads prior-period names as a set', async () => {
    await recordNames(['Ana Lopez', 'Beto Ruiz'], '2025-01');
    await recordNames(['Ana Lopez'], '2025-02');
    const jan = await loadHistoryNames('2025-01');
    expect(jan.has('ana lopez')).toBe(true);
    expect(jan.has('beto ruiz')).toBe(true);
  });
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `cd server && npx vitest run test/services/monthlyHistory.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 5: Implement**

`server/src/services/monthlyHistory.ts`:
```ts
import { query } from '../db/pool';
import { norm } from '../../../shared/risk/signals';

export async function recordNames(names: string[], period: string): Promise<void> {
  for (const raw of names) {
    const n = norm(raw);
    if (!n) continue;
    await query(
      `INSERT INTO monthly_history (consignee_name_norm, period, seen_count)
       VALUES ($1,$2,1)
       ON CONFLICT (consignee_name_norm, period)
       DO UPDATE SET seen_count = monthly_history.seen_count + 1`,
      [n, period],
    );
  }
}

export async function loadHistoryNames(period: string): Promise<Set<string>> {
  const { rows } = await query<{ consignee_name_norm: string }>(
    `SELECT consignee_name_norm FROM monthly_history WHERE period=$1`, [period]);
  return new Set(rows.map((r) => r.consignee_name_norm));
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `cd server && npx vitest run test/services/monthlyHistory.test.ts`
Expected: PASS (1 test).

- [ ] **Step 7: Commit**

```bash
git add server/migrations/1700000200000_monthly_history.ts server/src/services/monthlyHistory.ts server/test/services/monthlyHistory.test.ts server/test/helpers/db.ts
git commit -m "feat(server): monthly-history store for repeat-importer detection"
```

---

### Task 5: Risk endpoint (score + persist + summary buckets)

**Files:**
- Create: `server/src/routes/risk.ts`
- Modify: `server/src/app.ts`
- Test: `server/test/routes/risk.test.ts`

- [ ] **Step 1: Write the failing test**

`server/test/routes/risk.test.ts`:
```ts
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { hashPassword } from '../../src/auth/password';
import { signToken } from '../../src/auth/token';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

const app = createApp();
let token: string; let manifestId: string;

async function addShipment(name: string, value: number) {
  const s = {
    id: crypto.randomUUID(), mawbReference: '369-1', description: 'camisa', hsCode: '9901000100',
    quantity: 1, unit: 'PCE', customsValueUsd: value, currency: 'USD', originCountry: 'CN', guideId: 'g',
    consignee: { name, rfc: 'PERJ800101AAA', address: 'Calle 1' }, sender: { name: 'S' }, platform: { commercialName: 'P' },
  };
  await query('INSERT INTO shipments (id, manifest_id, data) VALUES ($1,$2,$3)', [s.id, manifestId, JSON.stringify(s)]);
}

beforeEach(async () => {
  await truncateAll();
  const hash = await hashPassword('p');
  const u = await query(`INSERT INTO users (username,password_hash,role) VALUES ('c',$1,'capturista') RETURNING id`, [hash]);
  token = signToken({ userId: u.rows[0].id, role: 'capturista' });
  const m = await query(`INSERT INTO manifests (mawb_reference) VALUES ('369-1') RETURNING id`);
  manifestId = m.rows[0].id;
});

describe('POST /api/manifests/:id/risk', () => {
  it('scores shipments, persists color, returns table + summary', async () => {
    await addShipment('Ana', 100);     // clean → verde
    await addShipment('Bad', 5000);    // monto fail (1) → verde still (<2). add nothing else
    const res = await request(app)
      .post(`/api/manifests/${manifestId}/risk`)
      .set('Authorization', `Bearer ${token}`)
      .send({ period: '2025-02' });
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(2);
    expect(res.body.summary.analizados).toBe(2);
    const persisted = await query('SELECT risk_color FROM shipments WHERE risk_color IS NOT NULL');
    expect(persisted.rows.length).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx vitest run test/routes/risk.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`server/src/routes/risk.ts`:
```ts
import { Router } from 'express';
import { query } from '../db/pool';
import { requireAuth } from '../auth/middleware';
import { recordAudit } from '../services/audit';
import { scoreManifest } from '../../../shared/risk/classify';
import { loadHistoryNames, recordNames } from '../services/monthlyHistory';
import type { Shipment } from '../../../shared/types/shipment';

export const riskRouter = Router();

riskRouter.post('/:id/risk', requireAuth, async (req, res) => {
  const period: string = req.body?.period ?? new Date().toISOString().slice(0, 7);
  const { rows } = await query<{ id: string; data: Shipment }>(
    'SELECT id, data FROM shipments WHERE manifest_id=$1', [req.params.id]);
  const shipments = rows.map((r) => r.data);

  const history = await loadHistoryNames(period);
  const scored = scoreManifest(shipments, history);

  for (const sc of scored) {
    await query('UPDATE shipments SET risk_score=$1, risk_color=$2 WHERE id=$3',
      [sc.score, sc.color, sc.shipment.id]);
  }
  // feed this manifest's consignees into history for future runs
  await recordNames(shipments.map((s) => s.consignee.name), period);

  const summary = {
    analizados: scored.length,
    aprobados: scored.filter((s) => s.color === 'verde').length,
    validarEnPrevio: scored.filter((s) => s.color === 'amarillo').length,
    rojos: scored.filter((s) => s.color === 'rojo').length,
  };
  await recordAudit({ userId: req.user!.userId, action: 'RUN_RISK', entity: 'manifest', entityId: req.params.id, after: summary });

  res.json({
    rows: scored.map((s) => ({
      mwb: s.shipment.mawbReference,
      guide: s.shipment.guideId,
      consignee: s.shipment.consignee.name,
      senderCity: s.shipment.sender.address ?? '',
      senderCountry: s.shipment.platform.countryOfOrigin ?? s.shipment.originCountry,
      resultado: s.color,
      motivo: s.incidences.join('; '),
    })),
    summary,
  });
});
```

- [ ] **Step 4: Mount in `app.ts`**

```ts
import { riskRouter } from './routes/risk';
app.use('/api/manifests', riskRouter);
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd server && npx vitest run test/routes/risk.test.ts`
Expected: PASS (1 test).

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/risk.ts server/src/app.ts server/test/routes/risk.test.ts
git commit -m "feat(server): risk endpoint — score, persist, summary buckets"
```

---

### Task 6: Distribution sanity test against the spreadsheet's expected shape

**Files:**
- Test: `shared/risk/distribution.test.ts`

- [ ] **Step 1: Write the test** (synthetic manifest weighted toward Amarillo, mirroring the sheet's ~92% Amarillo / ~5% Rojo / ~2% Verde)

`shared/risk/distribution.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { scoreManifest } from './classify';
import type { Shipment } from '../types/shipment';

function ship(i: number, over: Partial<Shipment>): Shipment {
  return {
    id: String(i), mawbReference: 'M', description: 'camisa', hsCode: '9901000100',
    quantity: 1, unit: 'PCE', customsValueUsd: 100, currency: 'USD', originCountry: 'CN', guideId: 'g',
    consignee: { name: `P${i}`, rfc: 'PERJ800101AAA', address: `Calle ${i}` },
    sender: { name: 'S' }, platform: { commercialName: 'P' }, ...over,
  } as Shipment;
}

describe('distribution', () => {
  it('clean shipments are verde; multi-flag shipments are rojo', () => {
    const clean = Array.from({ length: 10 }, (_, i) => ship(i, {}));
    const out = scoreManifest(clean, new Set());
    expect(out.every((s) => s.color === 'verde')).toBe(true);

    const dirty = scoreManifest(
      [ship(99, { quantity: 11, customsValueUsd: 5000, description: 'maquillaje Gucci', consignee: { name: 'x', rfc: 'BAD' } })],
      new Set(['x']),
    );
    // id + cantidad + monto + prohibidos + pirateria + bbdd = 6 → rojo
    expect(dirty[0].color).toBe('rojo');
    expect(dirty[0].score).toBeGreaterThanOrEqual(4);
  });
});
```

- [ ] **Step 2: Run to verify it passes**

Run: `cd shared && npx vitest run risk/distribution.test.ts`
Expected: PASS (1 test).

- [ ] **Step 3: Commit**

```bash
git add shared/risk/distribution.test.ts
git commit -m "test(risk): classification distribution sanity check"
```

---

## Self-Review Notes (coverage of spec §3.3)
- 8 signals incl. the 4 previously-missing (piracy → Task 1/2, repeat-importer → Task 2/4, duplicate-address → Task 2/3, >10-qty → Task 2) — done.
- Bands `<2/2–3/≥4` → Task 3. Incidence strings per signal → Task 2/3. Summary buckets (analizados/aprobados/validar-en-previo/rojos) → Task 5.
- Threshold reconciliations: CURP length 13/18 (Task 2 `id` signal), value `<$1` (Task 2 `monto` signal) — both explicit.
- Repeat-importer requires the monthly-history store (Task 4), satisfying the spec's persistence requirement.
- Reused types: `Shipment` (plan 02), `norm`/`RiskContext`/`SignalResult` defined here and reused by plan 05 (Reporte/Consulta render the same `RiskColor`/incidences).
