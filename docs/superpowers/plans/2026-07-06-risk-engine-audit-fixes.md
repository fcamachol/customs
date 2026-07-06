# Risk Engine Audit Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the three confirmed bugs from the 2026-07-06 risk-analysis audit: (1) the `gris` insufficient-data short-circuit swallows forced-rojo sanctions/prohibited hits, (2) denied-party name matching lacks homoglyph/confusable folding, (3) the dashboard distribution silently drops `gris` shipments.

**Architecture:** All three are small, surgical fixes to existing modules — no new files. Task 1 reorders one guard in the pure scoring function. Task 2 swaps the normalization primitive used by the sanctions name matcher (`norm()` → `canonicalize().loose`, the same evasion-resistant path brand/keyword matching already uses). Task 3 adds `gris` to the `Distribution` type on the server and renders it in the dashboard UI.

**Tech Stack:** TypeScript, Express, vitest, React (frontend), Postgres (server route tests only).

## Global Constraints

- `norm()` in `shared/risk/normalize.ts` MUST NOT change: it doubles as the entity-keying function for bbdd/smurfing/address counters; folding confusables there would shift stored history keys. Only the *screening* matcher switches to `canonicalize()`.
- `shared/risk/` stays crypto-free and dependency-free (no Node `crypto`, no new imports beyond existing local modules).
- Engine tests run with no DB: `npx vitest run shared/risk`. Server route tests need the dev Postgres up (see memory: backend/tests use migrations; `server/test/setup.ts` truncates + migrates via `TEST_DATABASE_URL`). Frontend tests: `npx vitest run src/components/DashboardView.test.tsx`.
- Do NOT pass `--reporter=basic` to vitest (not supported in this version).
- Commit messages follow existing convention: `fix(scope): ...` / `feat(scope): ...`, ending with the Claude co-author trailer.

## Out of Scope (deliberate)

- `records.ts:90-91` "gris = Sin evaluar" filter conflating scored-gris with never-scored: needs a product decision (add a separate "Sin datos" filter value in ConsultaView vs. keep merged). Do not change.
- Wrapping the risk persistence loop (`server/src/routes/risk.ts:57-62`) in a transaction: robustness improvement, fails safe today (`risk_stale` stays true). Separate change if wanted.
- The unordered-token over-matching in `matchesDeniedParty` (comment says "in order", code is unordered): behavior is intentionally kept (over-matching is the safe direction for a compliance screener); Task 2 fixes the stale comment only.

---

### Task 1: Forced-rojo beats the gris insufficient-data short-circuit

A denied-party/prohibited/piracy hit (`forcesBand: 'rojo'`) must classify `rojo` even when the row has insufficient data (missing RFC/CURP, empty description, or non-finite customs value). Today `scoreRow` returns `gris` before ever checking `forcesBand`, so an OFAC match on a consignee without RFC lands in "Sin evaluar" and is hidden from the review queue.

**Files:**
- Modify: `shared/risk/scorecard.ts:13-28`
- Modify: `shared/risk/PARITY.md` (append one clarifying paragraph)
- Test: `shared/risk/scorecard.test.ts`, `shared/risk/deniedParty.test.ts`

**Interfaces:**
- Consumes: `scoreRow(reasons, { weights, bands, insufficientData })` from `scorecard.ts`; `ReasonCode.forcesBand?: 'rojo'` from `signals.ts`; `scoreManifest` from `classify.ts` (unchanged signatures).
- Produces: no signature changes. New behavior contract: `scoreRow` returns `band: 'rojo'` (with a real computed score) whenever any reason has `forcesBand === 'rojo'`, regardless of `insufficientData`. Rows with insufficient data and NO forced reason still return `{ score: 0, band: 'gris' }` exactly as before.

- [ ] **Step 1: Write the failing unit test**

Append inside the `describe('scoreRow', ...)` block in `shared/risk/scorecard.test.ts`:

```typescript
  it('forcesBand rojo overrides insufficient-data gris (sanctions hit must never hide as Sin evaluar)', () => {
    const codes: ReasonCode[] = [{ signalId: 'denied_party', points: 100, weight: 100, detail: 'x', forcesBand: 'rojo' }];
    const r = scoreRow(codes, opts(true));
    expect(r.band).toBe('rojo');
    expect(r.score).toBeGreaterThan(0);
  });
```

- [ ] **Step 2: Write the failing end-to-end test**

Append inside the `describe('scoreManifest denied_party → rojo', ...)` block in `shared/risk/deniedParty.test.ts` (note: `ship()` replaces `consignee` wholesale, so omitting `rfc` triggers the insufficient-data path):

