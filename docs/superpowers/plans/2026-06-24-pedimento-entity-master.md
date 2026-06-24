# Pedimento Entity Master (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the stable pedimento entities — the importer-of-record and the customs agent —
configurable **once** (super_admin-editable config keys), with a reader helper for body assembly and
a pure cross-check helper that flags when the PDF-extracted RFCs/patente disagree with the configured
entities.

**Architecture:** Poka-Yoke — stable per-operation data lives in one authoritative place (the `config`
table), never re-keyed per pedimento. Two new config keys (`importer_of_record`, `customs_agent`)
reuse the existing `/api/catalogs/config/:key` mechanism, gain per-key Zod shape validation, and are
super_admin-editable (like `tasa_vigencias`/`denied_parties`). A service reads + validates them; a
pure shared helper cross-checks them against the extracted header (consumed by Phase 3 reconciliation).
A `ConfigurationView` section lets a super_admin edit them.

**Tech Stack:** TypeScript, Express, Zod, Postgres, Vitest (root for `shared/`, server for routes),
React + Vitest + Tailwind.

Spec: `docs/superpowers/specs/2026-06-24-pedimento-extraction-reconciliation-wizard-design.md`

## Global Constraints

- Both suites green at **every** commit: root `npx vitest run` AND `cd server && npm test`.
  `npm run lint` (root) + `cd server && npx tsc --noEmit` clean.
- `git add <explicit paths>` ONLY — never `git add -A`.
- The config allow-list lives in **two** places that must stay in sync: the Zod enum
  `ALLOWED_CONFIG_KEYS` in `server/src/validation/schemas.ts` (gates the route param) **and** the
  `Set` `ALLOWED_CONFIG_KEYS` in `server/src/routes/catalogs.ts`. A new key must be added to BOTH.
- `importer_of_record` shape = `importerSchema` = `{ rfc, name, fiscalAddress }` (all `string().min(1)`,
  `.passthrough()`). `customs_agent` shape = `agentSchema` = `{ patente, name, agentRfc, agencyRfc }`
  (all `string().min(1)`, `.passthrough()`). Both already defined (module-private) in `schemas.ts`.
- Both keys are super_admin-editable (added to `SUPER_ADMIN_CONFIG_KEYS`); the PUT already 403s a
  non-super_admin for keys in that set.
- Test DB = `customs_test` (mock; reset freely). RFC comparisons are case-insensitive.

---

### Task 1: Register the two config keys + per-key shape validation + super_admin gate

**Files:**
- Modify: `server/src/validation/schemas.ts` (the `ALLOWED_CONFIG_KEYS` enum; export `importerSchema` + `agentSchema`)
- Modify: `server/src/routes/catalogs.ts` (the `ALLOWED_CONFIG_KEYS` Set, `SUPER_ADMIN_CONFIG_KEYS` Set, the PUT handler)
- Test: `server/test/routes/catalogs.test.ts` (extend; create if absent)

**Interfaces:**
- Produces: `GET/PUT /api/catalogs/config/importer_of_record` and `.../customs_agent` accept/return the
  validated shapes; PUT 400s on bad shape, 403s for non-super_admin. Exports `importerSchema`,
  `agentSchema` from `schemas.ts`.

- [ ] **Step 1: Write the failing test**

In `server/test/routes/catalogs.test.ts` (follow the existing config-test pattern — sign a token, PUT,
assert). If the file does not exist, create it mirroring another route test's setup (`truncateAll`,
`hashPassword`, `signToken`). Add:

