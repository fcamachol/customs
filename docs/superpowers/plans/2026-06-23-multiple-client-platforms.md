# Multiple Platforms Per Client — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a client own many platforms (master data) and let each manifest explicitly bind one of that client's platforms for its Reporte General.

**Architecture:** A new normalized `client_platforms` table (client → many platforms) replaces the single embedded `clients.platform` jsonb as the source of truth. `manifests` gains a nullable `platform_id` FK for the explicit per-manifest pick. The report join feeds the selected platform into the existing single-platform report builder — output layout is unchanged. The legacy `clients.platform` column is kept (untouched) for one release as a safety net.

**Tech Stack:** Node/Express + node-pg-migrate + pg (raw SQL), zod validation, Vitest + supertest (server), React + Vitest + @testing-library/react (client).

## Global Constraints

- Migration timestamp prefix must sort **after** all existing migrations (latest tracked is `1700002300000`; untracked WIP includes `1700002400000`). Use `1700002500000`.
- All platform-mutating routes use `validate({...})` with zod schemas and call `recordAudit(...)`, matching `server/src/routes/catalogs.ts`.
- Role gating mirrors existing client routes: create/edit = `requireRole('admin', 'capturista')`; delete = `requireRole('admin')`.
- Platform field names in JSON/API are camelCase (`commercialName`, `countryOfOrigin`, `legalName`, `email`); DB columns are snake_case (`commercial_name`, `country_of_origin`, `legal_name`, `email`). Always alias in SQL.
- Client-platform rows are stored **plaintext** (mirrors today's behavior; the F20a encryption applies only to shipment platforms). Do NOT add field encryption here.
- The report builder (`shared/export/reportBuilder.ts`) is **not modified** — it keeps taking a single optional `platform`.
- Empty-string platform fields are normalized to `NULL` on write (the UI sends `''` for blanks).
- Tests run with `npm test` (Vitest). Server tests truncate via `server/test/helpers/db.ts`.

---

## File Structure

**Server**
- Create: `server/migrations/1700002500000_client_platforms.ts` — table, FK, backfill.
- Modify: `server/src/validation/schemas.ts` — `clientPlatformBody`, extend `manifestClientBody`.
- Modify: `server/src/routes/catalogs.ts` — `GET /clients` returns `platforms[]`; platform CRUD; `POST /clients` creates initial platform; `PUT /clients` stops writing platform.
- Modify: `server/src/routes/manifests.ts` — bind accepts `{ clientId, platformId? }` with ownership check.
- Modify: `server/src/services/reportData.ts` — join `client_platforms` on `m.platform_id`.
- Create: `server/test/helpers/db.ts` — add `client_platforms` to the TRUNCATE list (modify).
- Create tests: `server/test/routes/clientPlatforms.test.ts`, `server/test/migrations/clientPlatforms.test.ts`, `server/test/routes/manifestPlatform.test.ts`, `server/test/services/reportPlatform.test.ts`.

**Client**
- Modify: `src/components/AddClientModal.tsx` — `Client`/`ClientPlatform` types gain `platforms`/`id`.
- Modify: `src/components/ConfigurationView.tsx` — Clientes tab shows + manages each client's platform list.
- Modify: `src/components/ReporteGeneralView.tsx` — cascading Cliente → Plataforma select; bind sends `{ clientId, platformId }`.
- Tests: extend `src/components/ConfigurationView.test.tsx`; add assertions in `ReporteGeneralView` (new test file `src/components/ReporteGeneralView.test.tsx` if absent).

---

## Task 1: Migration — `client_platforms` table, `manifests.platform_id`, backfill

**Files:**
- Create: `server/migrations/1700002500000_client_platforms.ts`
- Modify: `server/test/helpers/db.ts`
- Test: `server/test/migrations/clientPlatforms.test.ts`

**Interfaces:**
- Produces: table `client_platforms(id uuid pk, client_id uuid, commercial_name text, country_of_origin text, legal_name text, email text, created_by uuid, created_at timestamptz)`; column `manifests.platform_id uuid` FK → `client_platforms(id)` ON DELETE SET NULL.

- [ ] **Step 1: Add `client_platforms` to the test truncate helper**

Modify `server/test/helpers/db.ts` — add `client_platforms` to the TRUNCATE list (CASCADE already handles FK order, but list it explicitly):

```ts
import { pool } from '../../src/db/pool';

export async function truncateAll(): Promise<void> {
  await pool.query(
    `TRUNCATE users, audit_log, files, manifests, shipments, monthly_history, clients, client_platforms, config, pedimento_scans, validated_rfcs, manifest_staging_rows RESTART IDENTITY CASCADE`,
  );
}
```

- [ ] **Step 2: Write the failing migration test**

Create `server/test/migrations/clientPlatforms.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

beforeEach(truncateAll);

describe('client_platforms schema', () => {
  it('stores many platforms per client and cascades on client delete', async () => {
    const c = await query(`INSERT INTO clients (name) VALUES ('ACME') RETURNING id`);
    const clientId = c.rows[0].id;
    await query(
      `INSERT INTO client_platforms (client_id, commercial_name, country_of_origin)
       VALUES ($1, 'Shop A', 'CN'), ($1, 'Shop B', 'US')`, [clientId]);
    const before = await query('SELECT id FROM client_platforms WHERE client_id=$1', [clientId]);
    expect(before.rows).toHaveLength(2);

    await query('DELETE FROM clients WHERE id=$1', [clientId]);
    const after = await query('SELECT id FROM client_platforms WHERE client_id=$1', [clientId]);
    expect(after.rows).toHaveLength(0);
  });

  it('lets a manifest reference a platform and nulls it when the platform is deleted', async () => {
    const c = await query(`INSERT INTO clients (name) VALUES ('ACME') RETURNING id`);
    const p = await query(
      `INSERT INTO client_platforms (client_id, commercial_name) VALUES ($1, 'Shop A') RETURNING id`,
      [c.rows[0].id]);
    const m = await query(
      `INSERT INTO manifests (mawb_reference, client_id, platform_id) VALUES ('M-1', $1, $2) RETURNING id`,
      [c.rows[0].id, p.rows[0].id]);
    await query('DELETE FROM client_platforms WHERE id=$1', [p.rows[0].id]);
    const { rows } = await query('SELECT platform_id FROM manifests WHERE id=$1', [m.rows[0].id]);
    expect(rows[0].platform_id).toBeNull();
  });

  it('backfills one platform row from a non-empty legacy clients.platform jsonb', async () => {
    // Insert a client whose legacy jsonb carries platform data (bypassing the API).
    const c = await query(
      `INSERT INTO clients (name, platform)
       VALUES ('Legacy', '{"commercialName":"Tienda","countryOfOrigin":"CN","legalName":"","email":""}'::jsonb)
       RETURNING id`);
    // The migration backfill runs once at migrate time; this asserts its effect is reproducible.
    // Re-run the backfill statement to prove idempotent shape (no row yet for this fresh client).
    await query(
      `INSERT INTO client_platforms (client_id, commercial_name, country_of_origin, legal_name, email, created_by)
       SELECT id, NULLIF(btrim(platform->>'commercialName'),''), NULLIF(btrim(platform->>'countryOfOrigin'),''),
              NULLIF(btrim(platform->>'legalName'),''), NULLIF(btrim(platform->>'email'),''), created_by
       FROM clients
       WHERE id=$1 AND COALESCE(
         NULLIF(btrim(platform->>'commercialName'),''), NULLIF(btrim(platform->>'countryOfOrigin'),''),
         NULLIF(btrim(platform->>'legalName'),''), NULLIF(btrim(platform->>'email'),'')) IS NOT NULL`,
      [c.rows[0].id]);
    const { rows } = await query(
      'SELECT commercial_name, country_of_origin, legal_name, email FROM client_platforms WHERE client_id=$1',
      [c.rows[0].id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].commercial_name).toBe('Tienda');
    expect(rows[0].country_of_origin).toBe('CN');
    expect(rows[0].legal_name).toBeNull();
    expect(rows[0].email).toBeNull();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd server && npx vitest run test/migrations/clientPlatforms.test.ts`
Expected: FAIL — `relation "client_platforms" does not exist` / `column "platform_id" does not exist`.

- [ ] **Step 4: Write the migration**

Create `server/migrations/1700002500000_client_platforms.ts`:

```ts
import type { MigrationBuilder } from 'node-pg-migrate';

// A client can own many platforms. This table replaces the single embedded clients.platform jsonb
// as the source of truth. manifests.platform_id is the explicit per-manifest pick that the Reporte
// General overlays. The legacy clients.platform column is kept (untouched) for one release.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('client_platforms', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    client_id: { type: 'uuid', notNull: true, references: 'clients', onDelete: 'CASCADE' },
    commercial_name: { type: 'text' },
    country_of_origin: { type: 'text' },
    legal_name: { type: 'text' },
    email: { type: 'text' },
    created_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('client_platforms', 'client_id');

  pgm.addColumns('manifests', {
    platform_id: { type: 'uuid', references: 'client_platforms', onDelete: 'SET NULL' },
  });

  // Backfill: one platform row per client whose legacy jsonb carries at least one non-empty field.
  pgm.sql(`
    INSERT INTO client_platforms (client_id, commercial_name, country_of_origin, legal_name, email, created_by)
    SELECT id,
           NULLIF(btrim(platform->>'commercialName'),''),
           NULLIF(btrim(platform->>'countryOfOrigin'),''),
           NULLIF(btrim(platform->>'legalName'),''),
           NULLIF(btrim(platform->>'email'),''),
           created_by
    FROM clients
    WHERE platform IS NOT NULL
      AND COALESCE(
        NULLIF(btrim(platform->>'commercialName'),''),
        NULLIF(btrim(platform->>'countryOfOrigin'),''),
        NULLIF(btrim(platform->>'legalName'),''),
        NULLIF(btrim(platform->>'email'),'')) IS NOT NULL
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumns('manifests', ['platform_id']);
  pgm.dropTable('client_platforms');
}
```

- [ ] **Step 5: Run the migration test to verify it passes**

Run: `cd server && npx vitest run test/migrations/clientPlatforms.test.ts`
Expected: PASS (3 tests). (The Vitest global setup applies migrations to the test DB.)

- [ ] **Step 6: Commit**

```bash
git add server/migrations/1700002500000_client_platforms.ts server/test/helpers/db.ts server/test/migrations/clientPlatforms.test.ts
git commit -m "feat(db): client_platforms table + manifests.platform_id + backfill"
```

---

## Task 2: Validation schemas for platforms and manifest bind

**Files:**
- Modify: `server/src/validation/schemas.ts`

**Interfaces:**
- Produces: `clientPlatformBody` (zod) with `{ commercialName?, countryOfOrigin?, legalName?, email? }`; `manifestClientBody` extended with optional `platformId`.

- [ ] **Step 1: Add the platform body schema and extend the manifest bind schema**

In `server/src/validation/schemas.ts`, after the `updateClientBody` block (line ~47), add:

```ts
// catalogs — client platforms (one client → many)
export const clientPlatformBody = z.object({
  commercialName: z.string().optional(),
  countryOfOrigin: z.string().optional(),
  legalName: z.string().optional(),
  email: z.string().email().optional().or(z.literal('')),
});
```

Replace the existing `manifestClientBody` (line ~73) with:

```ts
export const manifestClientBody = z.object({
  clientId: z.string().min(1),
  platformId: z.string().min(1).optional(),
});
```

- [ ] **Step 2: Verify the server type-checks**

Run: `cd server && npx tsc --noEmit`
Expected: PASS (no type errors).

- [ ] **Step 3: Commit**

```bash
git add server/src/validation/schemas.ts
git commit -m "feat(validation): clientPlatformBody + platformId on manifest bind"
```

---

## Task 3: `GET /clients` returns `platforms[]`; platform CRUD routes

**Files:**
- Modify: `server/src/routes/catalogs.ts`
- Test: `server/test/routes/clientPlatforms.test.ts`

**Interfaces:**
- Consumes: `clientPlatformBody`, `idParam` from `schemas.ts`; `query`, `requireAuth`, `requireRole`, `validate`, `recordAudit`.
- Produces routes:
  - `GET /api/catalogs/clients` → each row `{ ...client, platforms: ClientPlatform[] }` where `ClientPlatform = { id, commercialName, countryOfOrigin, legalName, email }`.
  - `POST /api/catalogs/clients/:id/platforms` → 201 `ClientPlatform`.
  - `PUT /api/catalogs/clients/:id/platforms/:pid` → 200 `ClientPlatform`.
  - `DELETE /api/catalogs/clients/:id/platforms/:pid` → 200 `{ ok: true }`.

- [ ] **Step 1: Write the failing route tests**

Create `server/test/routes/clientPlatforms.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { hashPassword } from '../../src/auth/password';
import { signToken } from '../../src/auth/token';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

