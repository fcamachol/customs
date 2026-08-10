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
   `EntregasView`, `FacturacionView`, and lead-time tiles on `TorreControlView`. `src/nav.ts` and
   `src/App.tsx` have no entries for them yet.
5. **Structurally blocked / deliberately absent, not backlog**: PA-09 (needs the consignee
   patente, which no artefact we receive declares — see `shared/operaciones/cotejo.ts` line ~21);
   #35 Aireon (email sent to FlightAware, waiting).

`docs/PLAN_COMPLETO.md` is the fuller index of all of the above, requirement by requirement.

---

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
fresh on 2026-08-10:
- Root: `npx vitest run` → **75 files, 791 tests, 0 failures.**
- Server: `npm --prefix server test` → **82 files, 1047 tests, 0 failures.**

The old "31 failing/5 files root, 3/1 server" baseline is **gone** — do not expect it and do not
reintroduce it. A session that sees anything less than fully green owns a real regression, not a
pre-existing one. One caveat worth knowing: under full-suite load a single test in
`server/test/routes/replan.test.ts` was observed to hit vitest's 5s default timeout once; run in
isolation (`npx vitest run test/routes/replan.test.ts`) and in a second full clean run it passed
both times — it is machine-load flakiness, not a real failure, but if you see it recur, consider it
worth a `testTimeout` bump on that file rather than ignoring it forever. Never run two vitest
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