```ts
it('super_admin can PUT a valid importer_of_record; non-super_admin is 403; bad shape is 400', async () => {
  const importer = { rfc: 'ADM130509UQ0', name: 'ADMERCE SA DE CV', fiscalAddress: 'PONIENTE 150, CDMX' };
  // non-super_admin (admin) → 403
  const adminRes = await request(app).put('/api/catalogs/config/importer_of_record')
    .set('Authorization', `Bearer ${adminToken}`).send({ value: importer });
  expect(adminRes.status).toBe(403);
  // super_admin valid → 200 and round-trips via GET
  const ok = await request(app).put('/api/catalogs/config/importer_of_record')
    .set('Authorization', `Bearer ${superAdminToken}`).send({ value: importer });
  expect(ok.status).toBe(200);
  const get = await request(app).get('/api/catalogs/config/importer_of_record')
    .set('Authorization', `Bearer ${superAdminToken}`);
  expect(get.body.value).toMatchObject(importer);
  // super_admin bad shape (missing fiscalAddress) → 400
  const bad = await request(app).put('/api/catalogs/config/importer_of_record')
    .set('Authorization', `Bearer ${superAdminToken}`).send({ value: { rfc: 'X', name: 'Y' } });
  expect(bad.status).toBe(400);
});

it('customs_agent validates the four-field shape', async () => {
  const agent = { patente: '1653', name: 'MIGUEL ANDRES GUZMAN MORENO', agentRfc: 'GUMM710831UYA', agencyRfc: 'GLG1502247K9' };
  const ok = await request(app).put('/api/catalogs/config/customs_agent')
    .set('Authorization', `Bearer ${superAdminToken}`).send({ value: agent });
  expect(ok.status).toBe(200);
  const bad = await request(app).put('/api/catalogs/config/customs_agent')
    .set('Authorization', `Bearer ${superAdminToken}`).send({ value: { patente: '1653' } });
  expect(bad.status).toBe(400);
});
```

