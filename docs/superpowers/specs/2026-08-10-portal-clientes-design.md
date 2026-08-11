# Portal de Clientes — Design Brainstorm

**Date:** 2026-08-10 · **Status:** design only, no code changes · **Goal:** client (customer) users with tenant-isolated, real-time visibility of their own data.

**The one-sentence version:** put client users in the existing `users` table so they inherit revocation and the audit chain, then give them a small, purpose-built, read-only `/api/portal/*` surface that a non-portal token cannot enter and a portal token cannot leave, scope it with a predicate that is strictly tighter than the internal `COALESCE` — unattributed cargo on a shared MAWB belongs to nobody — whitelist every event and field they see because the ledger vocabulary is unenforced, ship it as a separate Vite bundle so the risk engine never reaches a customer's browser, and start with ETag polling while building toward SSE fed by the append-only ledger.

---

## 0. Grounding: what the code actually says (verified)

**The PRD already planned this.** `docs/PRD_sistema_operaciones.md:222` lists the role:

| **`cliente`** | **no — fase 3** | portal en inglés: estado de sus guías y sus requerimientos de riesgo |

and line 1208 schedules "Portal del cliente en ingles :f3b, 2026-09-07, 10d". `docs/PRD_sistema_operaciones_agora.md:418` records open question **Q20**: *"¿Se usa el portal de contactos de AGORA para el portal del cliente en inglés, o se construye en aduanas?"* — AGORA's `contacts` table has Devise columns and a `portal_role`. **This document answers Q20: build it here** — a parallel auth stack in AGORA would fracture the audit actor identity and duplicate the tenant model that already lives in this schema.

**`SEMAFOROS` is already client-facing.** `shared/operaciones/estados.ts`: *"English on purpose — the client reads this value and clients are mostly Chinese (PRD-02 decision D16). Do not localize it to verde/rojo."*

**The "effective client" expression already exists.** Four call sites independently converged on:

```sql
LEFT JOIN clients c ON c.id = COALESCE(g.client_id, o.client_id)
```

(`server/src/routes/pods.ts:156`, `despachos.ts:447`, `despachos.ts:1948`, `facturacion.ts:983`; as a predicate at `facturacion.ts:234`). That is the tenant key — but the portal must tighten it (§2.4).

**`operacion_eventos.tipo` has no CHECK constraint, and the codebase knows it.** From `shared/operaciones/estados.ts`:

> *"`operacion_eventos.tipo` has NO CHECK — only `origen` does. So TIPOS_EVENTO is enforced by nothing but reading, which is exactly how four REQUERIMIENTO_* types ended up being written to the ledger for months without appearing here."*

This single fact decides whitelist-vs-blacklist (§3), permanently.

**`visibleSectionsFor` fails OPEN.** `src/nav.ts` returns the **capturista** section set for any unrecognized role string — such as `'cliente'`. Combined with `GET /api/operaciones` being `requireAuth`-only (no `requireRole`), a `cliente` logging into today's SPA would be handed Torre de Control showing **every client's operations**. This is the most dangerous latent interaction in the repo; it drives the `aud` claim (§2) and the SPA split (§5).

**`GET /api/files/:id` is `requireAuth` only** (`server/src/routes/files.ts`). Any authenticated user — including today's `tramitador` — can download any file id: PODs, facturas, convenios, prealerta `.eml` originals, pedimento PDFs, risk analyses. Pre-existing hole; the portal makes it unacceptable (§6.4).

**`server/scripts/resetData.ts` truncates every public table except `users` and `pgmigrations`, with `CASCADE`.** Sharp interaction with `users.client_id` — see §8.5. It is the strongest single argument for one specific schema decision.

---

## 1. Identity model

### 1.1 The three options

**(a) New role `cliente` + `users.client_id` column.**
The role vocabulary was extended once before, by migration, with a full precedent to copy (`1700004500000_campo.ts:25` added `tramitador`). Everything downstream already exists:

- `requireAuth` does one indexed PK lookup for `token_version` — client sessions get revocation for free.
- `POST /api/auth/logout` bumps `token_version` — logout-all for free.
- `loginLimiter` keyed on `ip:username` — brute-force protection for free.
- `audit_log.user_id` is `uuid REFERENCES users` — **client actions are auditable with zero schema change.**
- bcrypt-12, `POST /api/users` admin creation path, `PATCH /api/users/:id/role`.

Cost: `users` gains a nullable column meaningful for exactly one role, guarded by a CHECK.

**(b) Separate `client_users` table.**
Cleaner conceptually, but forces a **parallel auth stack**: a second token verify path, second `requireAuth`, second rate limiter key, and — critically — **`audit_log.user_id` cannot reference it**. You'd need a polymorphic actor, and every `recordAudit` call site plus the hash-chain verifier would have to learn about it. In a system whose compliance argument is *"todos los eventos en la cadena de hash"*, fracturing the actor identity is a real cost. It also gets **truncated by `resetData.ts`** while `users` survives (§8.5).

**(c) Magic-link / passwordless.**
Attractive for offshore clients, but it makes every session start depend on `mailer.ts`, which is explicitly **degrade-to-noop** — a login path that silently no-ops when SMTP is down is a portal that is invisibly unavailable. Keep magic links for **invitation and password reset only** (§6.5).

### 1.2 Does one-person-multiple-clients matter?

**No, not in v1 — but leave the seam.** The realistic population is an employee of the importer or the platform operator (iMile, per `clientResolution.ts`). The genuine multi-client case (freight forwarder) is rare enough that "two logins" is acceptable for a year.