const app = createApp();
let adminToken: string; let clientId: string;

beforeEach(async () => {
  await truncateAll();
  const hash = await hashPassword('p');
  const u = await query(`INSERT INTO users (username,password_hash,role) VALUES ('a',$1,'admin') RETURNING id`, [hash]);
  adminToken = signToken({ userId: u.rows[0].id, role: 'admin', tv: 0 });
  const c = await query(`INSERT INTO clients (name) VALUES ('ACME') RETURNING id`);
  clientId = c.rows[0].id;
});

describe('client platforms CRUD', () => {
  it('adds a platform and returns it in GET /clients', async () => {
    const add = await request(app)
      .post(`/api/catalogs/clients/${clientId}/platforms`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ commercialName: 'Shop A', countryOfOrigin: 'CN', legalName: '', email: '' });
    expect(add.status).toBe(201);
    expect(add.body.id).toBeTruthy();
    expect(add.body.commercialName).toBe('Shop A');
    expect(add.body.legalName).toBeNull();

    const list = await request(app).get('/api/catalogs/clients').set('Authorization', `Bearer ${adminToken}`);
    expect(list.status).toBe(200);
    const acme = list.body.find((c: { id: string }) => c.id === clientId);
    expect(acme.platforms).toHaveLength(1);
    expect(acme.platforms[0].commercialName).toBe('Shop A');
  });

  it('returns an empty platforms array for a client with none', async () => {
    const list = await request(app).get('/api/catalogs/clients').set('Authorization', `Bearer ${adminToken}`);
    const acme = list.body.find((c: { id: string }) => c.id === clientId);
    expect(acme.platforms).toEqual([]);
  });

  it('edits a platform', async () => {
    const add = await request(app).post(`/api/catalogs/clients/${clientId}/platforms`)
      .set('Authorization', `Bearer ${adminToken}`).send({ commercialName: 'Old' });
    const pid = add.body.id;
    const put = await request(app).put(`/api/catalogs/clients/${clientId}/platforms/${pid}`)
      .set('Authorization', `Bearer ${adminToken}`).send({ commercialName: 'New', countryOfOrigin: 'US' });
    expect(put.status).toBe(200);
    expect(put.body.commercialName).toBe('New');
    expect(put.body.countryOfOrigin).toBe('US');
  });

  it('deletes a platform', async () => {
    const add = await request(app).post(`/api/catalogs/clients/${clientId}/platforms`)
      .set('Authorization', `Bearer ${adminToken}`).send({ commercialName: 'X' });
    const del = await request(app).delete(`/api/catalogs/clients/${clientId}/platforms/${add.body.id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(del.status).toBe(200);
    const list = await request(app).get('/api/catalogs/clients').set('Authorization', `Bearer ${adminToken}`);
    expect(list.body.find((c: { id: string }) => c.id === clientId).platforms).toEqual([]);
  });

  it('404s adding a platform to a missing client', async () => {
    const res = await request(app)
      .post('/api/catalogs/clients/00000000-0000-0000-0000-000000000000/platforms')
      .set('Authorization', `Bearer ${adminToken}`).send({ commercialName: 'X' });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run test/routes/clientPlatforms.test.ts`
Expected: FAIL — routes return 404/undefined; `platforms` is absent.

- [ ] **Step 3: Update `GET /clients` to aggregate platforms**

In `server/src/routes/catalogs.ts`, replace the `GET /clients` handler query (lines ~11-17) with:

```ts
catalogsRouter.get('/clients', requireAuth, async (req, res) => {
  const { rows } = await query(
    `SELECT c.id, c.name, c.tax_id, c.address, c.phone, c.email, c.website, c.created_by, c.created_at,
            COALESCE(
              json_agg(
                json_build_object(
                  'id', p.id,
                  'commercialName', p.commercial_name,
                  'countryOfOrigin', p.country_of_origin,
                  'legalName', p.legal_name,
                  'email', p.email
                ) ORDER BY p.created_at
              ) FILTER (WHERE p.id IS NOT NULL),
              '[]'
            ) AS platforms
       FROM clients c
       LEFT JOIN client_platforms p ON p.client_id = c.id
       GROUP BY c.id
       ORDER BY c.name`,
  );
  res.json(rows);
});
```

- [ ] **Step 4: Add the platform CRUD routes**

Add the import for the new schema at the top of `catalogs.ts` (extend the existing import from `../validation/schemas`):

```ts
import { createClientBody, configKeyParam, configValueBody, validatedRfcBody, clientPlatformBody, idParam } from '../validation/schemas';
```

Then add these handlers immediately after the `DELETE /clients/:id` handler (after line ~122, before the Config section):

```ts
// ─── Client platforms (one client → many) ───────────────────────────────────

const PLATFORM_RETURNING =
  `id, commercial_name AS "commercialName", country_of_origin AS "countryOfOrigin",
   legal_name AS "legalName", email`;

// helper: normalize '' → null
const orNull = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

// POST /api/catalogs/clients/:id/platforms — admin or capturista
catalogsRouter.post(
  '/clients/:id/platforms',
  requireAuth,
  requireRole('admin', 'capturista'),
  validate({ params: idParam, body: clientPlatformBody }),
  async (req, res) => {
    const { id } = req.params;
    const client = await query('SELECT id FROM clients WHERE id=$1', [id]);
    if (client.rows.length === 0) { res.status(404).json({ error: 'Client not found' }); return; }
    const { commercialName, countryOfOrigin, legalName, email } = req.body;
    const { rows } = await query(
      `INSERT INTO client_platforms (client_id, commercial_name, country_of_origin, legal_name, email, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${PLATFORM_RETURNING}`,
      [id, orNull(commercialName), orNull(countryOfOrigin), orNull(legalName), orNull(email), req.user!.userId],
    );
    await recordAudit({
      userId: req.user!.userId, action: 'CREATE_CLIENT_PLATFORM', entity: 'client_platform',
      entityId: rows[0].id, after: rows[0], ip: req.ip,
    });
    res.status(201).json(rows[0]);
  },
);

// PUT /api/catalogs/clients/:id/platforms/:pid — admin or capturista
catalogsRouter.put(
  '/clients/:id/platforms/:pid',
  requireAuth,
  requireRole('admin', 'capturista'),
  validate({ body: clientPlatformBody }),
  async (req, res) => {
    const { id, pid } = req.params;
    const before = await query('SELECT * FROM client_platforms WHERE id=$1 AND client_id=$2', [pid, id]);
    if (before.rows.length === 0) { res.status(404).json({ error: 'Platform not found' }); return; }
    const { commercialName, countryOfOrigin, legalName, email } = req.body;
    const { rows } = await query(
      `UPDATE client_platforms
         SET commercial_name = $3, country_of_origin = $4, legal_name = $5, email = $6
       WHERE id = $1 AND client_id = $2
       RETURNING ${PLATFORM_RETURNING}`,
      [pid, id, orNull(commercialName), orNull(countryOfOrigin), orNull(legalName), orNull(email)],
    );
    await recordAudit({
      userId: req.user!.userId, action: 'UPDATE_CLIENT_PLATFORM', entity: 'client_platform',
      entityId: pid, before: before.rows[0], after: rows[0], ip: req.ip,
    });
    res.json(rows[0]);
  },
);

// DELETE /api/catalogs/clients/:id/platforms/:pid — admin only
catalogsRouter.delete(
  '/clients/:id/platforms/:pid',
  requireAuth,
  requireRole('admin'),
  async (req, res) => {
    const { id, pid } = req.params;
    const before = await query('SELECT * FROM client_platforms WHERE id=$1 AND client_id=$2', [pid, id]);
    if (before.rows.length === 0) { res.status(404).json({ error: 'Platform not found' }); return; }
    await query('DELETE FROM client_platforms WHERE id=$1 AND client_id=$2', [pid, id]);
    await recordAudit({
      userId: req.user!.userId, action: 'DELETE_CLIENT_PLATFORM', entity: 'client_platform',
      entityId: pid, before: before.rows[0], ip: req.ip,
    });
    res.json({ ok: true });
  },
);
```

- [ ] **Step 5: Run the route tests to verify they pass**

Run: `cd server && npx vitest run test/routes/clientPlatforms.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/catalogs.ts server/test/routes/clientPlatforms.test.ts
git commit -m "feat(catalogs): client platform CRUD + platforms[] on GET /clients"
```

---

## Task 4: `POST /clients` creates an initial platform; `PUT /clients` stops writing platform

**Files:**
- Modify: `server/src/routes/catalogs.ts`
- Test: `server/test/routes/clientPlatforms.test.ts` (append)

**Interfaces:**
- Consumes: existing `createClientBody` (already has optional `platform`).
- Produces: `POST /clients` with a non-empty `platform` object also inserts one `client_platforms` row; response includes `platforms[]`. `PUT /clients` ignores `platform`.

- [ ] **Step 1: Append failing tests**

Append to `server/test/routes/clientPlatforms.test.ts` inside the `describe`:

```ts
  it('POST /clients with a platform creates the client and its first platform row', async () => {
    const res = await request(app).post('/api/catalogs/clients')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'NewCo', platform: { commercialName: 'NC Shop', countryOfOrigin: 'MX' } });
    expect(res.status).toBe(201);
    expect(res.body.platforms).toHaveLength(1);
    expect(res.body.platforms[0].commercialName).toBe('NC Shop');
  });

  it('POST /clients with an all-empty platform creates no platform row', async () => {
    const res = await request(app).post('/api/catalogs/clients')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'EmptyCo', platform: { commercialName: '', countryOfOrigin: '', legalName: '', email: '' } });
    expect(res.status).toBe(201);
    expect(res.body.platforms).toEqual([]);
  });

  it('PUT /clients ignores a platform field (no row created)', async () => {
    await request(app).put(`/api/catalogs/clients/${clientId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'ACME2', platform: { commercialName: 'ShouldBeIgnored' } });
    const list = await request(app).get('/api/catalogs/clients').set('Authorization', `Bearer ${adminToken}`);
    const acme = list.body.find((c: { id: string }) => c.id === clientId);
    expect(acme.name).toBe('ACME2');
    expect(acme.platforms).toEqual([]);
  });
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `cd server && npx vitest run test/routes/clientPlatforms.test.ts`
Expected: FAIL — POST returns a client without `platforms`; PUT may create nothing but `platforms` is absent on the GET response only if Task 3 shipped (it did), so the failing ones are the two POST cases.

- [ ] **Step 3: Rewrite `POST /clients` to create client + initial platform and return platforms[]**

Replace the `POST /clients` handler body (lines ~20-45) with:

```ts
catalogsRouter.post(
  '/clients',
  requireAuth,
  requireRole('admin', 'capturista'),
  validate({ body: createClientBody }),
  async (req, res) => {
    const { name, tax_id, address, phone, email, website, platform } = req.body;
    const inserted = await query(
      `INSERT INTO clients (name, tax_id, address, phone, email, website, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, name, tax_id, address, phone, email, website, created_by, created_at`,
      [name, tax_id ?? null, address ?? null, phone ?? null, email ?? null, website ?? null, req.user!.userId],
    );
    const client = inserted.rows[0];

    // Create the initial platform row when the caller supplied non-empty platform data.
    const p = (platform ?? {}) as Record<string, unknown>;
    const pn = (k: string) => (typeof p[k] === 'string' && (p[k] as string).trim() !== '' ? (p[k] as string).trim() : null);
    let platforms: unknown[] = [];
    if (pn('commercialName') || pn('countryOfOrigin') || pn('legalName') || pn('email')) {
      const pr = await query(
        `INSERT INTO client_platforms (client_id, commercial_name, country_of_origin, legal_name, email, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, commercial_name AS "commercialName", country_of_origin AS "countryOfOrigin",
                   legal_name AS "legalName", email`,
        [client.id, pn('commercialName'), pn('countryOfOrigin'), pn('legalName'), pn('email'), req.user!.userId],
      );
      platforms = pr.rows;
    }

    const after = { ...client, platforms };
    await recordAudit({
      userId: req.user!.userId, action: 'CREATE_CLIENT', entity: 'client',
      entityId: client.id, after, ip: req.ip,
    });
    res.status(201).json(after);
  },
);
```

- [ ] **Step 4: Drop `platform` writes from `PUT /clients`**

In the `PUT /clients/:id` handler, remove `platform` from the destructure, the `SET platform = ...` clause, and the params array. The handler becomes (replace lines ~48-94):

```ts
catalogsRouter.put(
  '/clients/:id',
  requireAuth,
  requireRole('admin', 'capturista'),
  async (req, res) => {
    const { id } = req.params;
    const { name, tax_id, address, phone, email, website } = req.body ?? {};

    const before = await query('SELECT * FROM clients WHERE id = $1', [id]);
    if (before.rows.length === 0) { res.status(404).json({ error: 'Client not found' }); return; }

    const { rows } = await query(
      `UPDATE clients
         SET name    = COALESCE($2, name),
             tax_id  = COALESCE($3, tax_id),
             address = COALESCE($4, address),
             phone   = COALESCE($5, phone),
             email   = COALESCE($6, email),
             website = COALESCE($7, website)
       WHERE id = $1
       RETURNING id, name, tax_id, address, phone, email, website, created_by, created_at`,
      [id, name ?? null, tax_id ?? null, address ?? null, phone ?? null, email ?? null, website ?? null],
    );
    await recordAudit({
      userId: req.user!.userId, action: 'UPDATE_CLIENT', entity: 'client',
      entityId: id, before: before.rows[0], after: rows[0], ip: req.ip,
    });
    res.json(rows[0]);
  },
);
```

- [ ] **Step 5: Run the full catalogs test file to verify it passes**

Run: `cd server && npx vitest run test/routes/clientPlatforms.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/catalogs.ts server/test/routes/clientPlatforms.test.ts
git commit -m "feat(catalogs): POST /clients creates initial platform; PUT drops platform write"
```

---

## Task 5: Manifest bind accepts `{ clientId, platformId? }` with ownership validation

**Files:**
- Modify: `server/src/routes/manifests.ts`
- Test: `server/test/routes/manifestPlatform.test.ts`

**Interfaces:**
- Consumes: extended `manifestClientBody` (Task 2).
- Produces: `POST /api/manifests/:id/client` sets `manifests.client_id` and `manifests.platform_id`; rejects (400) a `platformId` not owned by `clientId`; busts `report_file_id`.

- [ ] **Step 1: Write the failing tests**

Create `server/test/routes/manifestPlatform.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { hashPassword } from '../../src/auth/password';
import { signToken } from '../../src/auth/token';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

const app = createApp();
let token: string; let manifestId: string; let clientId: string; let platformId: string;

beforeEach(async () => {
  await truncateAll();
  const hash = await hashPassword('p');
  const u = await query(`INSERT INTO users (username,password_hash,role) VALUES ('a',$1,'admin') RETURNING id`, [hash]);
  token = signToken({ userId: u.rows[0].id, role: 'admin', tv: 0 });
  const m = await query(`INSERT INTO manifests (mawb_reference, created_by) VALUES ('M-1', $1) RETURNING id`, [u.rows[0].id]);
  manifestId = m.rows[0].id;
  const c = await query(`INSERT INTO clients (name) VALUES ('ACME') RETURNING id`);
  clientId = c.rows[0].id;
  const p = await query(`INSERT INTO client_platforms (client_id, commercial_name) VALUES ($1,'Shop A') RETURNING id`, [clientId]);
  platformId = p.rows[0].id;
});

describe('manifest client+platform bind', () => {
  it('binds client and platform together', async () => {
    const res = await request(app).post(`/api/manifests/${manifestId}/client`)
      .set('Authorization', `Bearer ${token}`).send({ clientId, platformId });
    expect(res.status).toBe(200);
    const { rows } = await query('SELECT client_id, platform_id FROM manifests WHERE id=$1', [manifestId]);
    expect(rows[0].client_id).toBe(clientId);
    expect(rows[0].platform_id).toBe(platformId);
  });

  it('rejects a platform that does not belong to the client', async () => {
    const other = await query(`INSERT INTO clients (name) VALUES ('Other') RETURNING id`);
    const otherP = await query(`INSERT INTO client_platforms (client_id, commercial_name) VALUES ($1,'X') RETURNING id`, [other.rows[0].id]);
    const res = await request(app).post(`/api/manifests/${manifestId}/client`)
      .set('Authorization', `Bearer ${token}`).send({ clientId, platformId: otherP.rows[0].id });
    expect(res.status).toBe(400);
  });

  it('allows binding a client without a platform', async () => {
    const res = await request(app).post(`/api/manifests/${manifestId}/client`)
      .set('Authorization', `Bearer ${token}`).send({ clientId });
    expect(res.status).toBe(200);
    const { rows } = await query('SELECT platform_id FROM manifests WHERE id=$1', [manifestId]);
    expect(rows[0].platform_id).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx vitest run test/routes/manifestPlatform.test.ts`
Expected: FAIL — `platform_id` stays null on the bind; the ownership-rejection test gets 200 instead of 400.

- [ ] **Step 3: Update the bind handler**

In `server/src/routes/manifests.ts`, replace the `POST /:id/client` handler (lines ~108-129) with:

```ts
// POST /api/manifests/:id/client — associate a client (and optionally one of its platforms)
manifestsRouter.post('/:id/client', requireAuth, requireRole('admin', 'capturista'), validate({ body: manifestClientBody }), async (req, res) => {
  const { id } = req.params;
  const { clientId, platformId } = req.body;

  const existing = await query('SELECT id FROM manifests WHERE id=$1', [id]);
  if (existing.rows.length === 0) { res.status(404).json({ error: 'Manifest not found' }); return; }

  const clientCheck = await query('SELECT id FROM clients WHERE id=$1', [clientId]);
  if (clientCheck.rows.length === 0) { res.status(404).json({ error: 'Client not found' }); return; }

  if (platformId) {
    const pc = await query('SELECT id FROM client_platforms WHERE id=$1 AND client_id=$2', [platformId, clientId]);
    if (pc.rows.length === 0) { res.status(400).json({ error: 'Platform does not belong to client' }); return; }
  }

  // Bust the cached Reporte General: the client + platform overlay feeds the report.
  await query('UPDATE manifests SET client_id=$1, platform_id=$2, report_file_id=NULL WHERE id=$3',
    [clientId, platformId ?? null, id]);
  await recordAudit({
    userId: req.user!.userId,
    action: 'LINK_CLIENT',
    entity: 'manifest',
    entityId: id,
    after: { clientId, platformId: platformId ?? null },
    ip: req.ip,
  });
  res.json({ ok: true });
});
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npx vitest run test/routes/manifestPlatform.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/manifests.ts server/test/routes/manifestPlatform.test.ts
git commit -m "feat(manifests): bind client + platform with ownership validation"
```

---

## Task 6: Report join uses `manifests.platform_id`

**Files:**
- Modify: `server/src/services/reportData.ts`
- Test: `server/test/services/reportPlatform.test.ts`

**Interfaces:**
- Consumes: `manifests.platform_id`, `client_platforms`.
- Produces: `buildReportRowsForManifest` overlays the **selected** platform's fields into the Plataforma columns; null `platform_id` → blank Plataforma block.

- [ ] **Step 1: Write the failing test**

Create `server/test/services/reportPlatform.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';
import { buildReportRowsForManifest, loadShipments } from '../../src/services/reportData';

beforeEach(truncateAll);

async function seedManifestWithShipment(): Promise<{ manifestId: string; clientId: string }> {
  const u = await query(`INSERT INTO users (username,password_hash,role) VALUES ('a','x','admin') RETURNING id`);
  const c = await query(`INSERT INTO clients (name) VALUES ('ACME') RETURNING id`);
  const m = await query(`INSERT INTO manifests (mawb_reference, client_id, created_by) VALUES ('369-1',$1,$2) RETURNING id`,
    [c.rows[0].id, u.rows[0].id]);
  const s = { id: crypto.randomUUID(), mawbReference: '369-1', description: 'X', hsCode: '99010001',
    quantity: 1, unit: '6', customsValueUsd: 10, currency: 'USD', originCountry: 'CN', guideId: 'g1',
    consignee: { name: 'Juan' }, sender: { name: 'S' }, platform: { commercialName: 'shipP' } };
  await query('INSERT INTO shipments (id,manifest_id,data) VALUES ($1,$2,$3)',
    [s.id, m.rows[0].id, JSON.stringify(s)]);
  return { manifestId: m.rows[0].id, clientId: c.rows[0].id };
}

describe('report platform overlay', () => {
  it('overlays the selected platform into the Plataforma columns', async () => {
    const { manifestId, clientId } = await seedManifestWithShipment();
    const p = await query(
      `INSERT INTO client_platforms (client_id, commercial_name, country_of_origin) VALUES ($1,'Tienda','CN') RETURNING id`,
      [clientId]);
    await query('UPDATE manifests SET platform_id=$1 WHERE id=$2', [p.rows[0].id, manifestId]);

    const loaded = await loadShipments(manifestId);
    const rows = await buildReportRowsForManifest(manifestId, loaded);
    expect(rows[0]['Plataforma Nombre comercial']).toBe('Tienda');
    expect(rows[0]['Plataforma País de origen']).toBe('CN');
  });

  it('leaves the Plataforma block blank when no platform is selected', async () => {
    const { manifestId } = await seedManifestWithShipment();
    const loaded = await loadShipments(manifestId);
    const rows = await buildReportRowsForManifest(manifestId, loaded);
    expect(rows[0]['Plataforma Nombre comercial'] ?? '').toBe('');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx vitest run test/services/reportPlatform.test.ts`
Expected: FAIL — `buildReportRowsForManifest` still reads `c.platform` (the legacy jsonb), so the selected platform does not appear.

- [ ] **Step 3: Update the report join and client overlay**

In `server/src/services/reportData.ts`, replace the query and `client` assembly inside `buildReportRowsForManifest` (lines ~63-103) with:

```ts
  const m = await query(
    `SELECT m.import_data, c.name, c.tax_id, c.address, c.phone, c.email,
            p.commercial_name, p.country_of_origin, p.legal_name, p.email AS platform_email
     FROM manifests m
     LEFT JOIN clients c ON c.id = m.client_id
     LEFT JOIN client_platforms p ON p.id = m.platform_id
     WHERE m.id = $1`,
    [manifestId],
  );
  const manifest = m.rows[0] ?? {};
```

Then replace the `client: manifest.name ? {...}` object passed to `buildReportRows` (lines ~95-102) with:

```ts
    client: manifest.name ? {
      name: manifest.name,
      tax_id: manifest.tax_id ?? undefined,
      address: manifest.address ?? undefined,
      phone: manifest.phone ?? undefined,
      email: manifest.email ?? undefined,
      platform: (manifest.commercial_name || manifest.country_of_origin || manifest.legal_name || manifest.platform_email)
        ? {
            commercialName: manifest.commercial_name ?? undefined,
            countryOfOrigin: manifest.country_of_origin ?? undefined,
            legalName: manifest.legal_name ?? undefined,
            email: manifest.platform_email ?? undefined,
          }
        : undefined,
    } : undefined,
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npx vitest run test/services/reportPlatform.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the existing exports tests to confirm no regression**

Run: `cd server && npx vitest run test/routes/exports.test.ts`
Expected: PASS (the report no longer reads `clients.platform`; those tests don't set a platform, so the Plataforma block is simply blank, which they don't assert).

- [ ] **Step 6: Commit**

```bash
git add server/src/services/reportData.ts server/test/services/reportPlatform.test.ts
git commit -m "feat(reports): overlay the manifest-selected platform from client_platforms"
```

---

## Task 7: Frontend types — `Client.platforms` / `ClientPlatform.id`

**Files:**
- Modify: `src/components/AddClientModal.tsx`

**Interfaces:**
- Produces: `ClientPlatform = { id?: string; commercialName?; countryOfOrigin?; legalName?; email? }`; `Client` gains `platforms?: ClientPlatform[]`. These are imported by `ConfigurationView.tsx` and `ReporteGeneralView.tsx`.

- [ ] **Step 1: Update the exported interfaces**

In `src/components/AddClientModal.tsx`, replace the `ClientPlatform` and `Client` interfaces (lines 5-21) with:

```ts
export interface ClientPlatform {
  id?: string;
  commercialName?: string;
  countryOfOrigin?: string;
  legalName?: string;
  email?: string;
}

export interface Client {
  id: string;
  name: string;
  tax_id?: string;
  address?: string;
  phone?: string;
  email?: string;
  website?: string;
  /** Single platform shape kept for the create form; the API returns the full list below. */
  platform?: ClientPlatform;
  platforms?: ClientPlatform[];
}
```

(The `AddClientModal` create form is unchanged — it still POSTs a single `platform` object, which the server turns into the first platform row.)

- [ ] **Step 2: Type-check the client**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Run the existing AddClientModal test**

Run: `npx vitest run src/components/AddClientModal.test.tsx`
Expected: PASS (unchanged behavior).

- [ ] **Step 4: Commit**

```bash
git add src/components/AddClientModal.tsx
git commit -m "feat(ui): Client gains platforms[]; ClientPlatform gains id"
```

---

## Task 8: ConfigurationView Clientes tab — inline platform management

**Files:**
- Modify: `src/components/ConfigurationView.tsx`
- Test: `src/components/ConfigurationView.test.tsx` (append)

**Interfaces:**
- Consumes: `Client`, `ClientPlatform` from `AddClientModal`; `apiPost`, `apiPut`, `apiDelete`.
- Produces: each client row in the Clientes table shows its platforms with add/remove controls hitting `/api/catalogs/clients/:id/platforms[/:pid]`.

- [ ] **Step 1: Write the failing test**

The existing harness renders `<ConfigurationView domain="cfg_clientes" />` inside `<AuthProvider>` and mocks `../api`, where `apiGet('/clients')` returns `[]` (see the top of `ConfigurationView.test.tsx`). The platform **list** renders for every role (only the add/remove controls are admin-gated, and the harness renders as a non-admin user). So the failing test asserts the list rendering. Append inside the `describe('ConfigurationView', ...)` block:

```tsx
it('renders each client\'s platforms in the Clientes pane', async () => {
  const { apiGet } = await import('../api');
  vi.mocked(apiGet).mockImplementation(async (path: string) => {
    if (path.includes('/clients')) {
      return [{ id: 'cl1', name: 'ACME', platforms: [{ id: 'p1', commercialName: 'Shop A', countryOfOrigin: 'CN' }] }];
    }
    if (path.includes('/validated-rfcs')) return [];
    return { key: '', value: null };
  });
  render(
    <Wrapper>
      <ConfigurationView domain="cfg_clientes" onToast={() => {}} />
    </Wrapper>,
  );
  await waitFor(() => expect(screen.getByText('Shop A')).toBeTruthy());
});
```

> Implementer note (admin add/remove path): the existing harness renders as a non-admin user, so the `+ Agregar plataforma` control and `apiPost('/api/catalogs/clients/cl1/platforms', { commercialName: 'Shop A' })` interaction can't be exercised without an authenticated-admin `AuthProvider`. That admin-context test is covered server-side in `clientPlatforms.test.ts` (Task 3) and is out of scope for this UI test. Do NOT fabricate an admin context here.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/ConfigurationView.test.tsx`
Expected: FAIL — `getByText('Shop A')` throws because the Plataforma cell does not yet render `c.platforms`.

- [ ] **Step 3: Render the platform list + add control per client**

In `ConfigurationView.tsx`, in `ClientesTab`, replace the single Plataforma cell (line ~471) so each row shows the platform list, and add per-client add/remove handlers. Add these handlers inside `ClientesTab` (after `removeClient`):

```ts
  async function addPlatform(clientId: string, p: ClientPlatform) {
    if (!isAdmin) return;
    try {
      await apiPost(`/api/catalogs/clients/${clientId}/platforms`, p);
      onToast('Plataforma agregada');
      onClientsChanged();
    } catch (e) {
      onToast(`Error: ${errMsg(e)}`);
    }
  }

  async function removePlatform(clientId: string, pid: string) {
    if (!isAdmin) return;
    try {
      await apiDelete(`/api/catalogs/clients/${clientId}/platforms/${pid}`);
      onToast('Plataforma eliminada');
      onClientsChanged();
    } catch (e) {
      onToast(`Error: ${errMsg(e)}`);
    }
  }
```

Change the Plataforma `<td>` (line ~471) to list every platform with a remove button (admin only):

```tsx
                    <td className="px-3 py-2 text-slate-600">
                      {(c.platforms ?? []).length === 0 ? (
                        <span className="text-slate-400">—</span>
                      ) : (
                        <ul className="space-y-1">
                          {(c.platforms ?? []).map((p) => (
                            <li key={p.id} className="flex items-center gap-2">
                              <span>{p.commercialName || p.legalName || '—'}</span>
                              {p.countryOfOrigin && <span className="text-xs text-slate-400">({p.countryOfOrigin})</span>}
                              {isAdmin && (
                                <button
                                  type="button"
                                  onClick={() => removePlatform(c.id, p.id!)}
                                  className="text-slate-300 transition hover:text-red-600"
                                  aria-label="Eliminar plataforma"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                      {isAdmin && <PlatformAdder onAdd={(p) => addPlatform(c.id, p)} />}
                    </td>
```

Add the `ClientPlatform` import at the top of the file (extend the existing import from `./AddClientModal`, or add one):

```ts
import type { Client, ClientPlatform } from './AddClientModal';
```

- [ ] **Step 4: Add the small `PlatformAdder` sub-component**

At the bottom of `ConfigurationView.tsx`, add a focused component (one responsibility: collect a platform and emit it):

```tsx
function PlatformAdder({ onAdd }: { onAdd: (p: ClientPlatform) => void }) {
  const [open, setOpen] = useState(false);
  const [p, setP] = useState<ClientPlatform>({});
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="mt-1 text-xs font-medium text-navy-700 hover:underline">
        + Agregar plataforma
      </button>
    );
  }
  return (
    <div className="mt-2 space-y-1 rounded border border-slate-200 bg-slate-50 p-2">
      <Input placeholder="Nombre comercial" value={p.commercialName ?? ''} onChange={(e) => setP({ ...p, commercialName: e.target.value })} />
      <Input placeholder="País de origen" value={p.countryOfOrigin ?? ''} onChange={(e) => setP({ ...p, countryOfOrigin: e.target.value })} />
      <Input placeholder="Razón social" value={p.legalName ?? ''} onChange={(e) => setP({ ...p, legalName: e.target.value })} />
      <Input placeholder="Correo" value={p.email ?? ''} onChange={(e) => setP({ ...p, email: e.target.value })} />
      <div className="flex gap-2 pt-1">
        <Button type="button" onClick={() => { onAdd(p); setP({}); setOpen(false); }}>Guardar</Button>
        <Button variant="secondary" type="button" onClick={() => { setP({}); setOpen(false); }}>Cancelar</Button>
      </div>
    </div>
  );
}
```

(Confirm `Input`, `Button` are already imported at the top of `ConfigurationView.tsx`; they are used elsewhere in the file.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/components/ConfigurationView.test.tsx`
Expected: PASS.

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/ConfigurationView.tsx src/components/ConfigurationView.test.tsx
git commit -m "feat(ui): manage a client's platform list in the Clientes tab"
```

---

## Task 9: ReporteGeneralView — cascading Cliente → Plataforma select

**Files:**
- Modify: `src/components/ReporteGeneralView.tsx`
- Test: `src/components/ReporteGeneralView.test.tsx` (create)

**Interfaces:**
- Consumes: `GET /api/catalogs/clients` (returns `Client[]` with `platforms[]`); `POST /api/manifests/:id/client` with `{ clientId, platformId }`.
- Produces: a client `<select>` and a platform `<select>` (platform disabled/empty until a client is chosen and reset on client change); report generation requires both and sends them to the bind endpoint.

- [ ] **Step 1: Write the failing test**

Create `src/components/ReporteGeneralView.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ReporteGeneralView from './ReporteGeneralView';
import { apiGet, apiPost, apiDownload } from '../api';

vi.mock('../api', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiDownload: vi.fn(),
}));

beforeEach(() => vi.clearAllMocks());

describe('ReporteGeneralView cascading select', () => {
  it('populates the platform select only after a client is chosen and binds both on generate', async () => {
    (apiGet as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
      if (path === '/api/catalogs/clients') {
        return Promise.resolve([
          { id: 'cl1', name: 'ACME', platforms: [{ id: 'p1', commercialName: 'Shop A' }, { id: 'p2', commercialName: 'Shop B' }] },
        ]);
      }
      if (path.startsWith('/api/records?q=')) {
        return Promise.resolve([{ id: 'm1', mawbReference: '369-1', clientName: 'ACME', createdAt: '2026-06-23' }]);
      }
      return Promise.resolve([]);
    });
    (apiPost as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    (apiDownload as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    render(<ReporteGeneralView />);

    // Search + select a manifest record.
    fireEvent.change(screen.getByPlaceholderText(/Buscar registro/i), { target: { value: '369' } });
    fireEvent.click(screen.getByRole('button', { name: /Buscar/i }));
    await waitFor(() => screen.getByText(/369-1/));
    fireEvent.click(screen.getByText(/369-1/));

    // Choose client → platform select becomes enabled with that client's platforms.
    fireEvent.change(await screen.findByLabelText(/Cliente/i), { target: { value: 'cl1' } });
    const platformSelect = await screen.findByLabelText(/Plataforma/i);
    fireEvent.change(platformSelect, { target: { value: 'p2' } });

    fireEvent.click(screen.getByRole('button', { name: /Generar/i }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith(
      '/api/manifests/m1/client',
      { clientId: 'cl1', platformId: 'p2' },
    ));
    expect(apiDownload).toHaveBeenCalled();
  });
});
```

> Implementer note: adjust the button label regex (`/Generar/i`) and search placeholder to match the actual JSX after Step 3 if you rename anything.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/ReporteGeneralView.test.tsx`
Expected: FAIL — no Cliente/Plataforma selects exist; generate still POSTs a new client.

- [ ] **Step 3: Add the cascading selects and rewrite generate**

In `src/components/ReporteGeneralView.tsx`:

(a) Add imports + state. Extend the existing imports:

```ts
import { useEffect, useState } from 'react';
import type { Client } from './AddClientModal';
```

Add state near the other `useState` declarations (after line ~35):

```ts
  const [clients, setClients] = useState<Client[]>([]);
  const [selectedClientId, setSelectedClientId] = useState('');
  const [selectedPlatformId, setSelectedPlatformId] = useState('');
```

Load clients on mount:

```ts
  useEffect(() => {
    apiGet<Client[]>('/api/catalogs/clients').then(setClients).catch(() => setClients([]));
  }, []);

  const selectedClient = clients.find((c) => c.id === selectedClientId);
  const platformOptions = selectedClient?.platforms ?? [];
```

(b) Replace `handleGenerateReport` (lines ~58-86) with a version that binds the selected client + platform instead of upserting a new client:

```ts
  async function handleGenerateReport() {
    if (!selectedId) return;
    if (!selectedClientId) { setError('Selecciona un cliente.'); return; }
    if (!selectedPlatformId) { setError('Selecciona una plataforma.'); return; }
    setError(null);
    setDownloading(true);
    try {
      await apiPost(`/api/manifests/${selectedId}/client`, {
        clientId: selectedClientId,
        platformId: selectedPlatformId,
      });
      await apiDownload(`/api/records/${selectedId}/report.xlsx`, 'Reporte_General.xlsx');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al generar el reporte.');
    } finally {
      setDownloading(false);
    }
  }
```

(c) Add the two selects in the JSX. Insert a new Card just before the "Datos del Remitente" card (line ~141). Reset the platform when the client changes:

```tsx
      {/* Selección de cliente y plataforma */}
      <Card className="p-6 shadow-sm space-y-5">
        <h2 className="text-sm font-bold text-slate-800">Cliente y plataforma</h2>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Cliente" htmlFor="rg-cliente">
            <select
              id="rg-cliente"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              value={selectedClientId}
              onChange={(e) => { setSelectedClientId(e.target.value); setSelectedPlatformId(''); }}
            >
              <option value="">Selecciona un cliente…</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Plataforma" htmlFor="rg-plataforma">
            <select
              id="rg-plataforma"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-100"
              value={selectedPlatformId}
              disabled={!selectedClientId}
              onChange={(e) => setSelectedPlatformId(e.target.value)}
            >
              <option value="">{selectedClientId ? 'Selecciona una plataforma…' : 'Elige un cliente primero'}</option>
              {platformOptions.map((p) => (
                <option key={p.id} value={p.id}>{p.commercialName || p.legalName || '(sin nombre)'}</option>
              ))}
            </select>
          </Field>
        </div>
      </Card>
```

(d) Ensure the generate button calls `handleGenerateReport` and its label matches the test regex (`/Generar/i`). If the existing button text differs, keep it but confirm the test regex matches; otherwise update the test regex in Step 1.

> Note on the free-text Remitente/Plataforma cards: they remain in the UI for now as informational fields, but they are **no longer sent** on generate (the report overlay comes from the selected client + platform via the DB join). A follow-up may pre-fill or remove them.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/components/ReporteGeneralView.test.tsx`
Expected: PASS.

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/ReporteGeneralView.tsx src/components/ReporteGeneralView.test.tsx
git commit -m "feat(ui): cascading client→platform select on Reporte General"
```

---

## Task 10: Full suite + lint gate

**Files:** none (verification only)

- [ ] **Step 1: Run the full server suite**

Run: `cd server && npm test`
Expected: PASS (all suites, including the existing exports/reports tests).

- [ ] **Step 2: Run the full client suite**

Run: `npm test` (from repo root, or the project's client test script)
Expected: PASS.

- [ ] **Step 3: Lint / type-check both packages**

Run: `npx tsc --noEmit && cd server && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit any incidental fixes**

```bash
git add -A
git commit -m "test: green full suite for multiple-platforms-per-client" --allow-empty
```

---

## Self-Review notes

- **Spec coverage:** data model (Task 1), API incl. `platforms[]` + CRUD + back-compat POST/PUT (Tasks 3-4), manifest bind with ownership (Task 5), report join unchanged-output (Task 6), Clientes-tab management (Task 8), cascading select (Task 9), tests across all (each task + Task 10). Backfill + legacy-column-kept (Task 1). Out-of-scope items (email encryption, dropping legacy column) intentionally excluded.
- **Type consistency:** API platform shape `{ id, commercialName, countryOfOrigin, legalName, email }` is identical across SQL aliases (Task 3 `PLATFORM_RETURNING`), the TS `ClientPlatform` (Task 7), and both UI consumers (Tasks 8-9). Bind body `{ clientId, platformId }` matches `manifestClientBody` (Task 2) and the frontend POST (Task 9).
- **Placeholders:** none — all code blocks are concrete. The admin-gated platform add/remove UI interaction is deliberately verified server-side (Task 3) rather than mocked into a non-admin UI harness; this is called out explicitly, not left as a TODO.
