# HANDOFF — Sistema de Operaciones (continuation guide for any session)

**Purpose:** let any Claude Code session — local or claude.ai/code web — continue this work
without the original conversation. Read this whole file before touching anything.
**Last updated:** 2026-08-10 (see git log for the exact state; this file ships in the same
commit as the work it describes).

---

## 0. Current state (2026-08-10, commits `78da50f..684849f`)

Every code-side backlog item from the original session's task list is closed. What shipped in
this range, in order:

- **`f6c7fcf`** — #36 closed: both test suites brought to zero failures (see §4 for the exact
  counts measured today; the old "31/5 root, 3/1 server" baseline no longer applies).
- **`b5932d4`** — #39 code side: `routes/files.ts` answers **410 with the stored hash** instead
  of 500 when a blob is missing; `server/scripts/recoverEvidence.ts` re-downloads lost prealerta
  attachments from AGORA and only writes bytes that verify against the saved `content_hash` (see
  the runbook in §6). The persistent-volume half is still a user action.
- **`16927c7`** — #22 (`services/mailer.ts`, SMTP, config-gated) + #23 (`riesgo_requerimientos`,
  hard-deadline risk requirement, CT-4 on expiry, phase 3 of the tick).
- **`723c413`** (merge of `0570e41`) — #26, the contingency engine: `shared/operaciones/replan.ts`
  (pure, ruleset `2026-08a`, sha256-hashed), `replan_evaluaciones`/`replan_acciones`, phase 4 of
  the tick.
- **`754028b`** (merge of `4775f26`) — #31, WhatsApp fan-out via evolution-api (config-gated),
  plus the internal "dirección" roster.
- **`f2fb606`** (merge of `40c8e07`) — #29, the biggest one: despacho + transport catalogs
  (`despachos`, `despacho_partidas`, `plan_publicaciones` with diffs, `transportistas`,
  `transportista_convenios`, `client_direcciones`, tarifas, unit-type-before-carrier D7).
- **`e40d646`** — #30 (signed POD closes the delivery) + #32 (financial traceability R43–R48:
  `client_tarifas`, `facturas`, `factura_partidas`) + Fase C operational reports
  (`routes/reportesOperativos.ts`, `shared/operaciones/leadTimes.ts`).
- **`9066584`** (merge) — NOM-151 digital signature for client convenios via Cincel
  (`services/cincel.ts`, `routes/convenios.ts`), config-gated exactly like the mailer.
- **`f2ea038`** — `TrazabilidadView.tsx`, a frontend view answering "who took this cargo, in
  both directions" (by a parallel session).
- **`684849f`** — the integration pass tying it together: replan reads real `despachos` (CT-7
  names the actual trip instead of the `estado_planeacion = 'asignada'` proxy); plan publication
  actually sends via SMTP/WhatsApp with a per-recipient outcome; `NOTIFICACION_REQUERIDA` is
  delivered after commit, not just recorded as owed; `hold_activo`'s formula was extracted to one
  helper (`services/holdActivo.ts`, 5 call sites unified); a shared guía-despachable vocabulary
  (hash-pinned) now lives in `shared/operaciones/catalogos.ts`; a tick phase-order test was added;
  `apiDownload` surfaces the 410 body to the frontend; demo-reset learned about the PRD-02 tables.
  **Its blast radius has since been bounded** (see below). The Cincel ↔ `transportista_convenios` unification was **designed** in
  `server/src/services/cincel.ts` (a long comment, lines ~30–91) and **deliberately not built**.

**`POST /api/admin/demo-reset` — what it deletes, and what it will not.** When the reset learned
about PRD-02's tables it overshot: a request with **no body at all** truncated the whole operations
surface, including the append-only `operacion_eventos` ledger and the signed carrier convenios. That
is now bounded, and the three rules are worth knowing before you click it:

- **Always wiped**: the manifest graph (manifests + cascade: shipments, pedimentos, scans, staging,
  monthly_history) and every stored file that nothing surviving still points at.
- **Only on `{"incluirOperaciones": true}`**: the Sistema de Operaciones graph — casos, guías, the
  `operacion_eventos` ledger, campo evidence, prealertas, holds/retenciones/requerimientos, replan
  evaluations and actions, despachos and partidas, published plans, PODs, facturas, vuelos. The
  default is the pre-PRD-02 behaviour, so an accidental click cannot erase the ledger.
- **Never wiped**: users, clients, catalogs, config, `integracion_cursores`, the audit log — plus the
  **durable commercial catalogs** (`transportistas`, `transportista_unidades`,
  `transportista_convenios`, `transportista_tarifas`, `client_direcciones`, `client_tarifas`,
  `convenios`) and the NOM-151 signed documents attached to them.

The response names exactly which surfaces it touched (`deleted` / `superficies` / `conservado`), and
the `DEMO_RESET` audit row carries the identical object. **`RESET_DATA_KEEP_USERS`
(`server/scripts/resetData.ts`, run by `docker-entrypoint.sh` on every boot) is unchanged and
unrelated** — it still enumerates `pg_tables` and truncates everything except `users`/`pgmigrations`.
That is the operator's one-shot deployment wipe; this endpoint is the in-app one.

**What is genuinely still open** (none of it is closeable from a code session alone):