The seam that costs nothing today: **never read the claim directly in a query**. Route every portal query through one resolver:

```ts
// server/src/portal/tenant.ts
export function portalClientIds(req: Request): string[]   // today: [req.portal!.clientId]
```

Every scoped predicate becomes `= ANY($n::uuid[])` from day one. Adding a `client_user_clients` join table and a client-switcher later is a change in one function plus a token re-issue, not a sweep through thirty queries.

### 1.3 Recommendation

**(a), with a hard CHECK tying role and tenancy together:**

```sql
ALTER TABLE users ADD COLUMN client_id uuid REFERENCES clients(id) ON DELETE RESTRICT;
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('capturista','admin','autoridad','super_admin','tramitador','cliente'));
ALTER TABLE users ADD CONSTRAINT users_cliente_tenant_check
  CHECK ((role = 'cliente') = (client_id IS NOT NULL));
CREATE INDEX users_client_id_idx ON users (client_id);
```

The biconditional is the point: **a `cliente` without a tenant is a token that would see everything, and an internal user with a tenant is a scoping rule somebody will eventually trust.** The database refuses both. `ON DELETE RESTRICT` (not SET NULL, not CASCADE): deleting a client with portal logins must fail loudly.

`clients` gains `portal_habilitado boolean NOT NULL DEFAULT false` — enabling the portal per client is an explicit act. Fail-closed default.

---

## 2. Tenant isolation — the crux

### 2.1 The three enforcement strategies

**(a) App-layer: `client_id` claim + scoped query helper.** Cheap, matches the existing style. Failure mode is human: one route added later that forgets the predicate.

**(b) Postgres RLS with `SET LOCAL app.client_id`.** Textbook answer, **substantially worse than it looks here**:

1. **The pool.** `db/pool.ts` checks out a connection per statement. `SET LOCAL` only survives inside a transaction; plain `SET` **leaks the previous request's tenant** to the next request on that pooled connection. Correct RLS means every portal read goes through `withTransaction` — a new invariant just as forgettable as the WHERE it replaced.
2. **Table ownership.** RLS is silently bypassed by the table owner unless `FORCE ROW LEVEL SECURITY`, and node-pg-migrate runs as the same `DATABASE_URL` role the app uses. Without a second non-owner DB role in Coolify, **the policies would be inert and look like they were working.** Security theatre that passes review is worse than no policy.
3. **Coverage.** ~12 tables, several reaching the tenant only through 2–3 joins. Those policies are subqueries; they are where the pods-ambiguity problem would hide.

RLS is still worth having — as a **backstop, Phase 3, narrow table set, dedicated non-owner role** — never as the primary mechanism.

**(c) Dedicated portal API surface `/api/portal/*`.** A small number of purpose-built, read-only, client-scoped endpoints. The 30-odd internal routers are never made "tenant-aware", so **no internal route ever becomes a thing that must remember to be scoped**. The attack surface a portal token can reach is finite, enumerable, reviewable in one sitting.

The duplication objection is wrong here for a specific reason: **the two queries do not want the same columns**. The internal board wants `discrepanciasCount`, `holdActivo`, `estadoPlaneacion`. The portal must not show any of those. They are different products of the same tables — pretending otherwise is how internal fields end up on the client's screen behind a `role === 'cliente' ? null : x` ternary that somebody deletes in a refactor.

### 2.2 Recommendation: four layers, each independently sufficient

**Layer 1 — Token audience.** Add `aud: 'portal'` to the claims. `verifyAndAttach` in `auth/middleware.ts` **already has exactly this pattern** for enrollment tokens — generalize the boolean into an audience parameter. `requireAuth` (the default, used by every existing route including `files.ts` and `operaciones.ts`) rejects `aud === 'portal'` with 401. A new `requirePortalAuth` rejects anything *without* it. Both fail closed. **This layer neutralizes the `visibleSectionsFor` fail-open bug**: even if a portal token reached the internal SPA, every internal API call 401s.

**Layer 2 — Role.** `cliente` appears in no `requireRole(...)` list anywhere; `super_admin`'s special case only upgrades to `admin`. A portal token satisfies no internal role gate.

**Layer 3 — Mandatory tenant predicate, structurally.** Every portal query is built from one helper module of named, parameterized SQL fragments:

```
server/src/portal/scope.ts
  GUIAS_VISIBLES(clientIds)      -> SQL fragment + params, the §2.4 predicate
  OPERACIONES_VISIBLES(...)      -> EXISTS (SELECT 1 FROM GUIAS_VISIBLES ...)
  FILE_OWNER_CLIENTS(fileId)     -> the §2.6 resolver
```

Rule: **`server/src/routes/portal/*.ts` may not import `query` from `db/pool` directly.** Enforce with an ESLint `no-restricted-imports` rule scoped to that directory. A convention a linter enforces is an invariant; one a comment enforces is a wish.

**Layer 4 — RLS backstop (Phase 3).** A `customs_portal` DB role, a second pool used only by portal routes, `FORCE ROW LEVEL SECURITY` on `operaciones`, `operacion_guias`, `facturas`, `convenios`, `riesgo_requerimientos`, `pods`, `files`. If layer 3 is ever bypassed by a bug, layer 4 returns zero rows rather than someone else's cargo.

### 2.3 The invariants, as testable propositions

Each should be an actual test file:

- **V1.** A token with `aud='portal'` receives 401 from every route not under `/api/portal/*`. *Test: enumerate the Express router stack at runtime, assert every non-portal path 401s a portal token.* This catches the route somebody adds in six months.
- **V2.** A token without `aud='portal'` receives 401 from every route under `/api/portal/*`. (Admin "view as client" is an explicit Phase 3 impersonation feature with its own audit action, not a side door.)
- **V3.** No portal response body ever contains a `client_id`, client name, or `guia_norm` belonging to another tenant. *Test: seed two clients sharing one MAWB and one despacho, walk every portal endpoint as client A, assert client B's identifiers appear nowhere.* **The single highest-value test in the feature.**
- **V4.** An `operacion` with `client_id IS NULL` and no guía with a non-null `client_id` is invisible to **every** portal token.
- **V5.** A portal token can perform no write outside an explicit allowlist (Phase 2: exactly one — responding to a `riesgo_requerimiento`).
- **V6.** `GET /api/portal/files/:id` returns 404 — not 403 — for a file the tenant does not own, indistinguishable from a file that does not exist.

### 2.4 Nullable `operaciones.client_id` and the per-guía split

`COALESCE(g.client_id, o.client_id)` is right for billing and **not tight enough for the portal**. A MAWB carrying house guías for clients A and B:

| guía | `g.client_id` | `o.client_id` | `COALESCE` |
|---|---|---|---|
| G1 | A | A | A ✓ |
| G2 | B | A | B ✓ |
| G3 | **NULL** (ingest gap) | A | **A** ✗ — leaks B-or-unknown cargo to A |

**Portal predicate — strict, with a narrow, provably-safe fallback:**

```sql
-- guía g on operación o is visible to tenant(s) $1::uuid[] iff:
   g.client_id = ANY($1)
OR (
     g.client_id IS NULL
 AND o.client_id = ANY($1)
 AND NOT EXISTS (                      -- the operación is not multi-client
       SELECT 1 FROM operacion_guias g2
        WHERE g2.operacion_id = o.id
          AND g2.client_id IS NOT NULL
          AND NOT (g2.client_id = ANY($1))
     )
   )
```

**An unattributed guía inherits the caso's client only when the caso demonstrably belongs to one client.** On a shared MAWB, unattributed guías are visible to nobody until a human resolves them. That is the correct failure direction — ingest gaps show up as "your shipment list is missing a guía" (a call to the coordinator), not "you can see somebody else's cartons" (a call to a lawyer).

**Operación visibility follows from guía visibility, never the reverse** — with one deliberate exception: an operación with **zero** guía rows (prealerta stage, before manifest ingest) falls back to `o.client_id = ANY($1)`. Zero rows cannot be multi-client, so the fallback is safe by construction. Encode as a third branch with its own comment.

**V4 falls out for free:** `NULL = ANY($1)` is `NULL`, which `WHERE` treats as false. The nullability that makes the internal model correct makes the portal fail closed. Say it out loud in the code — it looks like an accident.

### 2.5 The pods ambiguity — opinionated resolution

`pods.despacho_id` is the only link, and despachos have no `client_id` **by design** (*"una unidad, un destino, N guías, N clientes"*). A POD for a shared truck **physically contains other clients' guía numbers, carton counts and consignees**. No query scoping fixes that: the leak is in the rendered PDF bytes.

The rule (a product decision, not technical):

- The **fact** of delivery — `estado`, `firmado_at`, `firmado_por`, `arribo_destino` — is exposed to every tenant with a visible partida on that despacho.
- The **document** (`file_id_generado/_firmado`, `firma_evidencia_file_id`) is exposed **only when the despacho is single-tenant**:

```sql
NOT EXISTS (
  SELECT 1 FROM despacho_partidas dp
    JOIN operacion_guias g ON g.id = dp.operacion_guia_id
   WHERE dp.despacho_id = p.despacho_id
     AND g.client_id IS NOT NULL
     AND NOT (g.client_id = ANY($1))
)
```

- On a multi-tenant despacho: delivery facts plus *"Proof of delivery for this trip covers several consignees. A copy for your shipments is available on request."* An honest limitation beats a leak or a mysterious missing button.
- The proper fix — **per-client POD rendering** filtering `despacho_partidas` before generating the PDF — is Phase 3 (the `pods_firma_check` + `folio` UNIQUE constraints make per-client copies a real modelling question).

**Facturas** have a real `client_id` — trivial. **`plan_publicaciones`** spans all clients and is **never** exposed in any form.

### 2.6 The files hole

Three separate problems:

**1 — Portal must never reach `GET /api/files/:id`.** Solved by V1 (audience rejection).

**2 — Portal needs *some* downloads.** New `GET /api/portal/files/:id`, authorized by an **ownership resolver** — a single SQL function/`LATERAL` union enumerating every column referencing `files`:

| Path to `files.id` | Tenant resolution | Portal-visible? |
|---|---|---|
| `facturas.file_id` | `facturas.client_id` | **yes** |
| `convenios.file_id`, `.firma_evidencia_file_id` | `convenios.client_id` | **yes** |
| `client_tarifas.contrato_file_id` | `client_tarifas.client_id` | yes (Phase 3) |
| `pods.file_id_*` | via `despacho_partidas → operacion_guias` | **only single-tenant despacho** (§2.5) |
| `prealerta_adjuntos.file_id` | via `prealertas → operaciones` | yes — the client sent it |
| `prealertas.raw_file_id` (the `.eml`) | — | **no** — internal headers, our mailbox |
| `campo_evidencias.file_id` | via `operaciones` | yes, curated (dock photos of their cargo) |
| `operacion_eventos.evidencia_file_id` | via `operaciones` | only for whitelisted event types (§3.2) |
| `holds_retenciones.evidencia_file_id` | via `operaciones` | **no** in Phase 2 — authority oficios, decide with legal |
| `riesgo_requerimientos.evidencia_file_id` | via `operaciones` | yes — evidence they submitted |
| `manifests.*`, `pedimentos.*`, risk artifacts | — | **no** |
| everything else / unmatched | — | **no** (default deny) |

