# F13 Report: Cross-row $2,500 Aggregation by Consignee (Split-Shipment Cap)

## Status

DONE — all 76 shared-suite tests green (including 6 new F13 tests + 1 updated ruleset literal guard).

---

## TDD Cycle

### RED (tests written first, before any production code)

Tests added:
- `shared/risk/signals.test.ts`: `agregado` fires on same-RFC total $4,998; does NOT fire for two distinct RFCs each at $2,499
- `shared/risk/classify.test.ts`: two same-RFC $2,499 rows escalate above verde with `agregado` reason; two different-RFC rows stay verde
- `shared/pedimento/prevalidate.test.ts`: two same-consignee partidas at $2,499 each → REJECTED; two different-consignee partidas → APPROVED

Run command: `npx vitest run shared/risk/signals.test.ts shared/risk/classify.test.ts shared/pedimento/prevalidate.test.ts`

RED output: 3 files failed, 3 tests failed:
- `signals.test.ts`: `expected undefined to be defined` (agregado not in gradeSignals)
- `classify.test.ts`: `expected 'verde' not to be 'verde'` (entityValueTotal not built in PASS 1)
- `prevalidate.test.ts`: `expected 'APPROVED' to be 'REJECTED'` (aggregate grouping not implemented)

All failures were for the expected reason (feature missing, not typos).

### GREEN (production code added)

Run command: `npx vitest run shared/risk shared/pedimento`

GREEN output: 76 tests passed (13 test files).

---

## Implementation

### Files modified

1. **`shared/risk/ruleset.ts`**
   - Added `agregado: 20` to `RULESET.weights` (weight mirrors `monto`)
   - Added `'agregado'` to `Weights` type union
   - Recalibrated bands: `amarillo: 10 → 8`, `rojo: 17 → 15` (see recalibration section below)

2. **`shared/risk/signals.ts`**
   - Added `'agregado'` to `SignalId` union
   - Added `entityValueTotal?: Record<string, number>` to `EntityContext` with F20 coordination comment
   - Added `agregado` signal block in `gradeSignals` after the per-row `monto` block

3. **`shared/risk/classify.ts`**
   - PASS 1 now builds `entityValueTotal` keyed by `entityKey(consignee)` — skips non-finite values to avoid NaN pollution
   - Passes `entityValueTotal` into `EntityContext`

4. **`shared/types/pedimento.ts`**
   - Added optional `consigneeKey?: string` to `PedimentoPartida`

5. **`shared/pedimento/buildPedimento.ts`**
   - Imports `entityKey` from `../risk/signals`
   - Sets `consigneeKey: entityKey(s.consignee)` on each partida

6. **`shared/pedimento/prevalidate.ts`**
   - Added `SPLIT_CAP_USD = 2500` constant (cross-referenced to `RULESET.thresholds.montoMax`)
   - Added `parseIdFromObservation()` helper for legacy pedimento backwards-compat
   - Changed per-row cap to use `SPLIT_CAP_USD` (no drift possible)
   - Added aggregate grouping pass: groups partidas by `consigneeKey ?? parseIdFromObservation(obs) ?? seq:<n>`; pushes error "Consignatario <id>: valor agregado $<sum> USD excede $2,500 USD (posible envío fraccionado)." for any group > cap

### Test files modified

7. **`shared/risk/signals.test.ts`** — added 2 new `gradeSignals` tests for `agregado`
8. **`shared/risk/classify.test.ts`** — added 2 new `scoreManifest` tests for cross-row aggregation
9. **`shared/pedimento/prevalidate.test.ts`** — added 2 new `prevalidatePedimento` tests for aggregate cap
10. **`shared/risk/ruleset.test.ts`** — updated literal `maxPoints` guard: `218 → 238` (25+15+20+20+20+60+60+18)

---

## Recalibration: 501-row golden distribution

### Reason for recalibration

Adding `agregado` (weight 20) raised `maxPoints` from 218 to 238. This compresses every score by ~8% (factor = 218/238 ≈ 0.916). Without adjustment:
- `rojo` threshold 17: rows that previously scored just above 17 (e.g., `id+cantidad` = 40/218 ≈ 18.3%) now score 40/238 ≈ 16.8% → dropped to amarillo
- Post-F13 without recalibration: rojo ≈ 2.2% (below the 3% floor)

### Band adjustments

| Parameter | Before F13 | After F13 | Rationale |
|-----------|-----------|-----------|-----------|
| `maxPoints` | 218 | 238 | +20 for `agregado` |
| `amarillo` | 10 | 8 | Split-shipment pair ($4,998 total) scores ~8.4% → must be > amarillo |
| `rojo` | 17 | 15 | Restore rojo% to ≥ 3% target after maxPoints inflation |

### 501-row golden distribution (post-F13)

| Band | Count | % | Target |
|------|-------|---|--------|
| verde | 237 | 47.3% | > 40% ✓ |
| amarillo | 230 | 45.9% | — |
| rojo | 34 | 6.8% | 3–12% ✓ |
| gris | 0 | 0% | — |
| **Total** | **501** | | |

All targets met.

---

## Self-review

- Per-row `monto` cap kept as floor; `agregado` is additive.
- `SPLIT_CAP_USD = 2500` single-sourced in prevalidate.ts; per-row check updated to use it.
- Legacy pedimentos (no `consigneeKey`) fall back via `parseIdFromObservation` → `seq:<n>`, ensuring correct grouping.
- `entityKey` function reused throughout (signals.ts → classify.ts → buildPedimento.ts → prevalidate tests), consistent with F20 coordination note.
- `legacyParity.ts` untouched.
- Staged only the 10 files listed above; unrelated working-tree changes (ConsultaView*, ReportTabs, .gitignore) NOT staged.

## Concerns

None. The recalibration is well within the documented targets. The band changes (`amarillo: 10→8`, `rojo: 17→15`) are conservative and documented in `ruleset.ts` comments with the post-F13 distribution numbers.

F20 coordination note is in place in both `signals.ts` (`entityValueTotal`) and `classify.ts` (`entityValueTotal` build loop).
