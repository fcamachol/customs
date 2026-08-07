# HANDOFF — Sistema de Operaciones (continuation guide for any session)

**Purpose:** let any Claude Code session — local or claude.ai/code web — continue this work
without the original conversation. Read this whole file before touching anything.
**Last updated:** 2026-08-07 (see git log for the exact state; this file ships in the same
commit as the work it describes).

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

**Pre-existing failure baselines — do NOT chase these, and do NOT add to them:**
- Root: **31 failing tests in exactly 5 files** — `src/context/AuthContext.test.tsx`,
  `src/components/{LoginView,RegistroView,ConfigurationView,CaptureWorkspace}.test.tsx`.
  They fail identically at commits predating this effort (verified in a clean worktree).
- Server: **3 failing tests in exactly 1 file** — `server/src/routes/dashboardData.test.ts`.
Fixing them is backlog item "#36" (welcome), but a session that sees 31/5 and 3/1 is at
baseline. Anything beyond that is YOUR regression. Never run two vitest processes against
the shared test DB concurrently — truncation storms produce false failures.

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
  automatically from the vitest setup.
- **Deploy** = push to main + trigger Coolify (MCP `deploy` tool with the uuid above, or
  the Coolify UI). Verify `/api/health` after.
- **Secret rotation is a standing TODO (#37)**: the AGORA api token, webhook secret,
  OPS_TICK_TOKEN, seed passwords and the AeroAPI key were all exposed in the working
  transcript of 2026-08-07 and should be rotated after the demo window.

## 7. Remaining backlog (ids from the original session's task list)

| # | Item | Notes |
|---|---|---|
| 23 | Risk requirement to client with hard deadline (R18/D13) | needs `riesgo_requerimientos` table, deadline = eta + window, expiry sweep on the tick firing CT-4 → hold tipo 'riesgo'. **Blocked on outbound email.** |
| 26 | Contingency engine CT-1..CT-7 (`shared/operaciones/replan.ts`) | consumes flight events + holds (holds/retenciones SHIPPED: `routes/holds.ts`, CT-3/4/5/6 storage+endpoints); versioned ruleset; auto-executes exclude/reschedule/hold/notify, PROPOSES money-touching reassignment with logged override |
| 29 | Despacho + transport catalogs (R13–R29) | despachos, despacho_partidas, plan_publicaciones with diffs, transportistas/unidades/convenios/tarifas; unit-type-BEFORE-carrier (D7) |
| 30 | POD generation + delivery (R39) | after #29; template pending from Luis (Q6) |
| 31 | Notification fan-out (R19/N5) | **blocked on outbound email**; via AGORA + WhatsApp (evolution-api runs on the customs Coolify) |
| 32 | Financial traceability guía↔piezas↔factura (R43–R48) | client_tarifas, facturas, factura_partidas, monthly per-client report; link in-system, NOT in the CFDI (D17) |
| 36 | Fix the 34 pre-existing test failures | see §4 |
| USER | Outbound email (#22), Coolify scheduled task for the tick (#34, `*/5 * * * *` → `curl -sS -m 120 -X POST -H "x-ops-token: $OPS_TICK_TOKEN" http://localhost:4000/api/ops/tick`), Aireon enablement on FlightAware (#35), secret rotation (#37), set `RAILS_INBOUND_EMAIL_PASSWORD` on the AGORA install (Easypanel) so its ActionMailbox relay opens — the fully-real inbound path for the E2E runner | cannot be done from a session |

## 8. Live data caveats (production is also the demo environment)

Real prealertas from `lgutierrez@capitalc.com.mx` exist as casos. Known genuine finding:
MAWB `160-05930216` declares 64 ctns / 2,914 pcs / 542.86 kg but its manifest totals
134 / 7,732 / 2,711.78 — pending explanation from Luis. `CX3186` is not a real flight per
AeroAPI (PA-10 fires correctly). `POST /api/operaciones/:id/reparse` heals stored parses
after parser upgrades. The E2E demo runner (`server/scripts/demoE2e.ts`, see
`docs/DEMO_E2E.md`) creates a fresh caso through the real AGORA path and walks every
capability; run it after any deploy that touches the pipeline.

## 9. How to continue

1. Read this file, then `git log --oneline -30` for the narrative.
2. Run the verification gate (§4) FIRST to confirm you inherit baseline, not damage.
3. Pick the next backlog item (#26 is the designed next step; #29 is the biggest).
4. Work in the house conventions, verify against baselines, commit atomically with a WHY
   message, push (mind the gh account switch), deploy via Coolify, verify `/api/health`,
   and when the pipeline changed, run the E2E demo runner against production.