```typescript
  it('sanctioned consignee WITHOUT RFC/CURP still forces rojo (not gris)', () => {
    const s = ship({ consignee: { name: 'Ivan Petrov', address: 'Calle 1' } });
    const out = scoreManifest([s], {}, { deniedParties: OFAC_LIST });
    expect(out[0].band).toBe('rojo');
    expect(out[0].color).toBe('rojo');
  });
```

- [ ] **Step 3: Run both tests to verify they fail**

Run: `npx vitest run shared/risk/scorecard.test.ts shared/risk/deniedParty.test.ts`
Expected: exactly the 2 new tests FAIL with `expected 'gris' to be 'rojo'`; all others pass.

- [ ] **Step 4: Implement the fix**

Replace the body of `scoreRow` in `shared/risk/scorecard.ts` (lines 13–28) with:

```typescript
export function scoreRow(
  reasons: ReasonCode[],
  opts: { weights: Weights; bands: Bands; insufficientData: boolean },
): ScoreResult {
  const sorted = [...reasons].sort((a, b) => b.points - a.points);
  // A forcesBand:'rojo' signal (denied_party, prohibidos, pirateria) must win over the
  // insufficient-data gris short-circuit: a sanctions/prohibited hit may fire on rows
  // that are ALSO missing RFC/CURP or customs value, and hiding it in "Sin evaluar"
  // would remove it from the rojo review queue.
  const forced = reasons.some((r) => r.forcesBand === 'rojo');
  if (opts.insufficientData && !forced) return { score: 0, band: 'gris', reasons: sorted };
  const raw = reasons.reduce((sum, r) => sum + r.points, 0);
  const max = maxPoints(opts.weights) || 1;
  const score = Math.min(100, Math.round((100 * raw) / max));
  let band: Band;
  if (forced || score >= opts.bands.rojo) band = 'rojo';
  else if (score >= opts.bands.amarillo) band = 'amarillo';
  else band = 'verde';
  return { score, band, reasons: sorted };
}
```

- [ ] **Step 5: Run the full engine suite to verify everything passes**

Run: `npx vitest run shared/risk`
Expected: all test files pass (was 164 tests; now 166), including the pre-existing `insufficient data -> gris regardless of points` test (still passes — it has no forced reason).

- [ ] **Step 6: Document the guarantee in PARITY.md**

Append to `shared/risk/PARITY.md`:

```markdown

## Update 2026-07-06: forced-rojo precedence over gris

`scoreRow` now checks `forcesBand: 'rojo'` BEFORE the insufficient-data gris short-circuit.
A denied-party (F18), prohibited-keyword, or piracy-brand hit classifies `rojo` even when the
row is missing RFC/CURP, description, or customs value. Previously such rows were silently
downgraded to `gris` ("Sin evaluar"), contradicting the F18 guarantee above.
```

- [ ] **Step 7: Commit**