Resolver returns `uuid[]`; empty ⇒ **404**, byte-identical to nonexistent (V6). The 404/410/200 semantics in `files.ts` stay **only for files the tenant owns**. `files.kind` is a useful second gate but **not** the authorization (`evidencia` spans dock photos, hold oficios and requerimiento responses). Ownership by reference, `kind` as an additional allowlist, in that order.

**3 — The internal hole remains and should be fixed anyway.** A `tramitador` — a warehouse phone, deliberately without MFA — can download every factura and convenio by iterating uuids. A pre-existing finding worth its own small PR. "The portal is safe but the tramitador isn't" is not a defensible resting place.

---

## 3. What the client sees

### 3.1 The surface

Five screens, in English (D16), all read-only in Phase 1–2 except one write:

1. **Shipments** — per visible guía/operación: MAWB (their house guías only), origin/destination, flight, ETD/ETA, cartons/weight for their guías only, `etapa`, `semaforo`, `estado_documental`, a plain-English status line.
2. **Shipment detail** — the curated timeline (§3.2) plus flight facts and delivery facts.
3. **Documents** — their facturas, convenios, PODs (subject to §2.5), attachments they sent.
4. **Action required** — open `riesgo_requerimientos` with the UTC deadline. **The screen that justifies the whole portal.** `requerimientosService.ts` already resolves a client contact, sends by email, escalates to WhatsApp, and refuses to run the deadline clock when `notificado_at` is null. A portal makes the requerimiento **pullable** instead of only pushable — exactly what a hard legal deadline needs.
5. **Billing** — facturas by `periodo` with `estado`, totals, PDF.

### 3.2 Event curation: whitelist, and why blacklist is not an option

`shared/operaciones/estados.ts` records that four `REQUERIMIENTO_*` types were written to the ledger for months without appearing in `TIPOS_EVENTO`, because **`tipo` is `text` with no CHECK**. The vocabulary is open. A blacklist over an open vocabulary is a list of the leaks you have already thought of; the next event type ships to clients by default.

Same argument one level down for `payload jsonb` (no shape constraint) and `motivo` (free text typed under pressure). **Whitelist the type, then whitelist the payload fields per type, never pass `payload` through.** A `Record<TipoCliente, (payload: unknown) => ClientEventView>` map — one explicit projection per exposed type — makes "expose a new event" a deliberate act with a diff.

**The whitelist (Phase 2 proposal — labels are the client-facing English, part of the contract):**

| Event type | Client label | Payload exposed |
|---|---|---|
| `PREALERTA_RECIBIDA` | Pre-alert received | `version` |
| `PREALERTA_ADJUNTO_BLOQUEADO` | Attachment rejected — active content | filename only |
| `MANIFIESTO_VERSIONADO` | Manifest updated | `version` |
| `MANIFIESTO_VERSION_RECHAZADA` | Manifest update not applied | curated reason, **not** raw `motivo_rechazo` |
| `OPERACION_CREADA` | Shipment opened | — |
| `VUELO_ACTUALIZADO/_DEMORADO/_CANCELADO` | Flight updated/delayed/cancelled | flight no., new ETA |
| `ARRIBO_VUELO` | Arrived at airport | timestamp |
| `CARGA_DISPONIBLE` | Cargo available | timestamp |
| `INGRESO_ADUANA` | Entered customs | timestamp |
| `FIN_CARGA` | Loading complete | timestamp |
| `MODULACION` | Customs selection | `semaforo` **only** |
| `SALIDA_ROJO` | Released after inspection | timestamp |
| `GUIA_NO_TRANSMITIDA` | House waybill not transmitted | their guía only |
| `RETENCION_CREADA/_LIBERADA` | Cargo held by authority / released | quantity, `oficio_referencia` |
| `REQUERIMIENTO_EMITIDO/_RESUELTO/_VENCIDO/_CANCELADO` | Action required / resolved / expired / cancelled | deadline, client-facing reason (service already writes an English version) |
| `ETA_CALCULADA` | Estimated delivery | ETA |
| `ARRIBO_DESTINO` | Arrived at destination | timestamp |
| `POD_FIRMADO` | Delivered — signed | signer name, timestamp |
| `OPERACION_REPROGRAMADA` | Delivery rescheduled | new date **only** — never `motivo`, never `override` |

**Never exposed, with the durable reason:**

| Blocked | Why |
|---|---|
| `RIESGO_EVALUADO`, `RIESGO_HALLAZGO_DISPUESTO` | The engine's `ReasonCode[]` and scorecard. Publishing detection signals to the party being screened makes them gameable. Strongest single exclusion. |
| `COTEJO_EJECUTADO` | Discrepancy internals; the *outcome* reaches them as a requerimiento. |
| `HOLD_ABIERTO/_CERRADO` | `motivo` is free internal text that can name authorities, other clients, commercial disputes. |
| `HOLD_GLOBAL_*` | Systemic. "Everything is stopped" is a communications decision made by a human. |
| `DESPACHO_*`, `DESPACHO_PARTIDA_*` | Carrier identity, plates, **agreed rate** (D7). Commercially confidential both directions. |
| `REASIGNACION_*` | *"the money boundary (D6/R20)"* — margins, verbatim. |
| `SOLICITUD_UNIDADES_SUSPENDIDA` | Internal capacity. |
| `PLAN_PUBLICADO` | Whole-day plan across all clients. |
| `NOTIFICACION_REQUERIDA` | An internal obligation, not a fact about their cargo — showing it invites the exact "hay que avisar"≠"se avisó" confusion R18 cannot survive. |
| `OPERACION_EXCLUIDA_DEL_PLAN` | Engine decision logic + `motivo`. Client-facing fact is `OPERACION_REPROGRAMADA`. |
| `EVIDENCIA_ARCHIVADA` (`.eml`) | Mail headers, our routing. |
| any event with `operacion_id IS NULL` | Orphan ledger rows (SET NULL). Unattributable ⇒ invisible. |

