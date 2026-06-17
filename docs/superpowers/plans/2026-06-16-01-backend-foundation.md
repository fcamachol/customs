# Backend Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a self-hosted Express + PostgreSQL backend with authentication, role-based access, an append-only audit log, and file storage — the foundation every other sub-system depends on.

**Architecture:** Convert the repo into a monorepo (`client/`, `server/`, `shared/`). The `server/` is an Express/TypeScript REST API talking to PostgreSQL via `pg` with SQL migrations (`node-pg-migrate`). Auth uses bcrypt-hashed passwords + JWT bearer tokens. Every mutating request passes through audit middleware that writes an immutable log row. Files (manifests, pedimento PDFs, reports) are stored on a local volume with DB metadata rows.

**Tech Stack:** Node 22, Express 4, TypeScript 5.8, PostgreSQL, `pg`, `node-pg-migrate`, `bcrypt`, `jsonwebtoken`, `vitest`, `supertest`.

---

### Task 0: Monorepo + tooling setup

**Files:**
- Create: `server/package.json`, `server/tsconfig.json`, `server/vitest.config.ts`
- Create: `server/.env.example`
- Modify: root `package.json` (add workspaces + server scripts)
- Create: `shared/types/` (move-prep; actual move happens in plan 02)

- [ ] **Step 1: Create `server/package.json`**

```json
{
  "name": "@customs/server",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "tsx src/index.ts",
    "migrate": "node-pg-migrate --tsx -m migrations --envPath .env",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "bcrypt": "^5.1.1",
    "dotenv": "^17.2.3",
    "express": "^4.21.2",
    "jsonwebtoken": "^9.0.2",
    "pg": "^8.13.1"
  },
  "devDependencies": {
    "@types/bcrypt": "^5.0.2",
    "@types/express": "^4.17.21",
    "@types/jsonwebtoken": "^9.0.7",
    "@types/node": "^22.14.0",
    "@types/pg": "^8.11.10",
    "@types/supertest": "^6.0.2",
    "node-pg-migrate": "^7.7.1",
    "supertest": "^7.0.0",
    "tsx": "^4.21.0",
    "typescript": "~5.8.2",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 2: Create `server/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "types": ["node"],
    "outDir": "dist"
  },
  "include": ["src", "migrations", "test"]
}
```

- [ ] **Step 3: Create `server/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['./test/setup.ts'],
    fileParallelism: false, // tests share one test DB
  },
});
```

- [ ] **Step 4: Create `server/.env.example`**

```
DATABASE_URL=postgres://customs:customs@localhost:5432/customs
TEST_DATABASE_URL=postgres://customs:customs@localhost:5432/customs_test
JWT_SECRET=change-me-in-production
PORT=4000
FILE_STORAGE_DIR=./storage
```

- [ ] **Step 5: Install and verify**

Run: `cd server && npm install && npx tsc --noEmit`
Expected: installs cleanly, `tsc` exits 0 (no source files yet → no errors).

- [ ] **Step 6: Commit**

```bash
git add server/package.json server/tsconfig.json server/vitest.config.ts server/.env.example
git commit -m "chore(server): scaffold Express/Postgres backend tooling"
```

---

### Task 1: Database pool + test harness

**Files:**
- Create: `server/src/db/pool.ts`
- Create: `server/test/setup.ts`
- Create: `server/test/helpers/db.ts`

- [ ] **Step 1: Create the pool**

`server/src/db/pool.ts`:
```ts
import pg from 'pg';
import 'dotenv/config';

const connectionString =
  process.env.NODE_ENV === 'test'
    ? process.env.TEST_DATABASE_URL
    : process.env.DATABASE_URL;

export const pool = new pg.Pool({ connectionString });

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params as any[]);
}
```

- [ ] **Step 2: Create the test setup (runs migrations against the test DB)**

`server/test/setup.ts`:
```ts
import { execSync } from 'node:child_process';
import { afterAll, beforeAll } from 'vitest';
import { pool } from '../src/db/pool';

beforeAll(() => {
  process.env.NODE_ENV = 'test';
  execSync('node-pg-migrate --tsx -m migrations up', {
    env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL },
    stdio: 'inherit',
  });
});

