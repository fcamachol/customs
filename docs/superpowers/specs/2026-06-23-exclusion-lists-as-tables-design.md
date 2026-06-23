# Exclusion lists (Prohibidos V6 · Piratería V7) as full tables

**Date:** 2026-06-23
**Component:** `src/components/ConfigurationView.tsx` (`cfg_motor` → `ListasTab`)
**Status:** Approved design — ready for implementation plan

## Problem

The "Artículos prohibidos (V6)" and "Marcas de piratería (V7)" lists are each
edited through a single `<textarea>` (one item per line). The built-in default
keywords/brands are invisible in the UI — the engine silently falls back to them
only when the stored list is empty. Users want to **see the full lists as tables**
and add new entries with a **+ button**.

## Key semantic decision

Today the matcher in `shared/risk/lists.ts` treats a **non-empty** stored list as a
*full replacement* of the defaults:

```ts
const list = brands && brands.length > 0 ? brands : PIRACY_BRANDS;
```

The chosen UX is **"defaults always apply as a locked baseline + user additions on
top."** The effective list must therefore be **defaults ∪ additions**.

This is achieved **without changing the engine or its tests**: the UI persists the
**union** (`dedupe([...DEFAULTS, ...userAdditions])`). Because the engine already
uses a non-empty stored list verbatim, and that list now contains the defaults, the
matching behavior is exactly "defaults + extras." The "locked" status is purely a UI
concept: a row is locked when its normalized value is present in the exported
`PROHIBITED_KEYWORDS` / `PIRACY_BRANDS` constant.

Consequences:

- User never saves → stored list stays empty → engine uses defaults (unchanged).
- After any save → stored = union → engine matches defaults + additions.
- `shared/risk/lists.ts` and `shared/risk/lists.test.ts` remain untouched and green.

## Component design

Introduce one **reusable `ExclusionListCard`** sub-component that replaces the two
near-identical textarea cards. `ListasTab` renders it twice (prohibidos, piratería).

Props:

```ts
interface ExclusionListCardProps {
  title: string;
  icon: typeof Tag;        // lucide icon component
  helperText: string;
  placeholder: string;     // add-input placeholder
  defaults: string[];      // built-in baseline (locked rows)
  items: string[];         // user additions only
  setItems: (v: string[]) => void;
  onSave: () => void;
  isAdmin: boolean;
  saving: boolean;
}
```

### Row ordering (per user request)

1. **User additions first** (top), each deletable — easiest to navigate.
2. **Locked defaults below**, greyed, non-deletable.

### Layout (mirrors the existing Clientes/RFCs table style in this file)

```
┌ Artículos prohibidos (V6) ─────────────────────────┐
│ Lista predeterminada del motor + tus adiciones.     │
│ [ nuevo término…            ]  [ + Agregar ]        │  ← add (Enter or +)
│ ┌─────────────────────────────────────────────────┐ │
│ │ faro                              🗑             │ │  ← user rows (top)
│ │ tornillo                          🗑             │ │
│ │ maquillaje          🔒 Predeterminado           │ │  ← locked defaults
│ │ liquido             🔒 Predeterminado           │ │     (below, no delete)
│ │ … (all 14 / 9 defaults) …                       │ │
│ └─────────────────────────────────────────────────┘ │
│ [ Guardar ]                                          │
└──────────────────────────────────────────────────────┘
```

### Behaviors

- **Add:** text input + `+ Agregar` button; Enter in the input also submits.
  Trims input, ignores blanks, case-insensitive dedup against **both** defaults and
  existing additions (no-op + toast on duplicate). New item is prepended to `items`.
- **Delete:** only user rows have a `Trash2` button; removes from `items`.
- **Save:** existing `Guardar` button. PUTs `dedupe([...defaults, ...items])` to the
  same endpoint (`/api/catalogs/config/prohibited`, `/api/catalogs/config/piracy_brands`).
  Batch save model is unchanged.
- **Non-admin / read-only:** add input, `+ Agregar`, delete buttons, and `Guardar`
  are all disabled (mirrors current `disabled={!isAdmin}`).
- **Show all defaults inline** (14 + 9). No collapse/toggle.

### Normalization

Locked-row detection and dedup use the same accent-insensitive lowercasing as
`shared/risk/lists.ts` `norm()` (NFD + strip diacritics + lowercase). Re-implement a
tiny local `norm` in the component (or import if exported); do not duplicate the
matching logic itself.

## State / data changes (ConfigurationView.tsx only)

- Replace `prohibitedText: string` / `brandsText: string` state with
  `prohibitedItems: string[]` / `brandsItems: string[]` holding **only user
  additions**.
- On load: fetch config as today, then strip out any value matching a default
  (normalized) so only true additions land in state.
- Import `PROHIBITED_KEYWORDS` / `PIRACY_BRANDS` from `shared/risk/lists.ts` (already
  shared and client-importable) — single source of truth, no duplicated constant.
- `saveProhibited` / `saveBrands` send the union instead of the textarea split.
- Remove the now-unused `Textarea` import if no other tab uses it (verify first).

## Testing (TDD — extend `src/components/ConfigurationView.test.tsx`)

1. Default items render as locked, non-deletable rows.
2. User additions render above the defaults.
3. Adding a term prepends a deletable user row.
4. Adding a duplicate (of a default or existing addition, case/accent-insensitive)
   is rejected (no new row).
5. Deleting a user row removes it.
6. `Guardar` PUTs the union (defaults + additions, deduped) to the correct endpoint.

## Out of scope (YAGNI)

Inline editing of existing rows, drag reordering, per-row auto-save, search/filter,
editing or deleting default rows.