Cross-cutting field rules: **never expose `override`** (human-overrode-the-system is internal governance), **never `motivo`** (free internal text, any type), **never `created_by`** (staff identity; "signed by" is `pods.firmado_por`, a deliberate field).

---

## 4. Real-time

### 4.1 Options against this deployment

Single container on Coolify, one Node process, no Redis/queue, JWT in `localStorage`, two views already poll on `setInterval`.

**(a) Polling with ETag / `If-None-Match`.** ETag from the tenant's ledger high-water mark:

```sql
SELECT MAX(e.id), COUNT(*) FROM operacion_eventos e WHERE <tenant predicate>
```

304 with empty body when unchanged — one small query, ~200 bytes. 20 clients × 2 tabs × 30s poll = 80 req/min against a 300/min limiter. Fine.

**(b) SSE.** The natural fit: `operacion_eventos` is append-only with a **`bigserial` id** — a ready-made cursor.

- *Event source:* NOT `LISTEN/NOTIFY` (needs a dedicated connection outside `pg.Pool`, 8000-byte cap, missed notifications lost forever). Instead an in-process poller: `SELECT ... WHERE id > $cursor ORDER BY id LIMIT 500` every 2–3s, fanned out to subscribers with per-tenant filtering **in Node** using the same §3.2 projection map. One query serves all connected clients.
- *The bigserial gap:* sequence values are assigned before commit, so a long transaction can commit id 100 **after** 101 is visible; strict `id > cursor` skips it forever. Mitigate with a lag window: `AND registrado_at < now() - interval '2 seconds'`. A classic; write it down in v1 (§8.11).
- *Auth:* `EventSource` **cannot set an Authorization header**. Token in query string → appears in logs, reject. Cookie → drags CSRF into a system that has none. **Use `fetch()` + `ReadableStream`** (~30 lines parsing `data:` frames, keeps the header). Fallback if `EventSource` is ever needed: a single-use, 60-second, tenant-bound **stream ticket** from `POST /api/portal/stream-ticket`.
- *Proxy realities:* `flushHeaders()`, `Cache-Control: no-cache`, `X-Accel-Buffering: no`, heartbeat comment every 20–25s. Cap streams per tenant (5) and total (200).

**(c) WebSockets.** Bidirectional, and the portal has essentially nothing to send. Adds a dependency, a second auth path, sticky-session concerns. No payoff.

### 4.2 Recommendation

**Phase 1: ETag polling (S). Phase 2: SSE over `fetch`+`ReadableStream` fed by the ledger-cursor poller, with automatic fallback to the polling path (M).** The polling endpoint is not throwaway — it *is* the SSE reconnect/resync path, and the mode that runs while a deploy restarts the container.

---

## 5. Frontend / deployment shape

### 5.1 The problem with the same SPA

`visibleSectionsFor` restricts sections, **not the JavaScript**. One bundle statically imports every internal view. Shipping it to clients ships them:

- the complete internal API surface map,
- `src/constants/rgceRules.ts`, `genericHscodes.ts`, `rrnaCategories.ts` and `shared/risk/*` — **the risk engine's rules and thresholds, readable in devtools by the party being screened**,
- the audit portal shape and reconciliation logic,
- and (until fail-closed) a rendered sidebar offering Torre de Control.

The rules bundle is decisive: if `shared/risk/*` reaches the client's browser, §3.2's exclusion of `RIESGO_EVALUADO` is theatre. (Confirm with `vite build` + bundle grep, but the coupling is real regardless.)

### 5.2 Options and recommendation

**Same SPA + role surface:** days of work, but inherits everything above, plus branding (internal ops chrome shown to a paying customer), plus i18n (internal app is Spanish, portal is English), plus a permanent tax: every internal change risks the portal.

