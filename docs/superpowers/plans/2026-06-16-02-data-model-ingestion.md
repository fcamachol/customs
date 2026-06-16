# Data Model & Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand the data model to the full `LayOut_sistema` 34-column schema (consignee block, sender, platform sections, arrival date, split aduanas), harden the "any Excel" manifest parser so no required column is silently dropped, and ingest large pedimento PDFs attached to records.

**Architecture:** A `shared/` package holds the canonical TypeScript types used by client and server. The manifest parser is moved to `shared/` and extended with synonym tables for the new columns. The server gains a `manifests`/`records` schema and a PDF-ingestion endpoint that stores the file via the plan-01 file service and parses header metadata.

**Tech Stack:** TypeScript, `xlsx` (already present), `pdf-parse` (new) for server-side pedimento text extraction, `pg`, `vitest`.

**Depends on:** Plan 01 (backend foundation: pool, migrations, file storage, auth).

---

### Task 1: Create the `shared/` types package and the expanded shipment model

**Files:**
- Create: `shared/package.json`, `shared/tsconfig.json`
- Create: `shared/types/shipment.ts`
- Modify: `src/types/t1.ts` (re-export from shared to avoid duplication)

- [ ] **Step 1: Create `shared/package.json`**

```json
{
  "name": "@customs/shared",
  "private": true,
  "type": "module",
  "main": "types/index.ts"
}
```

- [ ] **Step 2: Create `shared/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "declaration": true
  },
  "include": ["types"]
}
```

- [ ] **Step 3: Define the full 34-column shipment model**

`shared/types/shipment.ts`:
```ts
// LayOut_sistema.xlsx — 34-column flat register, grouped by section.

export interface ConsigneeData {        // cols 17–25
  name: string;
  rfc: string;
  curp?: string;                         // 18-char
  foreignTaxId?: string;                 // ID fiscal país de residencia
  socialSecurity?: string;
  passport?: string;
  address?: string;
  phone?: string;
  email?: string;
}

export interface SenderData {            // cols 26–30 (NEW)
  name: string;
  taxId?: string;
  address?: string;
  phone?: string;
  email?: string;
}

export interface PlatformData {          // cols 31–34 (NEW)
  commercialName: string;
  countryOfOrigin?: string;
  legalName?: string;
  email?: string;
}

export interface ShipmentCore {          // cols 1–16
  t1RegistryId?: string;                 // col 1 — No. de registro T1
  patente?: string;                      // col 2
  pedimentoNumber?: string;              // col 3
  description: string;                   // col 4
  hsCode: string;                        // col 5 (fracción)
  quantity: number;                      // col 6
  unit: string;                          // col 7
  customsValueUsd: number;               // col 8
  currency: string;                      // col 9
  originCountry: string;                 // col 10
  arrivalDate?: string;                  // col 11 — fecha de arribo (YYYY-MM-DD)
  guideId: string;                       // col 12 — guía aérea
  appliedRate?: number;                  // col 13 — tasa global
  rrnaNote?: string;                     // col 14
  customsEntryCode?: string;             // col 15 — aduana de ENTRADA
  customsClearanceCode?: string;         // col 16 — aduana de DESPACHO
}

export interface Shipment extends ShipmentCore {
  id: string;
  mawbReference: string;
  consignee: ConsigneeData;
  sender: SenderData;
  platform: PlatformData;
}
```

- [ ] **Step 4: Re-export from the old location for backward compat**

Append to `src/types/t1.ts`:
```ts
// Canonical model now lives in shared/. Re-export for existing imports.
export * from '../../shared/types/shipment';
```

- [ ] **Step 5: Verify the client still type-checks**

Run: `npm run lint`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add shared/ src/types/t1.ts
git commit -m "feat(shared): full 34-column shipment model (consignee/sender/platform)"
```

---

### Task 2: Header synonym table covering all 34 columns

**Files:**
- Create: `shared/parsing/headerSynonyms.ts`
- Test: `shared/parsing/headerSynonyms.test.ts`

- [ ] **Step 1: Write the failing test**

`shared/parsing/headerSynonyms.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { resolveHeader } from './headerSynonyms';