(Implementer: set up `superAdminToken` = `signToken({ userId, role: 'super_admin', tv: 0 })` and
`adminToken` = role `'admin'`, mirroring the token setup in `catalogs.test.ts` / another route test.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npm test -- test/routes/catalogs.test.ts`
Expected: FAIL — `configKeyParam` rejects the unknown key (400/validation) so the valid PUT never 200s.

- [ ] **Step 3: Add the keys to both allow-lists + export the schemas**

In `server/src/validation/schemas.ts`: add the two keys to the enum, and `export` the two schemas:

```ts
const ALLOWED_CONFIG_KEYS = ['prohibited', 'piracy_brands', 'branding', 'validation_params', 'denied_parties', 'tasa_vigencias', 'pedimento_scan_policy', 'importer_of_record', 'customs_agent'] as const;
```
```ts
export const importerSchema = z.object({   // was: const importerSchema
  rfc: z.string().min(1),
  name: z.string().min(1),
  fiscalAddress: z.string().min(1),
}).passthrough();

export const agentSchema = z.object({       // was: const agentSchema
  patente: z.string().min(1),
  name: z.string().min(1),
  agentRfc: z.string().min(1),
  agencyRfc: z.string().min(1),
}).passthrough();
```

In `server/src/routes/catalogs.ts`: add the keys to the `Set` and the super_admin set:

```ts
const ALLOWED_CONFIG_KEYS = new Set([
  'prohibited', 'piracy_brands', 'branding', 'validation_params',
  'denied_parties', 'tasa_vigencias', 'pedimento_scan_policy',
  'importer_of_record', 'customs_agent',
]);
const SUPER_ADMIN_CONFIG_KEYS = new Set(['tasa_vigencias', 'denied_parties', 'importer_of_record', 'customs_agent']);
```

- [ ] **Step 4: Add per-key shape validation in the PUT handler**

In `server/src/routes/catalogs.ts`, import the schemas and validate the value by key. Add the import:

```ts
import { /* …existing… */ importerSchema, agentSchema } from '../validation/schemas';
```

Inside the PUT handler, after the super_admin gate and before the `const value = req.body?.value;`
INSERT, add:

```ts
    const SHAPE_BY_KEY: Record<string, typeof importerSchema | typeof agentSchema> = {
      importer_of_record: importerSchema,
      customs_agent: agentSchema,
    };
    const shape = SHAPE_BY_KEY[key];
    if (shape) {
      const parsed = shape.safeParse(req.body?.value);
      if (!parsed.success) {
        res.status(400).json({ error: 'Forma inválida para esta configuración', details: parsed.error.issues });
        return;
      }
    }
```

- [ ] **Step 5: Run to verify it passes** — `cd server && npm test -- test/routes/catalogs.test.ts` → PASS. Then `cd server && npm test` + root `npx vitest run` + `cd server && npx tsc --noEmit` → green/clean.

- [ ] **Step 6: Commit**

```bash
git add server/src/validation/schemas.ts server/src/routes/catalogs.ts server/test/routes/catalogs.test.ts
git commit -m "feat(entities): importer_of_record + customs_agent config keys with shape validation (Task 1)"
```

---

### Task 2: Entity-master reader service

**Files:**
- Create: `server/src/services/entityMaster.ts`
- Test: `server/test/services/entityMaster.test.ts`

**Interfaces:**
- Consumes: `importerSchema` / `agentSchema` (Task 1, now exported); the `config` table.
- Produces: `loadImporterOfRecord(): Promise<ImporterOfRecord | null>` and
  `loadCustomsAgent(): Promise<CustomsAgent | null>` — return the validated entity, or `null` when
  unset OR stored-but-invalid (defensive; never throws). `ImporterOfRecord = z.infer<typeof importerSchema>`,
  `CustomsAgent = z.infer<typeof agentSchema>`.

- [ ] **Step 1: Write the failing test**

```ts
// server/test/services/entityMaster.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';
import { loadImporterOfRecord, loadCustomsAgent } from '../../src/services/entityMaster';

async function setConfig(key: string, value: unknown) {
  await query(`INSERT INTO config (key, value) VALUES ($1,$2)
               ON CONFLICT (key) DO UPDATE SET value=$2`, [key, JSON.stringify(value)]);
}

describe('entityMaster', () => {
  beforeEach(truncateAll);
  it('returns null when unset', async () => {
    expect(await loadImporterOfRecord()).toBeNull();
    expect(await loadCustomsAgent()).toBeNull();
  });
  it('returns the validated importer + agent when set', async () => {
    await setConfig('importer_of_record', { rfc: 'ADM130509UQ0', name: 'ADMERCE SA DE CV', fiscalAddress: 'CDMX' });
    await setConfig('customs_agent', { patente: '1653', name: 'GUZMOR', agentRfc: 'GUMM710831UYA', agencyRfc: 'GLG1502247K9' });
    expect(await loadImporterOfRecord()).toMatchObject({ rfc: 'ADM130509UQ0', fiscalAddress: 'CDMX' });
    expect(await loadCustomsAgent()).toMatchObject({ patente: '1653', agencyRfc: 'GLG1502247K9' });
  });
  it('returns null when the stored value fails the shape (defensive)', async () => {
    await setConfig('importer_of_record', { rfc: 'X' }); // missing name + fiscalAddress
    expect(await loadImporterOfRecord()).toBeNull();
  });
});
```

> NOTE: `truncateAll` (`server/test/helpers/db.ts`) already TRUNCATEs `config`, so these tests are
> isolated — no helper change needed.

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npm test -- test/services/entityMaster.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// server/src/services/entityMaster.ts
import type { z } from 'zod';
import { query } from '../db/pool';
import { importerSchema, agentSchema } from '../validation/schemas';

export type ImporterOfRecord = z.infer<typeof importerSchema>;
export type CustomsAgent = z.infer<typeof agentSchema>;

async function loadValidated<T>(key: string, schema: { safeParse(v: unknown): { success: boolean; data?: T } }): Promise<T | null> {
  const { rows } = await query<{ value: unknown }>('SELECT value FROM config WHERE key=$1', [key]);
  if (!rows.length) return null;
  const parsed = schema.safeParse(rows[0].value);
  return parsed.success ? (parsed.data as T) : null;
}

export const loadImporterOfRecord = (): Promise<ImporterOfRecord | null> =>
  loadValidated('importer_of_record', importerSchema);
export const loadCustomsAgent = (): Promise<CustomsAgent | null> =>
  loadValidated('customs_agent', agentSchema);
```

- [ ] **Step 4: Run to verify it passes** — focused test PASS, then both suites + tsc.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/entityMaster.ts server/test/services/entityMaster.test.ts
git commit -m "feat(entities): entity-master reader service (Task 2)"
```

---

### Task 3: Pure entity cross-check helper

**Files:**
- Create: `shared/pedimento/entityCrossCheck.ts`
- Test: `shared/pedimento/entityCrossCheck.test.ts`

**Interfaces:**
- Consumes: `ExtractedPedimentoHeader` (its `importerRfc`/`agentRfc`/`agencyRfc`/`patente` fields).
- Produces: `interface EntityCrossCheck { importerRfcMismatch: boolean; agentRfcMismatch: boolean; agencyRfcMismatch: boolean; patenteMismatch: boolean }` and
  `function crossCheckEntities(extracted, importer, agent): EntityCrossCheck`. A field mismatches ONLY
  when both the extracted value and the configured value are present and differ (case-insensitive) —
  a missing extracted value (e.g. `agentRfc` not yet parsed) makes NO claim (not a mismatch).

- [ ] **Step 1: Write the failing test**

```ts
// shared/pedimento/entityCrossCheck.test.ts
import { describe, it, expect } from 'vitest';
import { crossCheckEntities } from './entityCrossCheck';

const importer = { rfc: 'ADM130509UQ0' };
const agent = { patente: '1653', agentRfc: 'GUMM710831UYA', agencyRfc: 'GLG1502247K9' };

describe('crossCheckEntities', () => {
  it('no mismatch when extracted matches the configured entities (case-insensitive)', () => {
    const r = crossCheckEntities(
      { importerRfc: 'adm130509uq0', agentRfc: null, agencyRfc: null, patente: '1653' }, importer, agent);
    expect(r).toEqual({ importerRfcMismatch: false, agentRfcMismatch: false, agencyRfcMismatch: false, patenteMismatch: false });
  });
  it('flags importerRfc + patente mismatches', () => {
    const r = crossCheckEntities(
      { importerRfc: 'WRONG010101AAA', agentRfc: null, agencyRfc: null, patente: '9999' }, importer, agent);
    expect(r.importerRfcMismatch).toBe(true);
    expect(r.patenteMismatch).toBe(true);
  });
  it('makes no claim when the extracted field is null', () => {
    const r = crossCheckEntities(
      { importerRfc: null, agentRfc: null, agencyRfc: null, patente: null }, importer, agent);
    expect(r).toEqual({ importerRfcMismatch: false, agentRfcMismatch: false, agencyRfcMismatch: false, patenteMismatch: false });
  });
  it('makes no claim when the configured entity is null', () => {
    const r = crossCheckEntities(
      { importerRfc: 'ADM130509UQ0', agentRfc: 'GUMM710831UYA', agencyRfc: 'GLG1502247K9', patente: '1653' }, null, null);
    expect(r.importerRfcMismatch).toBe(false);
    expect(r.agentRfcMismatch).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run shared/pedimento/entityCrossCheck.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// shared/pedimento/entityCrossCheck.ts
import type { ExtractedPedimentoHeader } from '../types/reports';

export interface EntityCrossCheck {
  importerRfcMismatch: boolean;
  agentRfcMismatch: boolean;
  agencyRfcMismatch: boolean;
  patenteMismatch: boolean;
}

type ExtractedIds = Pick<ExtractedPedimentoHeader, 'importerRfc' | 'agentRfc' | 'agencyRfc' | 'patente'>;

// Mismatch only when BOTH sides are present and differ (case-insensitive). A null on either side
// makes no claim — extraction may not have captured the field, or the entity may be unconfigured.
function differs(a: string | null | undefined, b: string | null | undefined): boolean {
  return a != null && b != null && a.toUpperCase() !== b.toUpperCase();
}

export function crossCheckEntities(
  extracted: ExtractedIds,
  importer: { rfc: string } | null,
  agent: { patente: string; agentRfc: string; agencyRfc: string } | null,
): EntityCrossCheck {
  return {
    importerRfcMismatch: differs(extracted.importerRfc, importer?.rfc),
    agentRfcMismatch: differs(extracted.agentRfc, agent?.agentRfc),
    agencyRfcMismatch: differs(extracted.agencyRfc, agent?.agencyRfc),
    patenteMismatch: differs(extracted.patente, agent?.patente),
  };
}
```

- [ ] **Step 4: Run to verify it passes** — focused test PASS, then root `npx vitest run` (shared is in the root suite) + `cd server && npm test` (imports nothing new) + tsc.

- [ ] **Step 5: Commit**

```bash
git add shared/pedimento/entityCrossCheck.ts shared/pedimento/entityCrossCheck.test.ts
git commit -m "feat(entities): pure entity cross-check helper (Task 3)"
```

---

### Task 4: ConfigurationView admin surface for the two entities

**Files:**
- Modify: `src/components/ConfigurationView.tsx` (add a "Entidades de pedimento" section)
- Test: `src/components/ConfigurationView.test.tsx` (extend)

**Interfaces:**
- Consumes: `GET/PUT /api/catalogs/config/importer_of_record` + `.../customs_agent`.
- Produces: a config section with an importer-of-record form (`rfc`, `name`, `fiscalAddress`) and a
  customs-agent form (`patente`, `name`, `agentRfc`, `agencyRfc`), loaded on mount and saved via PUT.

This is an interface-level task (component section + behaviors + test assertions) following the
existing per-key section pattern in `ConfigurationView.tsx` (`apiGet<ConfigResponse<T>>('/api/catalogs/config/<key>')`
on load; a `save<X>()` that calls `apiPut('/api/catalogs/config/<key>', { value })`, mirroring
`saveVigencias`/`saveBranding`). Make the styling consistent with the existing sections (use
`SectionHeader`, the existing input components).

**Section contract:**
- On mount (extend the existing `load()`): `apiGet` both keys; seed two form states. Tolerate `null`
  (unset) → empty form.
- **Importer-of-record form:** three text inputs (`rfc`, `name`, `fiscalAddress`) + a "Guardar" button
  → `apiPut('/api/catalogs/config/importer_of_record', { value: { rfc, name, fiscalAddress } })`.
- **Customs-agent form:** four text inputs (`patente`, `name`, `agentRfc`, `agencyRfc`) + a "Guardar"
  button → `apiPut('/api/catalogs/config/customs_agent', { value: { patente, name, agentRfc, agencyRfc } })`.
- Editing is super_admin-only: gate the Save buttons by the role the component already uses for
  super_admin sections (follow how the `tasa_vigencias`/vigencias section is gated — same role check).
  Non-super_admin sees the values read-only (or the section hidden), consistent with that pattern.
- On save success call `onToast` with a success message (as the other `save*` handlers do); on error
  surface `errMsg(e)`.

- [ ] **Step 1: Write the failing component test**

In `src/components/ConfigurationView.test.tsx`, add a test that the section renders and saving the
importer form calls the right endpoint. Follow the existing mock pattern (mock `../api`'s
`apiGet`/`apiPut`). Assert:
- the importer fields (`rfc`, `name`, `fiscalAddress` labels/inputs) render;
- filling them and clicking the importer "Guardar" calls
  `apiPut` with `'/api/catalogs/config/importer_of_record'` and `{ value: { rfc, name, fiscalAddress } }`;
- the customs-agent "Guardar" calls `apiPut` with `'/api/catalogs/config/customs_agent'` and the
  four-field value.

(Render the view with a super_admin role/prop so the Save buttons are enabled — match how existing
tests render the super_admin sections.)

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/components/ConfigurationView.test.tsx` → FAIL.

- [ ] **Step 3: Implement** the section + state + load + save handlers per the contract.

- [ ] **Step 4: Run to verify it passes** — the file, then BOTH full suites + `npm run lint` + `cd server && npx tsc --noEmit`. Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/ConfigurationView.tsx src/components/ConfigurationView.test.tsx
git commit -m "feat(entities): ConfigurationView section to edit importer-of-record + customs agent (Task 4)"
```

---

## Self-Review (completed)

- **Spec coverage (Phase 2):** config keys + per-key shape validation + super_admin gate (T1);
  reader helper for body assembly (T2); pure cross-check helper for reconciliation (T3); admin
  surface (T4). All Phase-2 spec bullets map to a task.
- **Placeholder scan:** backend + pure tasks (T1–T3) carry complete code/tests; T4 is an explicit
  interface-level UI task (contract + behaviors + test assertions) per the established back-half style.
- **Type consistency:** `importerSchema`/`agentSchema` exported in T1 are consumed verbatim in T2;
  `EntityCrossCheck`/`crossCheckEntities` (T3) consume `ExtractedPedimentoHeader` (Phase 1). The
  config key strings (`importer_of_record`, `customs_agent`) and entity field names
  (`rfc`/`name`/`fiscalAddress`; `patente`/`name`/`agentRfc`/`agencyRfc`) are identical across T1–T4.

## Out of scope (later phases)

Reconciliation engine + wiring the cross-check into a persisted report (Phase 3); body assembly into
the prevalidate call + the wizard UI (Phase 4); per-client importer-of-record (v1 is one global
importer + one global agent). `agentRfc`/`agencyRfc` PDF extraction (the cross-check handles their
current `null` gracefully) is a later extraction refinement.