1. **Infrastructure** — the Coolify persistent volume for `/app/storage` (#39's other half), the
   Coolify scheduled task for the tick (#34), secret rotation (#37).
2. **Third-party credentials** for integrations that are already built and config-gated: SMTP app
   password (#22), evolution-api URL/key/instance (#31), Cincel API key + webhook secret
   (NOM-151). See §6 for the exact env vars.
3. **A designed-not-built migration**: unifying `convenios` and `transportista_convenios` onto one
   vocabulary — read the comment in `cincel.ts` before attempting it, the reasons it was deferred
   are load-bearing.
4. **Deferred frontend views** over APIs that already work: `PlaneacionView`, `DespachosView`,
   `EntregasView`, `FacturacionView`. `src/nav.ts` and `src/App.tsx` have no entries for them yet.
   (Lead times SHIPPED — `LeadTimesView`, see the addendum below. It landed as its own section
   rather than as tiles on `TorreControlView`: the torre is live state, this is a date-ranged
   historical query with its own export, and a date filter inside the live board reads as a bug.)
5. **Structurally blocked / deliberately absent, not backlog**: PA-09 (needs the consignee
   patente, which no artefact we receive declares — see `shared/operaciones/cotejo.ts` line ~21);
   #35 Aireon (email sent to FlightAware, waiting).

`docs/PLAN_COMPLETO.md` is the fuller index of all of the above, requirement by requirement.

---

### Addendum (2026-09-18) — CRUD audit, RFC hygiene, and per-guía tax in the export

Shipped on `feat/crud-rfc-impuesto-guia` (PR to `develop`). Three threads:

**RFC hygiene at the point of capture** (`shared/parsing/taxId.ts`, `server/src/services/entityMaster.ts`).
The SAT generic RFCs are now an explicit allow-list: `XAXX010101000` does NOT satisfy the check-digit
algorithm yet is officially valid, so a perfectly legal pedimento was being rejected at
prevalidation. And OCR'd RFCs no longer reach the catalogs unvalidated — an invalid **agent** RFC is
dropped (the row survives with its patente, and prevalidation degrades to a warning instead of the
hard block nobody could clear from the capture form), while an invalid **importador** RFC is refused
outright, because there the RFC *is* the conflict key and inserting it forks one company into two
rows. `findImportadoresDuplicados()` + `GET /api/catalogs/importadores/duplicados` report the pair
that a single misread character produces, and `DELETE` on both catalogs now exists — hard delete, on
purpose, guarded by a 409 when a captured pedimento still names the entity. These two tables are the
only ones that auto-register from a PDF, which is why they are also the only ones that can be
deleted rather than deactivated.

**CRUD gaps closed in the UI** — every one of these was an endpoint that already worked with no
screen calling it: client data is editable (it was read-only, so fixing a mistyped RFC meant a
CASCADE delete that also took the signed NOM-151 convenios); importador RFC and agente patente are
editable; fleet units are editable (renewing an insurance date no longer requires retiring the
vehicle); delivery addresses got their first screen (`src/components/ClienteDirecciones.tsx`). One
real frontend bug went with them: the Proveedores section mounted the carrier modal without `tipo`,
and `COALESCE($8,'transportista')` meant a new airline was silently created as a carrier and then
vanished from the list that filters `tipo <> 'transportista'`.

**`null` must survive validation.** `unidadUpdateBody` and `clientDireccionUpdateBody` are now
hand-written instead of `.partial()` of the create schema. Deriving them folded `null` into
`undefined`, which these PATCH-shaped routes read as "leave this field alone" — so clearing a
mistyped date or contact looked like it saved and did not. Same reasoning that already justified
`fechaOpcionalNullable`; there is now a `textoOpcionalNullable` beside it, and
`server/test/validation/schemasNullable.test.ts` pins the distinction.

**Per-guía tax estimate in the operational export** (`server/src/routes/reportesOperativos.ts`).
Five columns, asked for in the 15-sep meeting. The arithmetic was already in
`shared/impuestos/tasaGlobal.ts`; what was missing was carrying it to the sheet. Four things are
load-bearing and were each a bug first, found by adversarial review:
- The number is written **once per guía**. A row in this export is guía × despacho partida ×
  factura partida, so a guía billed under two concepts appears twice — and whoever opens the file
  selects the column and sums it. Repeating the figure produced an exact-multiple total, which is
  the worst kind of wrong because it looks right. `marcarPrimeraFilaPorGuia` blanks the repeats and
  says so in the note column.
- Origin is aggregated as "GENERAL unless **every** line is T-MEC". `MIN(countryCode)` biased
  toward TMEC (`'CA'` sorts before almost everything), i.e. toward the cheaper estimate — the exact
  thing `tasaGlobal.ts` says never to do.
- The rate date is resolved **in SQL**, cast to `date` like the report's own `WHERE`/`ORDER BY`.
  Computing it in JS with `toISOString()` gave the UTC day while the filter used the server zone, so
  an 19:00 Mexico-time arrival landed in the next day's vigencia.
- The gate is `pedimento_id`, not the pedimento **number**, which is nullable: an unreadable scan
  produces a real pedimento with no number, and gating on the number claimed "No va al pedimento"
  about cargo that does ship.

Known, deliberately NOT unified: the export estimates on the **operation day, aggregated per guía**,
while the cotejo panel estimates on the pedimento's **entry date, per partida** (and rounds per
partida). For a shipment straddling a rate change the two figures differ legitimately. Picking one
canonical date is a business decision, not a code cleanup — it is written down in the comment above
`cargarVigencias()` so the next session does not "fix" it by guessing.

**Still open, and the reason it is open:** there is no user administration at all — no
`GET /api/users`, no deactivation, no password reset, no screen (`server/src/routes/users.ts` is 33
lines: create + change role). A forgotten password or a departing employee currently needs database
access. It was left alone on purpose rather than improvised: password reset touches the JWT `tv`
(token version) revocation path and MFA enrollment, and a half-built version of that is worse than
none.

## 1. What this project is

A Mexican customs (agencia aduanal T1) compliance platform. Two systems in one repo:

- **PRD-01, Sistema de Análisis de Riesgo** — shipped before this effort: manifest ingest,
  versioned 9-signal risk engine, pedimento lifecycle, append-only `audit_log` with a
  verifiable hash chain, authority portal.
- **PRD-02, Sistema de Operaciones** — built across 2026-08-06/07: an inbound client email
  (prealerta) becomes an auditable `operaciones` caso; evidence is archived and hashed;
  red flags (cotejo `PA-01…PA-10`) fire automatically; risk scores on arrival; flights
  verify against FlightAware AeroAPI; the tramitador captures the physical chain
  (disponibilidad → carga → **semáforo** → salida de rojo) from a mobile view; everything
  lands in the append-only `operacion_eventos` ledger mirrored into the same hash chain.

Read `docs/PRD_sistema_operaciones.md` (the master spec, with the meeting transcript
summary and requirement codes R1–R48/PA-xx/CT-x) and
`docs/PRD_sistema_operaciones_agora.md` (the AGORA integration addendum). Requirement
codes in commit messages refer to those documents.

## 2. Architecture in five lines

- **AGORA** (`agoracore.humansoftware.mx`, a Chatwoot fork, account id 9 "Aduanas",
  inbox 21 "Operaciones" = `ops@capitalc.com.mx` via Gmail OAuth IMAP) is the **transport**:
  it receives client email and carries our replies. It is NEVER the system of record — it
  incinerates raw mail at 30 days and its tables are mutable.
- **This repo** is the record: every artifact copied into `files` with sha256, every event
  in append-only `operacion_eventos` + `audit_log` (one hash chain, `GET /api/audit/verify`).
- The **AGORA mirror** (`services/agoraMirror.ts`) echoes significant ledger events into the
  caso's AGORA conversation as PRIVATE notes and re-stamps conversation custom_attributes
  from the live row (Chatwoot REPLACES the attribute set — never hand-assemble a partial).
  Best-effort by contract: it filters by significance and never throws.
- AGORA → customs via an **HMAC-signed webhook** (`POST /api/prealertas/inbound`,
  `X-Agora-Signature: t=…,v1=hex(hmac_sha256(secret, "t.rawBody"))`); customs → AGORA via
  its REST API (`api_access_token` header).
- A **tick** (`POST /api/ops/tick`, `x-ops-token`) runs the periodic phases: flight refresh
  (AeroAPI primary, adsb.lol fallback) and the AGORA reconciliation sweep for dropped
  webhooks. There is deliberately NO in-process scheduler.
- Three orthogonal state axes per caso: `etapa` (physical, monotonic),
  `estado_documental`, `estado_planeacion`. Holds inhibit planning, never the physical etapa.

## 3. Non-negotiable disciplines (violating these breaks the product's thesis)

1. **Evidence before processing** (rule R-A): the ingest archives + scans + hashes BEFORE
   creating/advancing the caso. If archival fails, 5xx and let the caller retry.
2. **Deterministic, version-stamped rules**: the prealerta parser
   (`PREALERTA_PARSER_VERSION`), the cotejo (`COTEJO_RULESET_VERSION`) and the risk ruleset
   are reproducible on demand. **No LLM ever decides an authoritative value.** Provenance
   (`forma/etiqueta/etiqueta_cliente/tabla/inferido_*`) travels with every parsed field; an
   inferred value must never be presented as a client declaration.
3. **The ledger cannot stutter or lie**: same-etapa repeats are noops (no duplicate
   events), etapa never regresses (`canAdvanceEtapa`), `ocurrido_at` (real time) is
   distinct from `registrado_at` (capture time), and `operacion_eventos` is append-only by
   trigger — which also makes any logged caso undeletable (pinned by test; do not "fix").
4. **Semáforo values are literal English `green`/`red` everywhere** (meeting decision D16,
   client-facing). Never translate them.
5. **recordAudit() runs AFTER withTransaction commits**, never inside (advisory-lock
   deadlock otherwise). Every significant action gets exactly one audit row.
6. **Unverifiable ≠ verified**: a check that cannot run must say so (PA-10, "no evaluable"),
   never silently pass.

## 4. Verification gate (do this before EVERY commit — the baselines are load-bearing)

```
npx tsc --noEmit                              # root — must be clean
npx tsc --noEmit -p server/tsconfig.json      # server — must be clean
npx vitest run                                # root suite
npm --prefix server test                      # server suite (needs local Postgres, see §6)
```

**Current baseline: ZERO failures in both suites** (backlog "#36" is closed, `f6c7fcf`). Measured
fresh on 2026-09-18 (previous mark, 2026-08-10, was 75/791 root and 82/1047 server):
- Root: `npx vitest run` → **80 files, 900 tests, 0 failures.**
- Server: `npm --prefix server test` → **87 files, 1211 tests, 0 failures.**

The old "31 failing/5 files root, 3/1 server" baseline is **gone** — do not expect it and do not
reintroduce it. A session that sees anything less than fully green owns a real regression, not a
pre-existing one. One caveat worth knowing: under full-suite load a single test in
`server/test/routes/replan.test.ts` was observed to hit vitest's 5s default timeout once; run in
isolation (`npx vitest run test/routes/replan.test.ts`) and in a second full clean run it passed
both times — it is machine-load flakiness, not a real failure, but if you see it recur, consider it
worth a `testTimeout` bump on that file rather than ignoring it forever. The same thing was
observed on 2026-09-18 in `server/test/routes/rateLimit.test.ts` ("does not throttle repeated
bad-password attempts"): it times out at 5s under full-suite load and passes 8/8 in isolation. Both
tests share the same shape — they wait on deliberately slow work (bcrypt, the tick) while 86 files
compete for the machine. Never run two vitest
processes against the shared test DB concurrently — truncation storms produce false failures. For
`server`, set `TEST_DATABASE_URL` in `server/.env` (or override it in the shell) to your own scratch
Postgres database — a role/db that already exists locally works fine; `createdb <name>` /
`dropdb <name>` before/after keeps it out of anyone else's way.

## 5. House conventions (learned from the codebase, enforced by reviewers)

- Migrations: `node-pg-migrate`, files `server/migrations/<epoch>_<slug>.ts`, slots advance
  by 100000 — **check the highest existing slot before claiming one**. uuid PKs via
  `gen_random_uuid()`, `text` + CHECK (never enums), `jsonb`, children CASCADE,
  `created_by → users SET NULL`, real doc-comments explaining WHY.
- Routes: `requireAuth` → `requireRole(...)` → `validate({...zod})` → try/catch(next);
  camelCase JSON via SQL `AS "camelCase"` aliases; Spanish user-facing errors.
- Frontend: no router — `Section` union in `src/nav.ts`, mounted in `src/App.tsx`;
  `apiGet/apiPost/apiUpload` from `src/api.ts` directly (never extend api.ts); components
  from `src/components/ui`; es-MX dates; `font-mono` for codes/hashes; colocated
  `.test.tsx` with `vi.mock('../api')` and `.toBeTruthy()`.
- Tests hit a real Postgres via `server/test/helpers/db.ts` `truncateAll` — add new tables
  to that list.
- Commits: one feature per commit, message explains WHY (see git log for tone), ends with
  the Co-Authored-By line. Push target: `fercamachol/customs` — **the local gh CLI may be
  logged in as `fcamachol` (cannot see the repo); `gh auth switch --user fercamachol`
  before push, switch back after.**

## 6. Environments and secrets (POINTERS ONLY — values live in Coolify)

- **Production**: Coolify app `customs-v2`, uuid `skcw8c4gcgs0cgcow8g48o4c`, URL
  `https://skcw8c4gcgs0cgcow8g48o4c.35.222.90.155.sslip.io`, deploys `main` of
  `fercamachol/customs`. Migrations run on boot. Env vars (read via Coolify MCP or UI):
  `AGORA_*` (base url, account 9, api token, webhook signing secret, inbox 21, tolerance),
  `OPS_TICK_TOKEN`, `FLIGHT_API_KEY` (AeroAPI), `FLIGHT_API_PROVIDER=auto`,
  `ETA_TOLERANCIA_HORAS`, `SEED_USERS_B64` (demo logins), `DEMO_MODE`.
- **AGORA**: runs on Easypanel (NOT Coolify), separate infra. We only consume its API.
- **Local tests**: need `TEST_DATABASE_URL` in `server/.env` pointing at a scratch
  Postgres. On a fresh sandbox: install Postgres, `createdb customs_test`, set
  `TEST_DATABASE_URL=postgres://<user>@localhost:5432/customs_test`; migrations run
  automatically from the vitest setup. (See §4 for the "use your own scratch DB" note —
  any local database works, it does not have to be named `customs_test`.)
- **Deploy** = push to main + trigger Coolify (MCP `deploy` tool with the uuid above, or
  the Coolify UI). Verify `/api/health` after.
- **Secret rotation is a standing TODO (#37)**: the AGORA api token, webhook secret,
  OPS_TICK_TOKEN, seed passwords and the AeroAPI key were all exposed in the working
  transcript of 2026-08-07 and should be rotated after the demo window.

### 6a. Env var inventory added since 2026-08-07 (all in `server/.env.example`, verified 2026-08-10)

Every group below follows the same contract as the original mailer: **optional by design**. Unset
means every send comes back `omitido` with a stated reason, no request path ever 5xx's because a
credential is missing, and nothing that depends on delivery (like the R18 deadline clock) starts
running against someone who was never actually notified.

- **SMTP (#22)** — `SMTP_HOST`, `SMTP_PORT` (587/465, `SMTP_SECURE` defaults from the port),
  `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `SMTP_TIMEOUT_MS`. Unset ⇒ `services/mailer.ts` records
  `omitido`. **USER ACTION: app password for `ops@capitalc.com.mx`.**
- **`REQUERIMIENTO_VENTANA_HORAS`** (default 3) — offload window added to `eta_pais` to derive the
  R18/D13 hard deadline. Not a secret, safe to leave at default.
- **evolution-api / WhatsApp (#31)** — `EVOLUTION_API_URL`, `EVOLUTION_API_KEY`,
  `EVOLUTION_INSTANCE`, `EVOLUTION_API_TIMEOUT_MS`, `WHATSAPP_INTERNAL_NUMBERS` (comma-separated
  roster for the internal "dirección" advisory on plan-freezing events). Unset ⇒
  `services/whatsapp.ts` records `omitido`. **USER ACTION: the evolution-api instance already runs
  on this Coolify project — needs its URL/key/instance name wired in.**
- **Notification rosters (R19/N5)** — `NOTIFICACION_ALMACEN` (every published plan + CT-1 delay/
  cancellation advices), `NOTIFICACION_COORDINACION` (every published plan),
  `NOTIFICACION_DIRECCION` (falls back to `WHATSAPP_INTERNAL_NUMBERS` when unset). Channel is
  derived from each handle's SHAPE (email → SMTP, phone → evolution-api), not configured — these
  may mix freely, comma-separated. `cliente` and `transportista` audiences are resolved from the DB,
  not env vars.
- **Cincel / NOM-151 (client convenios, R25/D9)** — `CINCEL_API_URL`, `CINCEL_API_KEY`,
  `CINCEL_TIMEOUT_MS`, `CINCEL_WEBHOOK_SECRET` (HMAC secret for `X-Cincel-Signature`; **unset means
  the webhook fails CLOSED with 503**, same posture as `AGORA_WEBHOOK_SIGNING_SECRET` — this one is
  NOT optional-by-design the way the API key is), `CINCEL_SIGNATURE_TOLERANCE_SEC` (default 300).
  Unset API key/URL ⇒ `services/cincel.ts` records `omitido`; a convenio can still be uploaded and
  hashed without Cincel configured. **USER ACTION: Cincel account + API key + webhook secret.**

### 6b. `recover:evidence` runbook (#39)

```
npm --prefix server run recover:evidence              # DRY-RUN — diagnoses only, writes nothing
npm --prefix server run recover:evidence -- --apply    # restores what verifies against its hash
npm --prefix server run recover:evidence -- --apply --limit=20    # first batch, e.g. against prod
npm --prefix server run recover:evidence -- --file=<files.id>     # just one row (repeatable)
npm --prefix server run recover:evidence -- --json     # machine-readable report
```

- Reads `DATABASE_URL` and the `AGORA_*` credentials from `server/.env` (same as the server).
  Restores to the file's own `storage_path` — existing links keep working.
- **The rule that matters**: nothing is restored unless the freshly-downloaded bytes' sha256
  matches the row's stored `content_hash`. A mismatch is reported as `hash_no_coincide` with both
  hashes, left for a human, never silently written — restoring different bytes under someone
  else's hash would be exactly the falsification this whole system exists to make impossible.
- What is recoverable: prealerta attachments (AWB, manifiesto) via the AGORA conversation. What is
  NOT: field photos, generated pedimento PDFs/reports (no external origin — reports regenerate from
  their own routes; field photos are just gone and the report says so), and the prealerta email
  `.json` (timestamped at archive time, so regenerating it produces different bytes/hash).
- **Exit codes**: `0` — everything missing got explained and nothing failed verification. `1` —
  some hash mismatched or some download/write errored; needs human eyes.
- **Sequencing**: this script only helps with what is ALREADY lost. It does not stop the next
  redeploy from destroying newly-archived bytes — that requires the user to mount the persistent
  volume in Coolify (customs-v2 → Storages → `/app/storage` → redeploy) FIRST. Run the script dry
  first, review the report, then `--apply`.

## 7. Remaining backlog (ids from the original session's task list)

**Every numbered item from the original list is SHIPPED code-side.** What is left is
infrastructure, third-party credentials, one deliberately-deferred design, and frontend views —
see §0 for the full narrative and `docs/PLAN_COMPLETO.md` for the requirement-by-requirement index.

| # | Item | Notes |
|---|---|---|
| ~~39~~ | **SHIPPED (code)** — 410 + verifiable recovery | `routes/files.ts` answers 410 with the stored hash instead of 500; `server/scripts/recoverEvidence.ts` restores only what verifies against `content_hash` (runbook in §6b). **Still open: the persistent volume itself** (Coolify → customs-v2 → Storages → `/app/storage` → redeploy, USER) and then running `recover:evidence --apply` against production. |
| ~~22~~ | **SHIPPED (code)** — outbound SMTP | `services/mailer.ts`, config-gated, retried in the tick. **Still open: the app password** for `ops@capitalc.com.mx` (USER). |
| ~~23~~ | **SHIPPED** — risk requirement to client with hard deadline (R18/D13) | `riesgo_requerimientos` (migration `1700004700000`), deadline = ETA + offload window, `services/requerimientosService.ts` + `routes/riesgoRequerimientos.ts`, expiry sweep as **phase 3 of the tick** firing CT-4 → hold tipo 'riesgo'. The clock only ever runs against a client who was actually notified (`notificado_at IS NOT NULL`). |
| ~~26~~ | **SHIPPED** — contingency engine CT-1…CT-7 | pure engine `shared/operaciones/replan.ts` (ruleset `2026-08a` + sha256 hash, `evaluarContingencias`), migration `1700004800000_replan.ts` (`replan_evaluaciones` stores the exact snapshot = replayable decision; `replan_acciones` holds the pending proposals, UNIQUE on `(operacion_id, clave)`), `services/replanService.ts`, `routes/replan.ts`, phase 4 of the tick. As of `684849f`, CT-7 reads real `despachos` (no more `estado_planeacion = 'asignada'` proxy) and `NOTIFICACION_REQUERIDA` actually dispatches instead of only recording the obligation. |
| ~~29~~ | **SHIPPED** — despacho + transport catalogs (R13–R29) | `despachos`, `despacho_partidas`, `plan_publicaciones` with diffs, `transportistas`/unidades/`transportista_convenios`/tarifas/`client_direcciones`; unit-type-BEFORE-carrier (D7). **Frontend gap**: no `DespachosView`/`PlaneacionView` mounted yet — the routes work, nothing in `src/nav.ts` points at them. |
| ~~30~~ | **SHIPPED** — POD generation + delivery (R39) | `routes/pods.ts`. Template is still the system's provisional layout — Luis's real one (Q6) is still pending, said out loud in the code (`advertencia` field), not silently assumed. **Frontend gap**: no `EntregasView`. |
| ~~31~~ | **SHIPPED (code)** — notification fan-out (R19/N5) | `services/whatsappFanout.ts` + `services/notificaciones.ts`, AGORA + WhatsApp (evolution-api) + email, channel derived from handle shape. **Still open: evolution-api URL/key/instance** (USER) — until then every WhatsApp send records `omitido`. |
| ~~32~~ | **SHIPPED** — financial traceability guía↔piezas↔factura (R43–R48) | `client_tarifas`, `facturas`, `factura_partidas`, `routes/facturacion.ts`, monthly per-client report; link in-system, NOT in the CFDI (D17). **Frontend gap**: no `FacturacionView`. |
| ~~36~~ | **SHIPPED** — the 34 pre-existing test failures | Both suites are now at zero failures; see §4 for the exact counts measured 2026-08-10. |
| new | **NOM-151 / Cincel** — digital signature for client convenios (Excel item 8, R25/D9) | `services/cincel.ts` + `routes/convenios.ts`, config-gated exactly like the mailer; upload+hash works without Cincel. **Still open: `CINCEL_API_KEY`/`CINCEL_WEBHOOK_SECRET`** (USER/Cincel account). The unification with `transportista_convenios` is designed in the same file's header comment and deliberately not built — read it before touching either convenio table. |
| PA-09 | Structurally blocked, not backlog | Needs the consignee patente; no artefact received today declares it. `replan.ts`/`holds.ts` already react IF it ever fires; the cotejo rule itself never produces it. See `shared/operaciones/cotejo.ts` line ~21. |
| USER | Coolify scheduled task for the tick (#34, `*/5 * * * *` → `curl -sS -m 120 -X POST -H "x-ops-token: $OPS_TICK_TOKEN" http://localhost:4000/api/ops/tick`), Aireon enablement on FlightAware (#35), secret rotation (#37), set `RAILS_INBOUND_EMAIL_PASSWORD` on the AGORA install (Easypanel) so its ActionMailbox relay opens — the fully-real inbound path for the E2E runner | cannot be done from a session |

## 8. Live data caveats (production is also the demo environment)

Real prealertas from `lgutierrez@capitalc.com.mx` exist as casos. Known genuine finding:
MAWB `160-05930216` declares 64 ctns / 2,914 pcs / 542.86 kg but its manifest totals
134 / 7,732 / 2,711.78 — pending explanation from Luis. `CX3186` is not a real flight per
AeroAPI (PA-10 fires correctly). `POST /api/operaciones/:id/reparse` heals stored parses
after parser upgrades. The E2E demo runner (`server/scripts/demoE2e.ts`, see
`docs/DEMO_E2E.md`) creates a fresh caso through the real AGORA path and walks every
capability; run it after any deploy that touches the pipeline. **Known gap**: as of
2026-08-10 the runner's scorecard still only covers the original PRD-02 core (prealerta,
vuelo, campo, cotejo, holds, mirror) — #29/#30/#32/NOM-151 have no scored steps in it yet,
and `docs/DEMO_E2E.md` has not been updated to describe them. Also remember: since `#39`'s
persistent volume is still not mounted, any evidence archived in production AFTER this
handoff is at risk again on the next redeploy until that volume exists — `recover:evidence`
only cures what has already been lost, it does not prevent losing more.

## 9. How to continue

1. Read this file (start with §0 for the current state), then `git log --oneline -30`.
2. Run the verification gate (§4) FIRST to confirm you inherit baseline (zero failures both
   suites), not damage.
3. There is no open code backlog item that isn't blocked on an external action (§0, §7). If
   the user has just done one of those actions (mounted the volume, supplied a credential),
   that unblocks the corresponding follow-up (running `recover:evidence --apply`, confirming
   a real SMTP/WhatsApp/Cincel send in the E2E runner). Otherwise the highest-value code work
   left is the deferred frontend views (§0 item 4) or extending `demoE2e.ts`/`DEMO_E2E.md` to
   score the newer capabilities.
4. Work in the house conventions, verify against baselines, commit atomically with a WHY
   message, push (mind the gh account switch), deploy via Coolify, verify `/api/health`,
   and when the pipeline changed, run the E2E demo runner against production.

### Addendum (2026-09-18) — `LeadTimesView`: la pantalla que el punto 7 no tenía

`shared/operaciones/leadTimes.ts` calculaba las once métricas desde agosto y
`GET /api/reportes/lead-times` las servía agregadas, con su `.xlsx` al lado. Nada del frontend
llamaba a `/api/reportes`: el punto 7 del cliente estaba construido y era invisible.

`src/components/LeadTimesView.tsx` es esa vista. No agrega aritmética — importa
`METRICAS_LEAD_TIME` y consume el resumen que el servidor ya calcula con la misma función que usa
el export, para que pantalla y archivo no puedan discrepar. Filtros `desde`/`hasta`/`clientId`,
exactamente `reporteOperativoQuery`; los vacíos se omiten en vez de viajar como `desde=`, que el
servidor valida como fecha y contestaría 400.

Lo que la pantalla tiene que respetar, y que las pruebas fijan porque son tres formas conocidas de
mentir con un tablero:

- **`null` se dibuja «—», nunca 0.** Un embarque sin POD firmado tiene lead time desconocido.
- **El denominador se imprime bajo cada promedio.** "Tiempo en almacén 3h" sobre 3 de 90 guías es
  una muestra; `muestras` viaja con el promedio desde el módulo y aquí se ve.
- **Un intervalo negativo se muestra y se marca en ámbar.** Significa que dos marcas de tiempo se
  contradicen — captura diferida, reloj de un dispositivo, hecho registrado fuera de orden.
  Recortarlo a cero borra la única evidencia de que algo hay que arreglar.

`rulesetVersion` se imprime junto al detalle, por la misma razón por la que el módulo lo estampa:
una cifra que alguien fotografía hoy tiene que poder re-derivarse meses después.

Visible para `admin`, `super_admin`, `capturista` y `autoridad` — el mismo conjunto que
`rolesReporte` en el router, para que la sección no aparezca en el menú de quien recibiría un 403.
`tramitador` sigue viendo sólo `ops_campo`.

**Verificado con pruebas, no en navegador**: `npx tsc --noEmit` limpio y `npx vitest run` en 908
pruebas (81 archivos), de las cuales 8 son de esta vista. No se levantó la app contra una base con
operaciones sembradas.

### Addendum (2026-09-18) — `descripcion_generica`: la primera señal que sale del análisis competitivo

Contexto: se revisaron nueve capturas del sistema Sabueso (Hound Express). De la lista de "qué
conviene tomarles", ésta era la única marcada **Tomar** que seguía pendiente — su pantalla de
riesgo evalúa "¿Es genérica?" como columna propia y nosotros no teníamos nada equivalente.

El hueco era real y silencioso. Una fila cuya descripción dice `"artículo"` pasaba por el motor sin
una sola observación: `prohibidos` y `pirateria` buscan palabras *dentro* de la descripción, así que
una descripción que no nombra nada las deja sin materia y la fila sale **verde**. Una descripción
*vacía* sí estaba cubierta (`insufficientData` la manda a `gris`); una vaga, no.

**`shared/risk/descripcion.ts`** decide en cuatro veredictos. La regla **no mide longitud** — a
propósito: `"anillo de acero"` son 15 caracteres y nombra el objeto, `"mercancía general para uso
doméstico"` son 38 y no nombra nada. Lo que se mide es si queda **al menos un token informativo**
tras descontar tres catálogos cerrados (genéricos, materiales, relleno gramatical y muletillas de
propósito del tipo "para uso doméstico", que abundan en los manifiestos traducidos del chino).

- `solo_generica` / `vacia` → peso completo (25).
- `solo_material` (`"Plástico de cristal"`) → 0.6 del peso. Nombrar la sustancia acota el capítulo
  arancelario aunque no identifique el producto; no es lo mismo que no decir nada.
- `informativa` → no dispara.

**No lleva `forcesBand`.** Es una señal de *calidad del dato*, no de severidad: una descripción vaga
no acusa a nadie, impide auditar. Forzar rojo mandaría medio manifiesto de cualquier remitente
descuidado a la cola de revisión manual y quemaría la banda roja, que hoy significa "esto tiene algo
malo", no "esto está mal capturado".

**La recalibración de bandas no es cosmética.** Agregar el peso subió `maxPoints` 348 → 373, lo que
comprime todos los scores un 6.7%. `amarillo` bajó 7 → 6 **porque tenía que bajar**: con 373 una
fila que sólo trae `id` (RFC con dígito verificador malo, 25 pts) puntúa 6.70, y dejando el corte en
7 esa fila habría caído a verde — o sea que agregar una señal nueva habría *escondido* una que ya
existía. `rojo` bajó 11 → 10 por proporción (el umbral crudo 38.28 es 10.26% de 373).
`shared/risk/descripcion.test.ts` fija ese caso explícitamente; si alguien vuelve a tocar los pesos,
ese test es el que avisa.

Medido sobre el manifiesto golden de 501 filas: la señal dispara en **1**, y es un acierto
(`"Plástico de cristal"`). Distribución antes → después: verde 87.82% → 87.62%, amarillo 5.39% →
5.59%, rojo 6.79% → **6.79%** (sin cambio). Exactamente una fila cambió de banda. `enhanced.test.ts`
fija ese 1 como guarda de **precisión**: si un cambio al catálogo hiciera disparar la señal en
decenas de filas, ese test lo delata antes de que llegue a la cola de revisión del cliente.

Catálogo administrable por config `descripciones_genericas`, igual que `prohibited` y
`piracy_brands`. **Reemplaza al de fábrica, no se suma** (hay test, y la UI lo dice en negritas —
quien escriba tres palabras creyendo que las agrega apagaría en silencio las ~90 de fábrica).
Viaja en `resolved.lists`, así que el `ruleset_hash` cambia con la lista y un score viejo se puede
volver a derivar.

La llave va en `ALLOWED_CONFIG_KEYS` de **`server/src/validation/schemas.ts`** (nivel admin, no
super_admin: es un catálogo de calidad, no una lista de sanciones) y tiene su editor en
`ConfigurationView` → *Motor de riesgo*, junto a prohibidos y piratería. Sin esa entrada el
override habría sido código muerto —`riskService` lo lee, pero nadie habría podido escribirlo—;
hay una prueba en `catalogs.test.ts` que fija justamente eso.

**Trampa encontrada de paso, ya desactivada:** `catalogs.ts` tenía una SEGUNDA lista de llaves
permitidas, un `Set` llamado igual, que **nadie consultaba** — ningún `.has()` lo leía. La que
manda siempre fue el `z.enum` de `schemas.ts`, vía `configKeyParam` + el middleware `validate`.
Agregar la llave a la copia muerta daba un 400 con el rastro pareciendo correcto (me pasó). Se
borró el `Set` en vez de sincronizarlo y quedó un comentario en su lugar diciendo dónde vive la
lista real: dos listas que deben coincidir y sólo una manda es una trampa, no una redundancia.

En `HUELLA_EVIDENCIA` la proyección es `['veredicto']` y **no** el texto crudo. Si el texto
participara del hash, el remitente que siempre escribe "gift" obligaría a re-afirmar la disposición
en cada manifiesto por una mayúscula de diferencia. El veredicto sí discrimina: disponer "sólo dice
el material, lo verifiqué con el cliente" no puede tapar una fila posterior que ya no dice nada.

`RULESET.version` → `2026-09a`. Seis guardas literales se actualizaron a mano y con su razón
anotada (`maxPoints` 348→373, las señales de `HUELLA_EVIDENCIA` 9→10, un score 10→9 por el
denominador nuevo, y la versión) — están escritas para atrapar cambios accidentales, así que
cambiarlas es una decisión, no un trámite. Dos más del lado del servidor: la versión persistida en
`risk.test.ts`, y el snapshot de paridad de `riesgoEfectivo.test.ts`, que está escrito a mano como
"esto es lo que el sistema respondía, congelado". Ése se re-congeló **una** vez, con la razón
anotada dentro del propio archivo: la fila gris del fixture suma el motivo "La descripción viene
vacía" porque su semilla trae `descripcion: ''`. Sigue siendo gris y las cuatro superficies siguen
contando 1/1/1/1 — la diferencia viene del motor, aguas arriba, que es exactamente lo que ese
archivo NO está midiendo.

La tabla de riesgo no necesitó trabajo: `RiskResultTable` pinta `r.detail` y `(r.signalId)` de
forma genérica, así que el hallazgo aparece solo con su texto en español.

**Lo que NO se hizo, y por qué** (del mismo análisis): `RRNA` y `aduana exclusiva` quedaron en
*Evaluar* — necesitan catálogos regulatorios mantenidos al día, que es un compromiso permanente y
no una feature. El estado de `previo` está marcado *Diseñar con Luis*. `Transportista y placas por
guía` es *Integrar por API* contra el webhook de ellos: no hay nada que construir, hay que conectar
algo que todavía no tenemos.

**Verificado con pruebas, no en navegador**: `npx tsc --noEmit` limpio en raíz y en `server/`;
`npx vitest run` en `server/` da **1213 pruebas / 87 archivos, todas en verde** (443s, corrida sola
—la regla de no cruzar dos vitest contra la base de pruebas sigue viva y esta vez se respetó), y en
raíz **723 / 54**. No se levantó la app contra una base con manifiestos sembrados: la señal se midió
contra el fixture golden de 501 filas, que es el mismo insumo con el que se calibró el motor.

### Addendum (2026-09-18) — por qué `npm audit fix` no sirve en este repo

El check `npm audit (high/critical)` llevaba semanas en rojo en **todas** las ramas, incluidas `main`
y `develop`. Nueve vulnerabilidades `high` entre raíz y `server/`: `browserslist`, `nanoid`,
`postcss`, `undici`, `brace-expansion`, `multer`, `nodemailer`.

GitHub recomienda `npm audit fix`. **En este repo ese comando no corre**: revienta con

```
npm error Cannot read properties of null (reading 'edgesOut')
```

El stack lo ubica en `#loadPeerSet` de arborist (`build-ideal-tree.js:1289`) resolviendo
`node_modules/vitest` — un bug conocido de npm con sets de peer-deps profundos. Falla igual con
`--package-lock-only`, así que no hay bandera que lo salve. La primera sospecha fue `xlsx`, que se
instala desde un tarball de la CDN de SheetJS y suele confundir a arborist; el log la descarta.

La vía que sí funciona (`npm install` normal no revienta, sólo `audit fix`):

- **Deps directas** — se suben en `package.json`: `multer ^2.2.0 → ^2.4.0`,
  `nodemailer ^9.0.5 → ^9.1.1`.
- **Deps transitivas** — entran por `vite`/`vitest`, así que se fijan con `overrides`:
  raíz `browserslist ^4.29.0`, `nanoid ^3.3.19`, `postcss ^8.5.28`, `undici ^7.29.1`;
  `server/` `brace-expansion ^5.0.12`, `nanoid ^3.3.19`, `postcss ^8.5.28`.

**Todas dentro del mismo major.** Se verificó una por una contra el registro antes de fijarlas:
`nanoid` publica 3.3.19 (no hace falta saltar a 6.x), `undici` publica 7.29.1 (no hace falta 8.x) y
`nodemailer` publica 9.1.1 (no hace falta 10.x). Saltar de major ahí habría sido cambiar la API de
la que dependen el `mailer` y la carga de archivos, a cambio de nada.

Quedan vulnerabilidades `moderate` y `low` (7 en raíz, 5 en `server/`) que el workflow no considera
—corre con `--audit-level=high`— y que no se tocaron: subirlas exigía saltos de major.

Verificado: `npm audit --audit-level=high` sale con **exit 0** en raíz y en `server/`; `tsc --noEmit`
limpio en ambos; **1213/1213** en `server/` y **930/930** en raíz. `multer` y `nodemailer` no son
adorno —los usan la carga de archivos y el envío de correo— así que el valor de esa corrida está en
que confirma que el bump no cambió comportamiento, no sólo que compila.

### Addendum (2026-09-18) — `clasificacion_inconsistente`: la segunda señal del análisis competitivo

Sabueso evalúa **"¿Permite la clasificación correcta?"** como columna propia. Contestar eso de
verdad —si la descripción alcanza para asignar LA fracción correcta— exige un catálogo TIGIE al día,
que es compromiso permanente y no una feature. Ésta es la parte de la pregunta que sí se puede
contestar sin catálogo, y además la única que un auditor puede verificar solo:

> si la misma mercancía aparece en el mismo manifiesto bajo dos fracciones distintas,
> al menos una de las dos está mal, sin necesidad de saber cuál.

Es una **contradicción interna**, no una opinión sobre la clasificación. Por eso no depende de fuente
externa y por eso se sostiene meses después: la evidencia es el propio manifiesto.

**Hallazgo de fondo:** `hsCode` se capturaba, se validaba el formato (`validateManifest` avisa si no
son 8 o 10 dígitos) y después **no lo usaba ni una línea del motor de riesgo**. Mismo patrón que la
descripción: dato capturado y descartado.

**La regla obvia se midió y se descartó.** Marcar la fracción "los demás" (las que terminan en 99 o
90) suena bien y marca **131 de las 501** filas del fixture — el 26%. Una señal que barre un cuarto
del manifiesto no dirige la revisión a ningún lado. La contradicción interna marca **6** (1.2%), y
las seis son la misma mercancía: `"funda de plástico para teléfono móvil"` declarada bajo
**39264000** (artículos de adorno) y **39269099** (los demás manufacturas de plástico).

Decisiones que las pruebas fijan:

- **Se compara a 8 dígitos, no a 10.** Los últimos dos son el NICO, que desagrega *dentro* de la
  misma fracción. Comparar a 10 inventaría hallazgos donde no hay desacuerdo de clasificación.
- **La clave de mercancía es conservadora**: acentos, mayúsculas, espacios y el sufijo `* n`, nada
  más. No reduce a tokens ni agrupa sinónimos. Agrupar de más no da una señal más sensible: da una
  acusación falsa —"clasificaste igual dos cosas distintas"— que es lo que destruye la confianza en
  el semáforo.
- **Se marcan las DOS caras**, no sólo la fracción minoritaria. El motor no sabe cuál es la
  correcta, y señalar a la minoría sería inventar esa respuesta; a veces la mayoría es la que está
  mal. Quien revisa necesita ver las dos para decidir.
- **Sin `forcesBand`**, por lo mismo: de dos líneas contradictorias al menos una está mal, pero al
  menos una está BIEN. Forzar rojo condenaría también a la correcta.
- En `HUELLA_EVIDENCIA` la proyección es `['clave', 'fracciones']`. `fraccionDeEstaFila` queda
  FUERA a propósito para que las dos caras compartan huella — si no, disponer sobre una dejaría viva
  la otra y el humano afirmaría dos veces lo mismo.

**Un error mío que atrapó la suite, y vale la pena que quede escrito.** Al recalibrar bandé `rojo`
de 10 a 9 por proporción pura (el umbral crudo 37.3 es 9.37% de los nuevos 398 puntos). Estaba mal:
**el score se redondea antes de comparar**, así que una fila de 35 puntos crudos —`cantidad` 15 +
`monto` 20, una combinación que existe desde siempre— puntúa 35/398 = 8.79, redondea a 9, y con el
corte en 9 habría saltado de amarillo a **rojo**. La aritmética proporcional aplicada sin mirar el
redondeo escalaba en silencio una combinación vieja. Lo detectó el aserto de `colorEfectivo` en
`efectivo.test.ts`; `rojo` se quedó en **10**. Si alguien vuelve a mover pesos, ése es el test que
avisa, y ahora lleva el comentario que lo explica.

Distribución sobre el golden, 2026-09a → 2026-09b: verde 87.62% → 86.43%, amarillo 5.59% → 6.39%,
rojo 6.79% → 7.19%. Se movieron **exactamente las 6 filas marcadas** y ninguna otra: 3 a amarillo por
la señal sola, 3 a rojo porque además traen `bbdd` (mismo consignatario importando repetido *y*
clasificando de dos formas — una combinación que merece rojo).

`RULESET.version` → `2026-09b`. Cinco guardas literales actualizadas con su razón anotada.