describe('resolveHeader', () => {
  it('maps Spanish consignee headers', () => {
    expect(resolveHeader('RFC')).toBe('consignee.rfc');
    expect(resolveHeader('CURP')).toBe('consignee.curp');
    expect(resolveHeader('Domicilio')).toBe('consignee.address');
  });
  it('maps sender (remitente) headers', () => {
    expect(resolveHeader('Remitente Nombre')).toBe('sender.name');
    expect(resolveHeader('Id fiscal del remitente')).toBe('sender.taxId');
  });
  it('maps platform headers', () => {
    expect(resolveHeader('Nombre comercial')).toBe('platform.commercialName');
    expect(resolveHeader('País de origen')).toBe('platform.countryOfOrigin');
  });
  it('maps arrival date', () => {
    expect(resolveHeader('Fecha de arribo a territorio nacional')).toBe('core.arrivalDate');
  });
  it('returns null for unknown headers', () => {
    expect(resolveHeader('Columna Rara')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd shared && npx vitest run parsing/headerSynonyms.test.ts` (add a minimal `shared/vitest.config.ts` mirroring server's if absent)
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`shared/parsing/headerSynonyms.ts`:
```ts
// Maps a raw spreadsheet header (any casing/accents) to a canonical path.
const TABLE: Record<string, string> = {
  // core
  'no de registro t1': 'core.t1RegistryId',
  'patente': 'core.patente',
  'no pedimento': 'core.pedimentoNumber',
  'descripcion de la mercancia': 'core.description',
  'fraccion arancelaria': 'core.hsCode',
  'cantidad de la mercancia': 'core.quantity',
  'unidad de medida': 'core.unit',
  'valor en aduana declarado': 'core.customsValueUsd',
  'moneda': 'core.currency',
  'pais de procedencia': 'core.originCountry',
  'fecha de arribo a territorio nacional': 'core.arrivalDate',
  'no de guia aerea o documento de transporte': 'core.guideId',
  'tasa global o cuota aplicada': 'core.appliedRate',
  'regulaciones y restricciones no arancelarias': 'core.rrnaNote',
  'clave de aduana de entrada': 'core.customsEntryCode',
  'clave de aduana de despacho': 'core.customsClearanceCode',
  // consignee
  'nombre denominacion o razon social': 'consignee.name',
  'rfc': 'consignee.rfc',
  'curp': 'consignee.curp',
  'id fiscal de pais de residencia': 'consignee.foreignTaxId',
  'no de seguridad social': 'consignee.socialSecurity',
  'no de pasaporte': 'consignee.passport',
  'domicilio': 'consignee.address',
  'telefono': 'consignee.phone',
  'correo electronico': 'consignee.email',
  // sender (remitente)
  'remitente nombre': 'sender.name',
  'id fiscal del remitente': 'sender.taxId',
  'remitente domicilio': 'sender.address',
  'remitente telefono': 'sender.phone',
  'remitente correo': 'sender.email',
  // platform
  'nombre comercial': 'platform.commercialName',
  'pais de origen': 'platform.countryOfOrigin',
  'denominacion o razon social': 'platform.legalName',
  'plataforma correo': 'platform.email',
};

function normalize(h: string): string {
  return h
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function resolveHeader(raw: string): string | null {
  return TABLE[normalize(raw)] ?? null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd shared && npx vitest run parsing/headerSynonyms.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add shared/parsing/headerSynonyms.ts shared/parsing/headerSynonyms.test.ts shared/vitest.config.ts
git commit -m "feat(shared): full 34-column header synonym resolver"
```

---

### Task 3: Manifest parser building full Shipment rows (with data-cleaning)

**Files:**
- Create: `shared/parsing/manifestParser.ts`
- Test: `shared/parsing/manifestParser.test.ts`

- [ ] **Step 1: Write the failing test**

`shared/parsing/manifestParser.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { parseManifestRows } from './manifestParser';

const rows = [
  {
    'RFC': 'TOMM020922D40',
    'Nombre denominación o razón social': 'Juan Pérez',
    'Domicilio': 'Calle 1\nDepto 2', // multi-line cell
    'Descripción de la mercancía': 'TRAJE',
    'Cantidad de la mercancía': '1',
    'Valor en Aduana declarado': '120.5',
    'Moneda': 'USD',
    'País de procedencia': 'cn',                 // lowercase
    'No. de guía aérea o documento de transporte': '369-94268462',
    'Remitente Nombre': 'SHEIN HK',
    'Nombre comercial': 'SHEIN',
  },
];

describe('parseManifestRows', () => {
  it('maps known columns into a Shipment and uppercases country', () => {
    const out = parseManifestRows(rows, 'MAWB-1');
    expect(out.shipments[0].consignee.rfc).toBe('TOMM020922D40');
    expect(out.shipments[0].consignee.address).toBe('Calle 1 Depto 2');
    expect(out.shipments[0].originCountry).toBe('CN');
    expect(out.shipments[0].sender.name).toBe('SHEIN HK');
    expect(out.shipments[0].platform.commercialName).toBe('SHEIN');
  });

  it('reports unmapped headers instead of dropping silently', () => {
    const out = parseManifestRows([{ 'Columna Rara': 'x', 'RFC': 'AAA010101AAA' }], 'M');
    expect(out.unmappedHeaders).toContain('Columna Rara');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd shared && npx vitest run parsing/manifestParser.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`shared/parsing/manifestParser.ts`:
```ts
import { randomUUID } from 'node:crypto';
import type { Shipment } from '../types/shipment';
import { resolveHeader } from './headerSynonyms';

export interface ParseResult {
  shipments: Shipment[];
  unmappedHeaders: string[];
}

function cleanCell(v: unknown): string {
  return String(v ?? '').replace(/\s*\n\s*/g, ' ').trim();
}

function setPath(obj: any, path: string, value: string): void {
  const [group, key] = path.split('.');
  obj[group][key] = value;
}

function blankShipment(mawb: string): Shipment {
  return {
    id: randomUUID(), mawbReference: mawb,
    description: '', hsCode: '', quantity: 0, unit: '', customsValueUsd: 0,
    currency: '', originCountry: '', guideId: '',
    consignee: { name: '', rfc: '' }, sender: { name: '' }, platform: { commercialName: '' },
  } as Shipment;
}

export function parseManifestRows(rows: Record<string, unknown>[], mawb: string): ParseResult {
  const unmapped = new Set<string>();
  const shipments = rows.map((row) => {
    const s: any = blankShipment(mawb);
    for (const [rawHeader, raw] of Object.entries(row)) {
      const path = resolveHeader(rawHeader);
      if (!path) { unmapped.add(rawHeader); continue; }
      let value = cleanCell(raw);
      if (path === 'core.originCountry') value = value.toUpperCase();
      if (path === 'core.quantity') { s.quantity = Number(value) || 0; continue; }
      if (path === 'core.customsValueUsd') { s.customsValueUsd = Number(value) || 0; continue; }
      if (path === 'core.appliedRate') { s.appliedRate = Number(value); continue; }
      const [group] = path.split('.');
      if (group === 'core') s[path.split('.')[1]] = value;
      else setPath(s, path, value);
    }
    return s as Shipment;
  });
  return { shipments, unmappedHeaders: [...unmapped] };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd shared && npx vitest run parsing/manifestParser.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add shared/parsing/manifestParser.ts shared/parsing/manifestParser.test.ts
git commit -m "feat(shared): manifest parser → full Shipment with cleaning + unmapped report"
```

---

### Task 4: `manifests` + `shipments` migration

**Files:**
- Create: `server/migrations/1700000100000_manifests.ts`

- [ ] **Step 1: Write the migration**

`server/migrations/1700000100000_manifests.ts`:
```ts
import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('manifests', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    mawb_reference: { type: 'text', notNull: true },
    client_name: { type: 'text' },               // the "Cliente" half of MAWB – Cliente
    file_id: { type: 'uuid', references: 'files', onDelete: 'SET NULL' },
    created_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('manifests', ['mawb_reference', 'client_name']);

  pgm.createTable('shipments', {
    id: { type: 'uuid', primaryKey: true },
    manifest_id: { type: 'uuid', notNull: true, references: 'manifests', onDelete: 'CASCADE' },
    data: { type: 'jsonb', notNull: true },        // the full Shipment object
    risk_score: { type: 'integer' },               // filled by plan 03
    risk_color: { type: 'text' },                  // 'verde' | 'amarillo' | 'rojo'
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('shipments', 'manifest_id');
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('shipments');
  pgm.dropTable('manifests');
}
```

- [ ] **Step 2: Apply to both DBs**

Run: `cd server && npm run migrate up && DATABASE_URL=$TEST_DATABASE_URL npm run migrate up`
Expected: tables created on both.

- [ ] **Step 3: Update `truncateAll` helper to include new tables**

Modify `server/test/helpers/db.ts` TRUNCATE list to:
`users, audit_log, files, manifests, shipments`

- [ ] **Step 4: Commit**

```bash
git add server/migrations/1700000100000_manifests.ts server/test/helpers/db.ts
git commit -m "feat(server): manifests + shipments schema"
```

---

### Task 5: Manifest upload endpoint (parse + persist + report unmapped)

**Files:**
- Create: `server/src/routes/manifests.ts`
- Modify: `server/src/app.ts` (mount router)
- Test: `server/test/routes/manifests.test.ts`

- [ ] **Step 1: Write the failing test**

`server/test/routes/manifests.test.ts`:
```ts
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { hashPassword } from '../../src/auth/password';
import { signToken } from '../../src/auth/token';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

const app = createApp();
let token: string;

beforeEach(async () => {
  await truncateAll();
  const hash = await hashPassword('p');
  const { rows } = await query(
    `INSERT INTO users (username,password_hash,role) VALUES ('cap',$1,'capturista') RETURNING id`, [hash]);
  token = signToken({ userId: rows[0].id, role: 'capturista' });
});

describe('POST /api/manifests', () => {
  it('parses rows, persists shipments, and returns unmapped headers', async () => {
    const res = await request(app)
      .post('/api/manifests')
      .set('Authorization', `Bearer ${token}`)
      .send({
        mawbReference: '369-1',
        clientName: 'Cliente A',
        rows: [{ 'RFC': 'AAA010101AAA', 'Descripción de la mercancía': 'TRAJE', 'Columna Rara': 'x' }],
      });
    expect(res.status).toBe(201);
    expect(res.body.shipmentCount).toBe(1);
    expect(res.body.unmappedHeaders).toContain('Columna Rara');
    const { rows } = await query('SELECT count(*)::int AS n FROM shipments');
    expect(rows[0].n).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx vitest run test/routes/manifests.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the router**

`server/src/routes/manifests.ts`:
```ts
import { Router } from 'express';
import { query } from '../db/pool';
import { requireAuth } from '../auth/middleware';
import { recordAudit } from '../services/audit';
import { parseManifestRows } from '../../../shared/parsing/manifestParser';

export const manifestsRouter = Router();

manifestsRouter.post('/', requireAuth, async (req, res) => {
  const { mawbReference, clientName, rows } = req.body ?? {};
  if (!mawbReference || !Array.isArray(rows)) {
    res.status(400).json({ error: 'mawbReference and rows[] required' });
    return;
  }
  const { shipments, unmappedHeaders } = parseManifestRows(rows, mawbReference);

  const m = await query(
    `INSERT INTO manifests (mawb_reference, client_name, created_by) VALUES ($1,$2,$3) RETURNING id`,
    [mawbReference, clientName ?? null, req.user!.userId],
  );
  const manifestId = m.rows[0].id;
  for (const s of shipments) {
    await query(`INSERT INTO shipments (id, manifest_id, data) VALUES ($1,$2,$3)`,
      [s.id, manifestId, JSON.stringify(s)]);
  }
  await recordAudit({ userId: req.user!.userId, action: 'UPLOAD_MANIFEST', entity: 'manifest', entityId: manifestId, after: { mawbReference, shipmentCount: shipments.length } });
  res.status(201).json({ manifestId, shipmentCount: shipments.length, unmappedHeaders });
});
```

- [ ] **Step 4: Mount in `app.ts`**

Add to `createApp()`:
```ts
import { manifestsRouter } from './routes/manifests';
// ...
app.use('/api/manifests', manifestsRouter);
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd server && npx vitest run test/routes/manifests.test.ts`
Expected: PASS (1 test).

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/manifests.ts server/src/app.ts server/test/routes/manifests.test.ts
git commit -m "feat(server): manifest upload — parse, persist, report unmapped"
```

---

### Task 6: Pedimento-PDF ingestion endpoint

**Files:**
- Create: `server/src/routes/pedimentoUpload.ts`
- Modify: `server/package.json` (add `pdf-parse`, `multer`), `server/src/app.ts`
- Test: `server/test/routes/pedimentoUpload.test.ts`

- [ ] **Step 1: Add deps**

Run: `cd server && npm i pdf-parse multer && npm i -D @types/multer`
Expected: installs.

- [ ] **Step 2: Write the failing test** (uses a tiny in-repo sample PDF buffer)

`server/test/routes/pedimentoUpload.test.ts`:
```ts
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Buffer } from 'node:buffer';
import { createApp } from '../../src/app';
import { hashPassword } from '../../src/auth/password';
import { signToken } from '../../src/auth/token';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

const app = createApp();
let token: string; let manifestId: string;

const MINIMAL_PDF = Buffer.from(
  '%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
  '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n' +
  'trailer<</Root 1 0 R>>\n%%EOF', 'latin1');

beforeEach(async () => {
  await truncateAll();
  const hash = await hashPassword('p');
  const u = await query(`INSERT INTO users (username,password_hash,role) VALUES ('c',$1,'capturista') RETURNING id`, [hash]);
  token = signToken({ userId: u.rows[0].id, role: 'capturista' });
  const m = await query(`INSERT INTO manifests (mawb_reference) VALUES ('369-1') RETURNING id`);
  manifestId = m.rows[0].id;
});

describe('POST /api/manifests/:id/pedimento-pdf', () => {
  it('stores the PDF and links it to the manifest', async () => {
    const res = await request(app)
      .post(`/api/manifests/${manifestId}/pedimento-pdf`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', MINIMAL_PDF, 'pedimento.pdf');
    expect(res.status).toBe(201);
    expect(res.body.fileId).toBeTruthy();
    const { rows } = await query('SELECT kind FROM files WHERE id=$1', [res.body.fileId]);
    expect(rows[0].kind).toBe('pedimento_pdf');
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd server && npx vitest run test/routes/pedimentoUpload.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

`server/src/routes/pedimentoUpload.ts`:
```ts
import { Router } from 'express';
import multer from 'multer';
import { requireAuth } from '../auth/middleware';
import { saveFile } from '../storage/files';
import { query } from '../db/pool';
import { recordAudit } from '../services/audit';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });
export const pedimentoUploadRouter = Router();

pedimentoUploadRouter.post('/:id/pedimento-pdf', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) { res.status(400).json({ error: 'file required' }); return; }
  const meta = await saveFile({
    kind: 'pedimento_pdf', originalName: req.file.originalname,
    bytes: req.file.buffer, uploadedBy: req.user!.userId,
  });
  await query('UPDATE manifests SET file_id=$1 WHERE id=$2', [meta.id, req.params.id]);
  await recordAudit({ userId: req.user!.userId, action: 'ATTACH_PEDIMENTO_PDF', entity: 'manifest', entityId: req.params.id, after: { fileId: meta.id } });
  res.status(201).json({ fileId: meta.id });
});
```

- [ ] **Step 5: Mount in `app.ts`**

```ts
import { pedimentoUploadRouter } from './routes/pedimentoUpload';
app.use('/api/manifests', pedimentoUploadRouter);
```

- [ ] **Step 6: Run to verify it passes**

Run: `cd server && npx vitest run test/routes/pedimentoUpload.test.ts`
Expected: PASS (1 test).

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/pedimentoUpload.ts server/src/app.ts server/package.json server/package-lock.json server/test/routes/pedimentoUpload.test.ts
git commit -m "feat(server): pedimento-PDF ingestion attached to manifest"
```

---

## Self-Review Notes (coverage of spec §3.2)
- Full 34-column model (consignee/sender/platform, arrival date, split aduanas, T1 registry id) → Task 1. Sender + platform sections were the two entirely-missing layout sections.
- Hardened parser (synonyms for sender/platform/CURP/arrival; multi-line address join; lowercase country uppercased; unmapped-headers report so nothing is silently dropped) → Tasks 2, 3, 5.
- Large pedimento-PDF ingestion attached to a record → Task 6.
- Types `Shipment`, `ConsigneeData`, `SenderData`, `PlatformData`, `ShipmentCore` defined once in `shared/` and reused by plans 03–05. `shipments.data` jsonb stores the full object; `risk_score`/`risk_color` columns are populated by plan 03.