```bash
git add shared/risk/scorecard.ts shared/risk/scorecard.test.ts shared/risk/deniedParty.test.ts shared/risk/PARITY.md
git commit -m "fix(risk): forced-rojo signals override insufficient-data gris band

A denied-party/prohibited/piracy hit on a row missing RFC/CURP or customs
value was silently classified gris (Sin evaluar) instead of rojo, hiding
sanctions matches from the review queue.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Homoglyph-resistant denied-party name matching

`matchesDeniedParty` normalizes names with `norm()`, which deliberately skips the Cyrillic/Greek confusable fold (it doubles as the entity-keying primitive). So `"Ivаn Petrov"` with Cyrillic **а** (U+0430) evades an OFAC `"Ivan Petrov"` entry, while the identical trick against a piracy brand is caught. Switch the screening matcher to `canonicalize().loose` — the same fold-aware path `matchesBrand`/`matchesProhibited` use. `norm()` itself is untouched.

**Files:**
- Modify: `shared/risk/lists.ts:1` (import) and `shared/risk/lists.ts:96,109-116` (matcher + stale comment)
- Test: `shared/risk/deniedParty.test.ts`

**Interfaces:**
- Consumes: `canonicalize(s): { loose, tight }` from `./normalize` (already imported in lists.ts).
- Produces: `matchesDeniedParty(fields, list)` — signature unchanged. New behavior contract: name matching folds diacritics AND Cyrillic/Greek confusables on both the entry name and the candidate names. ID matching unchanged. Every previously-matching input still matches (`canonicalize().loose` is a superset fold of `norm()`).

- [ ] **Step 1: Write the failing tests**

Append inside the `describe('matchesDeniedParty', ...)` block in `shared/risk/deniedParty.test.ts`:

```typescript
  it('matches homoglyph-obfuscated candidate (Cyrillic а) against a Latin entry', () => {
    // 'Ivаn' = "Ivаn" with Cyrillic а (U+0430), visually identical to Latin a
    const result = matchesDeniedParty({ names: ['Ivаn Petrov'], ids: [] }, OFAC_LIST);
    expect(result).not.toBeNull();
    expect(result?.matched).toBe('Ivan Petrov');
  });

  it('matches a Latin candidate against a homoglyph-obfuscated entry name', () => {
    // Entry uses Cyrillic а (U+0430) and Cyrillic о (U+043E)
    const list: DeniedPartyEntry[] = [{ name: 'Ivаn Petrоv', source: 'OFAC' }];
    expect(matchesDeniedParty({ names: ['ivan petrov'], ids: [] }, list)).not.toBeNull();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run shared/risk/deniedParty.test.ts`
Expected: exactly the 2 new tests FAIL with `expected null not to be null`; all others pass.

- [ ] **Step 3: Implement the fix**

In `shared/risk/lists.ts`, make three edits.

Edit 3a — line 96, candidate normalization (`norm` → `canonicalize().loose`):

```typescript
  // canonicalize().loose folds diacritics AND Cyrillic/Greek confusables — same
  // evasion resistance as matchesBrand/matchesProhibited. norm() is NOT used here:
  // it is reserved for entity keying and deliberately skips the confusable fold.
  const looseNames = fields.names.map((n) => canonicalize(n).loose.trim()).filter(Boolean);
```

(replacing `const normNames = fields.names.map((n) => norm(n)).filter(Boolean);`)

Edit 3b — lines 109–120, entry normalization + stale comment + loop variable:

```typescript
    // Normalized name match: every entry-name token (>= 3 chars) must appear as a
    // substring of the candidate name (unordered). Token-based check reduces false
    // positives from very common short names; unordered matching over-matches
    // (e.g. reversed name order) — the safe failure direction for screening.
    const entryLoose = canonicalize(entry.name).loose;
    const entryTokens = entryLoose.split(/\s+/).filter((t) => t.length >= 3);
    if (entryTokens.length === 0) continue;

    for (const candidate of looseNames) {
      const allTokensMatch = entryTokens.every((token) => candidate.includes(token));
      if (allTokensMatch) {
        return { matched: entry.name, source: entry.source, program: entry.program };
      }
    }
```

Edit 3c — line 1: after edits 3a/3b, `norm` has no remaining uses in lists.ts. Change the import to:

```typescript
import { canonicalize } from './normalize';
```

(If a later grep shows another `norm(` use in lists.ts, keep the import — verify with `grep -n "norm(" shared/risk/lists.ts` before removing.)

- [ ] **Step 4: Run the full engine suite**

Run: `npx vitest run shared/risk`
Expected: all pass (166 → 168 tests). Pay attention to `lists.test.ts` and the existing diacritics test in `deniedParty.test.ts` — both must still pass (loose is a superset of norm's folding).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json` (or the repo's typecheck script if `package.json` defines one — check `npm run` first)
Expected: no errors (catches a leftover `norm` reference after the import change).

- [ ] **Step 6: Commit**

```bash
git add shared/risk/lists.ts shared/risk/deniedParty.test.ts
git commit -m "fix(risk): fold homoglyphs in denied-party name matching

matchesDeniedParty used norm() (fold-free by design, it doubles as the
entity-keying primitive) so Cyrillic/Greek confusables evaded sanctions
screening while the same trick against piracy brands was caught. Screening
now uses canonicalize().loose like matchesBrand/matchesProhibited; norm()
and entity keys are unchanged.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Dashboard counts gris shipments

`mergeDistribution` drops `gris` rows because the `Distribution` type has no `gris` field, so fully-evaluated insufficient-data shipments vanish from dashboard totals. Add `gris` end-to-end: server type → route test → frontend type/bar/legend.

**Files:**
- Modify: `server/src/routes/dashboardData.ts:1,4,19`
- Modify: `src/components/DashboardView.tsx:7,11,57-64`
- Test: `server/test/routes/dashboard.test.ts`, `src/components/DashboardView.test.tsx`

**Interfaces:**
- Consumes: `GET /api/dashboard` response shape built by `buildDashboardResponse` (`server/src/routes/dashboard.ts:36-40`); the SQL already returns gris rows (`WHERE s.risk_color IS NOT NULL GROUP BY s.risk_color`) — only the merge drops them. No SQL changes.
- Produces: `Distribution = { verde: number; amarillo: number; rojo: number; gris: number }` on BOTH server (`dashboardData.ts`) and client (`DashboardView.tsx`) — the two type declarations are independent and must be updated together.

- [ ] **Step 1: Write the failing server test**

In `server/test/routes/dashboard.test.ts`, in the `beforeEach` after `await mk('verde'); await mk('amarillo'); await mk('rojo');` add:

```typescript
  await mk('gris');
```

and change the assertion in the test to:

```typescript
    expect(res.body.distribution).toEqual({ verde: 1, amarillo: 1, rojo: 1, gris: 1 });
```

- [ ] **Step 2: Run it to verify it fails**

Requires the dev Postgres up (`TEST_DATABASE_URL`; run migrations first if schema drifted — backend hard-crashes on drift).
Run: `npx vitest run server/test/routes/dashboard.test.ts`
Expected: FAIL — received object lacks `gris`.

- [ ] **Step 3: Implement the server fix**

In `server/src/routes/dashboardData.ts`:

Line 1:
```typescript
export type Distribution = { verde: number; amarillo: number; rojo: number; gris: number };
```

Line 4 (inside `mergeDistribution`):
```typescript
  const d: Distribution = { verde: 0, amarillo: 0, rojo: 0, gris: 0 };
```

Line 19 (inside `buildDashboardResponse`, the byUser initializer):
```typescript
    if (!u) { u = { userId: row.userId, username: row.username, manifests: row.manifests, distribution: { verde: 0, amarillo: 0, rojo: 0, gris: 0 } }; map.set(row.userId, u); }
```

- [ ] **Step 4: Run server test to verify it passes**

Run: `npx vitest run server/test/routes/dashboard.test.ts`
Expected: PASS.

- [ ] **Step 5: Update the frontend to render gris**

In `src/components/DashboardView.tsx`:

Line 7:
```typescript
type Distribution = { verde: number; amarillo: number; rojo: number; gris: number };
```

Line 11 (gris counts toward total guías analizadas):
```typescript
const sum = (d: Distribution) => d.verde + d.amarillo + d.rojo + d.gris;
```

After the red bar segment (line 59), add a slate segment:
```tsx
            <div className="bg-slate-300" style={{ width: `${pct(data.distribution.gris, guias)}%` }} />
```

After the Rojo legend entry (line 64), add:
```tsx
            <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-slate-300" />Sin datos {data.distribution.gris}</span>
```

("Sin datos" matches the risk route's PRD bucket name for gris, `server/src/routes/risk.ts:71` — do NOT label it "Sin evaluar", that's the never-analyzed state.)

- [ ] **Step 6: Fix the frontend test fixture and run it**

In `src/components/DashboardView.test.tsx` lines 9–10, add `gris: 0` to both distribution literals:

```typescript
      ? Promise.resolve({ manifests: 2, distribution: { verde: 9, amarillo: 1, rojo: 2, gris: 0 },
          byUser: [{ userId: 'u1', username: 'Ana', manifests: 2, distribution: { verde: 9, amarillo: 1, rojo: 2, gris: 0 } }] })
```

Run: `npx vitest run src/components/DashboardView.test.tsx`
Expected: PASS. If an assertion counts legend entries or bar segments, update the expected count by +1 — the new legend text is `Sin datos 0`.

- [ ] **Step 7: Typecheck both sides**

Run: `npx tsc --noEmit -p tsconfig.json` and the server typecheck if separate (check for `server/tsconfig.json`; if present: `npx tsc --noEmit -p server/tsconfig.json`)
Expected: no errors — this catches any other consumer of either `Distribution` type missing the new field.

- [ ] **Step 8: Commit**

```bash
git add server/src/routes/dashboardData.ts server/test/routes/dashboard.test.ts src/components/DashboardView.tsx src/components/DashboardView.test.tsx
git commit -m "fix(dashboard): count gris shipments in risk distribution

mergeDistribution dropped gris rows (Distribution had no gris field), so
evaluated insufficient-data shipments vanished from dashboard totals. Adds
gris to the server and client Distribution types and renders a 'Sin datos'
segment + legend entry.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Final verification (after all tasks)

- [ ] `npx vitest run shared/risk` — all pass
- [ ] `npx vitest run server/test/routes/risk.test.ts server/test/routes/dashboard.test.ts` — all pass (needs Postgres)
- [ ] `npx vitest run src/components/DashboardView.test.tsx` — all pass
- [ ] Manual spot-check (optional, needs dev servers — front 3004, back 4000): run risk analysis on a manifest containing a denied-party consignee without RFC; confirm the row shows rojo in the results table and the dashboard "Sin datos" count reflects gris rows.