**Separate Vite build — recommended, from Phase 1.** A `portal/` directory: own `index.html`, `vite.config.ts`, `main.tsx`, own `src/portal/api.ts` (base path `/api/portal`, **own localStorage token key** so internal and portal sessions can't be confused on a shared machine), minimal component set. May import `shared/operaciones/estados.ts` and `shared/types/*`; must import nothing from `shared/risk/*` or `src/components/*` — enforce with an ESLint boundary rule.

Deployment delta is small:

```dockerfile
RUN npm run build && npm run build:portal   # → /app/dist and /app/dist-portal
ENV SERVE_PORTAL_DIR=/app/dist-portal
```

In `app.ts`, mounted **before** the SPA catch-all:

```
app.use('/portal', express.static(portalDir));
app.get(/^\/portal\/.*/, → dist-portal/index.html);
```

**Path-based `/portal` in Phase 1** (same origin, zero CORS change, no second cert). Subdomain later if branding demands — the only code delta is one `CORS_ORIGIN` entry.

Cost: ~1 extra day now. Cost of retrofitting a split after the portal has real users: a rewrite. And the security argument stands alone: **the internal bundle should never be served to an external party.**

Regardless of the split: **make `visibleSectionsFor` fail closed** (`default: return []`) and **fix the role-union drift** — `AuthContext`'s `User['role']` is already missing `tramitador`. Export one role union from `shared/`, consumed by `server/src/auth/token.ts` and both frontends, so it cannot drift a third time.

---

## 6. Security hardening

### 6.1 MFA policy

**`cliente` must NOT be added to `PRIVILEGED_ROLES`.** `auth/roles.ts` already reasons about this trade for `tramitador` (*"a TOTP on the loading dock is friction without benefit"*); it applies harder to an offshore client across a language barrier. The forcing function in `routes/auth.ts` would 403 a client who cannot complete enrollment unaided.

Compensating controls, by value per effort:

1. **`aud='portal'` + no role gate + read-only surface.** A stolen portal token reads one tenant's shipment statuses. Bounded is the point of §2.
2. **Email OTP step-up on unrecognized device** (Phase 3): `client_user_devices` keyed on a hashed device cookie; unknown device ⇒ 6-digit email code. Reuses `mailer.ts` — but here it must **fail closed** (deny login) when SMTP is unconfigured, the opposite of the `omitido` treatment for notifications. Comment that explicitly.
3. **`MFA_ENFORCEMENT` untouched** — keyed on `isPrivilegedRole`; zero change to existing behavior.
4. **TOTP available, opt-in** from a portal settings page. Costs almost nothing.

### 6.2 Rate limits

- `portalLimiter` from the existing factory, keyed on **`client_id`** (five users ≠ five budgets), ~120/min, mounted on `/api/portal` before routes. Exclude the SSE endpoint.
- Reuse `loginLimiter` unchanged for portal login.
- **New tight limiter on invitation/reset token submission** (10 per 15 min per IP) — the only unauthenticated endpoints the portal adds.
- Fix while here: `app.set('trust proxy', true)` accepts any spoofed `X-Forwarded-For` (the code flags this twice). Behind Coolify's single hop, `trust proxy, 1` makes every per-IP limiter actually enforceable.

### 6.3 Audit

`recordAudit` works unchanged because a `cliente` **is** a user — the payoff of §1.3. New actions: `PORTAL_LOGIN`, `PORTAL_DOWNLOAD_FILE`, `PORTAL_DOWNLOAD_FILE_DENIED`, `PORTAL_REQUERIMIENTO_RESPONDIDO`, `CLIENT_USER_INVITED`, `CLIENT_USER_ACTIVATED`.

**Do not audit every portal GET** — a polling client would drown the hash chain. Audit downloads (row awaited *before* first byte, per `files.ts` discipline) and state changes. `PORTAL_DOWNLOAD_FILE_DENIED` is worth writing even though the response is 404: **a tenant probing file ids is the highest-signal attack indicator this system will produce.**

### 6.4 File download authorization

Covered in §2.6, two supplements:

- **Signed short-lived URLs are the wrong tool here.** Files live on local FS served by the same Express process that could simply do the ownership join. Signed URLs become correct the day blobs move to S3-compatible storage. Also: `routes/files.ts` documents that `FILE_STORAGE_DIR` once had no persistent volume — **confirm the volume before exposing documents to customers.** "Your invoice is permanently gone" (410) is a different-magnitude event for a customer.
- The 410 body carries `kind`, `originalName`, `contentHash`, `sizeBytes` — fine for an owner, never reachable for a non-owner. Ownership check strictly *before* the `stat()`.

### 6.5 Invitation and onboarding

Admin-driven, no self-registration (self-registration on a customs system is not a feature, it is an incident):

1. Admin: **Configuración → Clientes → [client] → Portal users** (extends `cfg_clientes`; note there is currently **no user-management UI at all** — this is the first one, scoped to `cliente` users only).
2. `POST /api/users` gains `clientId`: required iff `role === 'cliente'`, forbidden otherwise. `roleEnum` in `validation/schemas.ts` gains `'cliente'` (it deliberately omits `super_admin`; keep that).
3. User created with a **random unguessable `password_hash`** + a row in `client_user_invitaciones`: `token_hash` (sha256 of 32 random bytes — store the hash, never the token), `expires_at` (72h), `used_at`, `created_by`. A table, not columns on `users`, so re-invitation is a second row with an audit trail.
4. Email via `mailer.ts` → `/portal/activate?token=...`. **`mailer.ts` degrades to noop** — the admin UI must show "invitation created but email not sent — copy this link", never a green checkmark on `omitido`.
5. `POST /api/portal/activate` — token + new password, single-use in the same transaction, bumps `token_version`, audits, returns a portal session token.
6. Password reset = same table, different `proposito`, 1-hour expiry.

### 6.6 Session strategy

Reuse `signToken`, 8h, add `aud`. Revocation already works: `token_version` bump on logout/reset/role change, and — new — **on disabling `clients.portal_habilitado`**, bump `token_version` for every `cliente` user of that client in one statement. A single switch to cut a tenant off immediately.

### 6.7 When `operaciones.client_id` is NULL

**Invisible to every portal token** (V4). Falls out of §2.4 mechanically — but it must be a *test*, not an inference, because the day somebody "fixes" the predicate with a `COALESCE(..., sentinel)` or `OR o.client_id IS NULL` for debugging, every unattributed caso becomes visible to everyone. One test, named after the invariant, with a comment saying what it defends.

---

## 7. Phased roadmap

### Phase 1 — Read-only shipment list, polling (~1 sprint)

Smallest slice that is safe **and useful**: a client logs in and sees where their cargo is.

| Item | Size |
|---|---|
| Migration: `users.client_id` + CHECKs + index + `clients.portal_habilitado` | S |
| Fix `resetData.ts` exclusion list (§8.5) — **same PR as the migration** | S |
| `aud` claim; audience param in `verifyAndAttach`; `requirePortalAuth`; V1/V2 tests | **M** |
| `server/src/portal/scope.ts` — §2.4 predicate + tenant resolver + ESLint boundary | **M** |
| `GET /api/portal/shipments`, `/:id` (status only, no timeline), ETag/304 | M |
| `GET /api/portal/me` | S |
| Invitation flow: table, `clientId` on `POST /api/users`, invite email, `POST /api/portal/activate` | **M** |
| Admin UI: portal-users pane under `cfg_clientes` | M |
| Portal SPA skeleton: `portal/` Vite build, login, activate, list + detail, English | **L** |
| Dockerfile + `app.ts` static mount for `/portal` | S |
| `portalLimiter`; `trust proxy` tightening | S |
| Tests: V1–V5 (incl. two-clients-one-MAWB-one-despacho fixture) | **L** |

Deliberately **out**: any file download, timeline, requerimientos, billing, SSE. **Phase 1 ships zero bytes of stored files to any client**, removing the entire §2.6 risk class from the first release.

New files: `server/migrations/17000056*_portal_client_users.ts`, `server/src/portal/{scope,tenant}.ts`, `server/src/routes/portal/{index,shipments,auth}.ts`, `server/test/routes/portal/*.test.ts`, `portal/`.
Modified: `auth/token.ts`, `auth/middleware.ts`, `app.ts`, `routes/users.ts`, `validation/schemas.ts`, `middleware/rateLimit.ts`, `scripts/resetData.ts`, `scripts/seedUsers.ts`, `Dockerfile`, `package.json`, `src/nav.ts`, `src/context/AuthContext.tsx`.

### Phase 2 — Timeline, documents, requerimientos, SSE

| Item | Size |
|---|---|
| Event whitelist + per-type payload projection map (`shared/portal/eventos.ts`) | **M** |
| `GET /api/portal/shipments/:id/timeline` | S |
| `portal_file_client_ids` resolver + `GET /api/portal/files/:id` | **M** |
| POD single-tenant rule + honest multi-tenant message | M |
| `GET /api/portal/documents` | M |
| `GET /api/portal/requirements` + `POST .../respond` — **the first and only write**; ledger event with `origen='cliente'` (enum already permits it), integrates with the deadline clock | **L** |
| Ledger-cursor poller with the lag window | M |
| `GET /api/portal/stream` SSE + `fetch`/`ReadableStream` client + polling fallback | **M** |
| Fix internal `GET /api/files/:id` hole (independent, ships whenever) | S |
| Tests: whitelist coverage — **a test asserting every `TIPOS_EVENTO` member is explicitly classified, failing when a new type is added** — file ownership matrix, SSE tenant filtering | **L** |

The fails-when-a-type-is-added test is the structural answer to the open-vocabulary problem — the most valuable test in Phase 2.

### Phase 3 — Notifications, self-service, hardening

| Item | Size |
|---|---|
| Outbound notifications to portal users via `notificaciones.ts` + per-user preferences | M |
| Email-OTP step-up on unrecognized device | M |
| RLS backstop: non-owner DB role, second pool, `FORCE RLS`, policies on 7 tables | **L** |
| Per-client POD rendering | M |
| Billing detail: `factura_partidas`, tarifas | M |
| Multi-client users: `client_user_clients` + switcher (only if a real customer asks) | M |
| Admin impersonation ("view as client") with its own audit action + banner | S |
| Client self-service: additional users within their tenant | M |

---

## 8. Risks & gotchas

**8.1 — UUID enumeration.** Unguessable ≠ authorized. **The tenant predicate belongs in the same `WHERE` as the id** — never fetch-then-check in JS. Zero rows → 404. 404-not-403 everywhere (V6) so response codes are not an existence oracle.

**8.2 — The files hole.** §2.6, three parts. Confirm the persistent volume before exposing documents.

**8.3 — JWT audience confusion.** Same `JWT_SECRET`, same `verify` — a portal token is a structurally valid internal token minus the audience check, which is why the check lives in `verifyAndAttach` (default deny), not per-route (opt-in). Stronger: a separate `JWT_PORTAL_SECRET` (same fail-closed resolution as `token.ts`) makes cross-audience forgery cryptographically impossible. One env var in Coolify. **Recommended; the `aud` check is the floor, not the ceiling.**

**8.4 — CORS.** Path-based `/portal`: no change. Subdomain: append to `CORS_ORIGIN` (prod already fails closed when unset).

**8.5 — `resetData.ts` will delete every user, including admins.** The sharpest gotcha:

```sql
TRUNCATE TABLE <every table except users, pgmigrations> RESTART IDENTITY CASCADE
```

`clients` is in that list, and `CASCADE` truncates **every table with an FK referencing a truncated table — including excluded ones**. The moment `users.client_id REFERENCES clients` exists, `TRUNCATE clients ... CASCADE` **also truncates `users`** — on a script whose stated purpose is "wipe everything EXCEPT users". Container then boots with an empty `users` table.

Fixes, both, in the Phase 1 PR, same commit as the migration: **(1) add `clients` to the exclusion list** (also reconciles with `/api/admin/demo-reset`, whose comment already says *"WHAT NEVER GOES: users, clients, platforms, catalogs…"* — the two resets currently disagree); **(2) a test asserting a seeded admin survives `resetData`.**

*This gotcha independently decides §1:* a separate `client_users` table would be truncated outright by the same script — every client silently loses their login on a demo reset while internal users survive. Option (a) makes the problem visible and one-line-fixable.

**8.6 — `seedUsers.ts` reads `[username, password, role]` triples.** A `cliente` entry has nowhere to put `client_id` → violates the CHECK → `set -e` aborts container start. Right failure, wrong ergonomics: make `seedUsers.ts` refuse explicitly ("cliente users are created through the invitation flow").

**8.7 — Role-union drift.** `AuthContext` is **already missing `tramitador`**; `roleEnum` in `schemas.ts` omits `super_admin` deliberately. One shared role union in `shared/`, and the `clientId` addition to `createUserBody` needs a conditional refinement, not a bare enum add.

**8.8 — `visibleSectionsFor` fails open.** Default must become `[]`. Two lines, removes a class of future accident.

**8.9 — Tables with no tenant path.** `vuelos`: expose *derived* flight fields on the shipment, never the row (other cargo). `plan_publicaciones`, global holds: never, structurally cross-tenant. `transportistas`/`importadores`/`agentes`: never — carrier identity is commercial.

**8.10 — SSE and the single container.** Every deploy drops every stream; client reconnects with backoff and **resyncs via the polling endpoint from its last cursor**. Cap streams. `express-rate-limit` MemoryStore is per-process — fine at one container, silently wrong at two.

**8.11 — Bigserial gaps.** Without the lag window, an out-of-order commit is skipped permanently and the client never sees their cargo was held. Silent, intermittent, hard to reproduce. Write the window in v1.

**8.12 — Demo mode.** `/api/admin/demo-reset` keeps `clients` and `users`, so a demo reset leaves portal logins pointing at empty operations. Correct — but verify, and render an empty state, not an error.

**8.13 — Language.** Portal is English (D16). Every portal string — event labels, errors — is English; **do not reuse the Spanish error strings from internal routes**, several of which (pods.ts, convenios.ts) explain internal policy in detail.

---

## Recommended architecture (summary)

| Axis | Decision |
|---|---|
| **Identity** | Role `cliente` in existing `users` + `users.client_id`, welded by `CHECK ((role='cliente') = (client_id IS NOT NULL))`. Inherits token_version revocation, bcrypt, loginLimiter, audit hash-chain. One user → one client, via `portalClientIds(): string[]` + `= ANY(...)` so multi-tenant is a one-function change later. NOT in `PRIVILEGED_ROLES`. |
| **Isolation** | Dedicated read-only `/api/portal/*`, defense in depth: L1 `aud:'portal'` rejected by default in `verifyAndAttach`; L2 `cliente` in no `requireRole`; L3 all portal SQL from `portal/scope.ts` (ESLint-enforced); L4 RLS backstop on a non-owner DB role (Phase 3). Tenant predicate **stricter** than the internal `COALESCE`: unattributed guías on a shared MAWB visible to nobody; `client_id IS NULL` visible to nobody; 404 never 403. |
| **PODs** | Delivery *facts* to every tenant on the truck; the *document* only when the despacho is single-tenant. Per-client POD rendering in Phase 3 — the PDF is the leak, not the query. |
| **Files** | Portal tokens can never reach `/api/files/:id`. `/api/portal/files/:id` authorizes by ownership join, default deny. No signed URLs (local FS makes them ceremony). Fix the internal `requireAuth`-only hole too. |
| **Surface** | Shipments · timeline · documents · action-required · billing, in English. Timeline **whitelisted by type AND payload field** (ledger vocabulary is unenforced). Never: risk findings, hold motivos, despacho/rate/carrier data, reasignaciones, plan snapshots, `override`, `motivo`, `created_by`. |
| **Real-time** | Phase 1 ETag/304 polling keyed on tenant `MAX(event.id)`. Phase 2 SSE over `fetch()`+`ReadableStream` fed by an in-process bigserial-cursor poller with a 2s lag window. No LISTEN/NOTIFY, no websockets, no queue. Polling stays as the reconnect/degraded path. |
| **Frontend** | **Separate Vite build** in `portal/`, served at `/portal` same-origin (no CORS change). The internal bundle — risk ruleset + full API map — is never shipped to a customer. Subdomain later = one `CORS_ORIGIN` entry. |
| **Must fix in P1** | `resetData.ts` must keep `clients` (TRUNCATE…CASCADE would delete every user via the new FK). `visibleSectionsFor` fails closed. Shared role union (AuthContext already missing `tramitador`). |

### Critical files

- `server/src/auth/middleware.ts` — the audience gate; `allowEnrollmentScope` is the exact pattern to generalize
- `server/src/auth/token.ts` — `Claims`/`Role`/`signToken`; `aud` + `cid` claims, optional `JWT_PORTAL_SECRET`
- `server/src/app.ts` — `/api/portal` mount, `/portal` static mount (before the SPA catch-all), CORS
- `server/src/routes/files.ts` — the `requireAuth`-only hole; the 404/410/200 semantics the portal route deliberately narrows
- `server/scripts/resetData.ts` — the `TRUNCATE … CASCADE` that will wipe `users` once `users.client_id` exists
- `shared/operaciones/estados.ts` — `TIPOS_EVENTO` and the documented absence of a CHECK on `tipo` (why the timeline is whitelisted)
- `src/nav.ts` — `visibleSectionsFor`'s fail-open default