afterAll(async () => {
  await pool.end();
});
```

- [ ] **Step 3: Create a truncation helper for test isolation**

`server/test/helpers/db.ts`:
```ts
import { pool } from '../../src/db/pool';

export async function truncateAll(): Promise<void> {
  await pool.query(
    `TRUNCATE users, audit_log, files RESTART IDENTITY CASCADE`,
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add server/src/db/pool.ts server/test/setup.ts server/test/helpers/db.ts
git commit -m "feat(server): add pg pool and vitest db harness"
```

---

### Task 2: Initial migration (users, audit_log, files)

**Files:**
- Create: `server/migrations/1700000000000_initial.ts`

- [ ] **Step 1: Write the migration**

`server/migrations/1700000000000_initial.ts`:
```ts
import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createExtension('pgcrypto', { ifNotExists: true });

  pgm.createTable('users', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    username: { type: 'text', notNull: true, unique: true },
    password_hash: { type: 'text', notNull: true },
    role: { type: 'text', notNull: true, check: "role IN ('capturista','admin','autoridad')" },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createTable('audit_log', {
    id: { type: 'bigserial', primaryKey: true },
    user_id: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    action: { type: 'text', notNull: true },
    entity: { type: 'text' },
    entity_id: { type: 'text' },
    before: { type: 'jsonb' },
    after: { type: 'jsonb' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  // Append-only: revoke UPDATE/DELETE at the app layer; index for authority queries.
  pgm.createIndex('audit_log', 'created_at');
  pgm.createIndex('audit_log', 'user_id');

  pgm.createTable('files', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    kind: { type: 'text', notNull: true, check: "kind IN ('manifest','pedimento_pdf','report')" },
    original_name: { type: 'text', notNull: true },
    storage_path: { type: 'text', notNull: true },
    size_bytes: { type: 'bigint', notNull: true },
    uploaded_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('files');
  pgm.dropTable('audit_log');
  pgm.dropTable('users');
}
```

- [ ] **Step 2: Create the local + test databases**

Run:
```bash
createdb customs 2>/dev/null; createdb customs_test 2>/dev/null
psql -d customs -c "CREATE ROLE customs LOGIN PASSWORD 'customs';" 2>/dev/null || true
cd server && npm run migrate up
```
Expected: "Migrations complete" for the `customs` DB.

- [ ] **Step 3: Run migration against test DB to verify it applies**

Run: `cd server && DATABASE_URL=$TEST_DATABASE_URL npm run migrate up`
Expected: tables `users`, `audit_log`, `files` created.

- [ ] **Step 4: Commit**

```bash
git add server/migrations/1700000000000_initial.ts
git commit -m "feat(server): initial schema — users, audit_log, files"
```

---

### Task 3: Password hashing

**Files:**
- Create: `server/src/auth/password.ts`
- Test: `server/test/auth/password.test.ts`

- [ ] **Step 1: Write the failing test**

`server/test/auth/password.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../../src/auth/password';

describe('password', () => {
  it('hashes and verifies a correct password', async () => {
    const hash = await hashPassword('s3cret!');
    expect(hash).not.toBe('s3cret!');
    expect(await verifyPassword('s3cret!', hash)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('s3cret!');
    expect(await verifyPassword('wrong', hash)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx vitest run test/auth/password.test.ts`
Expected: FAIL — cannot find module `../../src/auth/password`.

- [ ] **Step 3: Implement**

`server/src/auth/password.ts`:
```ts
import bcrypt from 'bcrypt';

const ROUNDS = 12;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, ROUNDS);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npx vitest run test/auth/password.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/auth/password.ts server/test/auth/password.test.ts
git commit -m "feat(server): bcrypt password hashing"
```

---

### Task 4: JWT tokens

**Files:**
- Create: `server/src/auth/token.ts`
- Test: `server/test/auth/token.test.ts`

- [ ] **Step 1: Write the failing test**

`server/test/auth/token.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { signToken, verifyToken } from '../../src/auth/token';

describe('token', () => {
  it('round-trips a payload', () => {
    const token = signToken({ userId: 'u1', role: 'admin' });
    const claims = verifyToken(token);
    expect(claims.userId).toBe('u1');
    expect(claims.role).toBe('admin');
  });

  it('throws on a tampered token', () => {
    expect(() => verifyToken('not.a.token')).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx vitest run test/auth/token.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`server/src/auth/token.ts`:
```ts
import jwt from 'jsonwebtoken';

export type Role = 'capturista' | 'admin' | 'autoridad';
export interface Claims { userId: string; role: Role; }

const SECRET = process.env.JWT_SECRET ?? 'change-me-in-production';

export function signToken(claims: Claims): string {
  return jwt.sign(claims, SECRET, { expiresIn: '8h' });
}

export function verifyToken(token: string): Claims {
  return jwt.verify(token, SECRET) as Claims;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npx vitest run test/auth/token.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/auth/token.ts server/test/auth/token.test.ts
git commit -m "feat(server): JWT sign/verify"
```

---

### Task 5: Audit-log service

**Files:**
- Create: `server/src/services/audit.ts`
- Test: `server/test/services/audit.test.ts`

- [ ] **Step 1: Write the failing test**

`server/test/services/audit.test.ts`:
```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { recordAudit } from '../../src/services/audit';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

describe('audit', () => {
  beforeEach(truncateAll);

  it('writes an append-only audit row', async () => {
    await recordAudit({ userId: null, action: 'LOGIN', entity: 'session' });
    const { rows } = await query('SELECT action, entity FROM audit_log');
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('LOGIN');
    expect(rows[0].entity).toBe('session');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx vitest run test/services/audit.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`server/src/services/audit.ts`:
```ts
import { query } from '../db/pool';

export interface AuditEntry {
  userId: string | null;
  action: string;
  entity?: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
}

export async function recordAudit(e: AuditEntry): Promise<void> {
  await query(
    `INSERT INTO audit_log (user_id, action, entity, entity_id, before, after)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      e.userId,
      e.action,
      e.entity ?? null,
      e.entityId ?? null,
      e.before ? JSON.stringify(e.before) : null,
      e.after ? JSON.stringify(e.after) : null,
    ],
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npx vitest run test/services/audit.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/audit.ts server/test/services/audit.test.ts
git commit -m "feat(server): append-only audit-log service"
```

---

### Task 6: Auth middleware (requireAuth + requireRole)

**Files:**
- Create: `server/src/auth/middleware.ts`
- Test: `server/test/auth/middleware.test.ts`

- [ ] **Step 1: Write the failing test**

`server/test/auth/middleware.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { requireAuth, requireRole } from '../../src/auth/middleware';
import { signToken } from '../../src/auth/token';

function mockRes() {
  const res = {} as Response;
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

describe('auth middleware', () => {
  it('rejects requests with no token', () => {
    const req = { headers: {} } as Request;
    const res = mockRes();
    const next = vi.fn();
    requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('attaches claims and calls next on a valid token', () => {
    const token = signToken({ userId: 'u1', role: 'admin' });
    const req = { headers: { authorization: `Bearer ${token}` } } as Request;
    const res = mockRes();
    const next = vi.fn();
    requireAuth(req, res, next);
    expect(next).toHaveBeenCalled();
    expect((req as any).user.userId).toBe('u1');
  });

  it('blocks a role that is not allowed', () => {
    const req = { user: { userId: 'u1', role: 'capturista' } } as any;
    const res = mockRes();
    const next = vi.fn();
    requireRole('admin')(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx vitest run test/auth/middleware.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`server/src/auth/middleware.ts`:
```ts
import type { NextFunction, Request, Response } from 'express';
import { verifyToken, type Claims, type Role } from './token';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { user?: Claims; }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing bearer token' });
    return;
  }
  try {
    req.user = verifyToken(header.slice('Bearer '.length));
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user || !roles.includes(req.user.role)) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    next();
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npx vitest run test/auth/middleware.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/auth/middleware.ts server/test/auth/middleware.test.ts
git commit -m "feat(server): requireAuth + requireRole middleware"
```

---

### Task 7: App factory + auth routes (login, me, create user)

**Files:**
- Create: `server/src/app.ts`
- Create: `server/src/routes/auth.ts`
- Create: `server/src/routes/users.ts`
- Test: `server/test/routes/auth.test.ts`

- [ ] **Step 1: Write the failing integration test**

`server/test/routes/auth.test.ts`:
```ts
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { hashPassword } from '../../src/auth/password';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

const app = createApp();

async function seedAdmin() {
  const hash = await hashPassword('adminpass');
  await query(
    `INSERT INTO users (username, password_hash, role) VALUES ($1,$2,'admin')`,
    ['admin', hash],
  );
}

describe('auth routes', () => {
  beforeEach(async () => {
    await truncateAll();
    await seedAdmin();
  });

  it('logs in with valid credentials and returns a token', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'adminpass' });
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
    expect(res.body.user.role).toBe('admin');
  });

  it('rejects bad credentials with 401', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'nope' });
    expect(res.status).toBe(401);
  });

  it('writes a LOGIN audit row on success', async () => {
    await request(app).post('/api/auth/login').send({ username: 'admin', password: 'adminpass' });
    const { rows } = await query(`SELECT * FROM audit_log WHERE action='LOGIN'`);
    expect(rows).toHaveLength(1);
  });

  it('returns the current user from /me with a valid token', async () => {
    const login = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'adminpass' });
    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${login.body.token}`);
    expect(res.status).toBe(200);
    expect(res.body.username).toBe('admin');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx vitest run test/routes/auth.test.ts`
Expected: FAIL — cannot find `../../src/app`.

- [ ] **Step 3: Implement the auth routes**

`server/src/routes/auth.ts`:
```ts
import { Router } from 'express';
import { query } from '../db/pool';
import { verifyPassword } from '../auth/password';
import { signToken } from '../auth/token';
import { requireAuth } from '../auth/middleware';
import { recordAudit } from '../services/audit';

export const authRouter = Router();

authRouter.post('/login', async (req, res) => {
  const { username, password } = req.body ?? {};
  const { rows } = await query(
    `SELECT id, username, password_hash, role FROM users WHERE username=$1`,
    [username],
  );
  const user = rows[0];
  if (!user || !(await verifyPassword(password ?? '', user.password_hash))) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }
  await recordAudit({ userId: user.id, action: 'LOGIN', entity: 'session' });
  const token = signToken({ userId: user.id, role: user.role });
  res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
});

authRouter.get('/me', requireAuth, async (req, res) => {
  const { rows } = await query(
    `SELECT id, username, role, created_at FROM users WHERE id=$1`,
    [req.user!.userId],
  );
  res.json(rows[0]);
});
```

- [ ] **Step 4: Implement the users route (admin-only create)**

`server/src/routes/users.ts`:
```ts
import { Router } from 'express';
import { query } from '../db/pool';
import { hashPassword } from '../auth/password';
import { requireAuth, requireRole } from '../auth/middleware';
import { recordAudit } from '../services/audit';

export const usersRouter = Router();

usersRouter.post('/', requireAuth, requireRole('admin'), async (req, res) => {
  const { username, password, role } = req.body ?? {};
  if (!['capturista', 'admin', 'autoridad'].includes(role)) {
    res.status(400).json({ error: 'Invalid role' });
    return;
  }
  const hash = await hashPassword(password);
  const { rows } = await query(
    `INSERT INTO users (username, password_hash, role) VALUES ($1,$2,$3)
     RETURNING id, username, role`,
    [username, hash, role],
  );
  await recordAudit({ userId: req.user!.userId, action: 'CREATE_USER', entity: 'user', entityId: rows[0].id, after: rows[0] });
  res.status(201).json(rows[0]);
});
```

- [ ] **Step 5: Implement the app factory**

`server/src/app.ts`:
```ts
import express, { type Express } from 'express';
import { authRouter } from './routes/auth';
import { usersRouter } from './routes/users';

export function createApp(): Express {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api/auth', authRouter);
  app.use('/api/users', usersRouter);
  return app;
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `cd server && npx vitest run test/routes/auth.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add server/src/app.ts server/src/routes/auth.ts server/src/routes/users.ts server/test/routes/auth.test.ts
git commit -m "feat(server): app factory + login/me/create-user routes"
```

---

### Task 8: File-storage service

**Files:**
- Create: `server/src/storage/files.ts`
- Test: `server/test/storage/files.test.ts`

- [ ] **Step 1: Write the failing test**

`server/test/storage/files.test.ts`:
```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { saveFile } from '../../src/storage/files';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

describe('file storage', () => {
  beforeEach(truncateAll);

  it('saves bytes to disk and records metadata', async () => {
    const buf = Buffer.from('hello manifest');
    const meta = await saveFile({
      kind: 'manifest',
      originalName: 'm.xlsx',
      bytes: buf,
      uploadedBy: null,
    });
    expect(meta.id).toBeTruthy();
    const onDisk = await readFile(meta.storagePath);
    expect(onDisk.toString()).toBe('hello manifest');
    const { rows } = await query('SELECT kind, size_bytes FROM files WHERE id=$1', [meta.id]);
    expect(rows[0].kind).toBe('manifest');
    expect(Number(rows[0].size_bytes)).toBe(buf.length);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx vitest run test/storage/files.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`server/src/storage/files.ts`:
```ts
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { query } from '../db/pool';

export type FileKind = 'manifest' | 'pedimento_pdf' | 'report';

export interface SaveFileInput {
  kind: FileKind;
  originalName: string;
  bytes: Buffer;
  uploadedBy: string | null;
}

export interface FileMeta {
  id: string;
  kind: FileKind;
  originalName: string;
  storagePath: string;
  sizeBytes: number;
}

const STORAGE_DIR = resolve(process.env.FILE_STORAGE_DIR ?? './storage');
const MAX_BYTES = 100 * 1024 * 1024; // 100 MB (pedimento PDFs run 40–80 MB)

export async function saveFile(input: SaveFileInput): Promise<FileMeta> {
  if (input.bytes.length > MAX_BYTES) {
    throw new Error(`File exceeds ${MAX_BYTES} bytes`);
  }
  const id = randomUUID();
  const dir = join(STORAGE_DIR, input.kind);
  await mkdir(dir, { recursive: true });
  const storagePath = join(dir, `${id}-${input.originalName}`);
  await writeFile(storagePath, input.bytes);
  await query(
    `INSERT INTO files (id, kind, original_name, storage_path, size_bytes, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, input.kind, input.originalName, storagePath, input.bytes.length, input.uploadedBy],
  );
  return { id, kind: input.kind, originalName: input.originalName, storagePath, sizeBytes: input.bytes.length };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npx vitest run test/storage/files.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Add storage dir to .gitignore**

Append to root `.gitignore`:
```
server/storage/
server/.env
```

- [ ] **Step 6: Commit**

```bash
git add server/src/storage/files.ts server/test/storage/files.test.ts .gitignore
git commit -m "feat(server): local file-storage service with metadata"
```

---

### Task 9: Server entrypoint + dev wiring

**Files:**
- Create: `server/src/index.ts`
- Modify: root `package.json` (add `server` scripts)

- [ ] **Step 1: Create the entrypoint**

`server/src/index.ts`:
```ts
import 'dotenv/config';
import { createApp } from './app';

const port = Number(process.env.PORT ?? 4000);
createApp().listen(port, () => {
  console.log(`API listening on :${port}`);
});
```

- [ ] **Step 2: Add root scripts**

In root `package.json` `"scripts"`, add:
```json
"server:dev": "npm --prefix server run dev",
"server:test": "npm --prefix server test"
```

- [ ] **Step 3: Smoke-test the running server**

Run: `cd server && (npm run dev &) && sleep 2 && curl -s localhost:4000/api/health && kill %1`
Expected: `{"ok":true}`

- [ ] **Step 4: Run the full server test suite**

Run: `cd server && npm test`
Expected: all suites PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/index.ts package.json
git commit -m "feat(server): http entrypoint + root dev/test scripts"
```

---

## Self-Review Notes (coverage of spec §3.1 + compliance pillars)
- Auth + roles → Tasks 4, 6, 7. Audit trail → Tasks 2, 5, plus writes in 7. File storage → Tasks 2, 8. PostgreSQL schema/migrations → Tasks 1, 2. App-backed persistence foundation → Task 7/9 (consumed by plans 02–05).
- Append-only audit: enforced by service-only writes (no UPDATE/DELETE paths exposed); a DB-level trigger to block UPDATE/DELETE is added in plan 05 hardening.
- Types `Role`, `Claims`, `FileKind`, `FileMeta`, `AuditEntry` are defined once here and reused by later plans.
