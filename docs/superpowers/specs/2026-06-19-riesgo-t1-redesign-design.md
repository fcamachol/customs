# Design Spec — Capital Centennials · Análisis de Riesgo T1 (UI/UX Redesign)

**Date:** 2026-06-19
**Status:** Draft for review
**Scope:** Front-end redesign of all 6 sections + sidebar shell + one minimal backend extension for the Dashboard. No other backend/API changes.

---

## 1. Goal

Redesign the T1 customs risk platform from a top-bar layout into a clean, modern, professional-enterprise application with a **sidebar shell**, anchored to the Capital Centennials brand (navy + gold globe). Deliver real, polished UI for all six sections defined in the requirements PDF. "Simple, clean, but powerful."

### Non-goals
- No rework of the risk-analysis engine, tax engine, or pedimento generation logic.
- No new backend beyond a minimal, role-aware extension of the existing `/api/dashboard` endpoint.
- No authentication/authorization model changes (reuse existing roles + `canSeeAll`).

---

## 2. Users & roles

Three roles already exist (`server/src/auth/access.ts`):
- **capturista** — scoped to their own records. Operational focus.
- **admin** — sees all records and all users. Full access.
- **autoridad** — sees all records, read-only / oversight focus.

The UI is **role-aware**: navigation visibility and Dashboard content adapt per role.

---

## 3. Design language

"Professional-enterprise, but clean" — the rigor of Linear/Mercury (flat, hairline borders, tight type scale) applied with enterprise data density (Flexport-style tables, worst-first sorting).

**Core domain insight:** the traffic light IS the Mexican `semáforo fiscal` — the regulatory mental model the users already live in. It is the spine of the UI and its colors are reserved strictly for risk state, never for brand.

### 3.1 Color tokens
- **Navy** (brand / primary): deep institutional navy from the globe logo (`~#0F2A4A` family). Used for primary buttons, active nav, heading accents, links, focus rings.
- **Gold** (accent — *sparingly*): brand moments only (logo mark, thin active-nav left marker, key dividers). Never applied to data or status.
- **Cool-neutral slate** ramp: page `slate-50`, cards `white`, ink `slate-900`, hairline borders `slate-200`.
- **Semáforo semantics (separate from brand, always pill = color + label):**
  - Verde = `emerald` (libre / aprobado)
  - Amarillo = `amber` (validar en previo / revisión media)
  - Rojo = `red` (revisión / alto riesgo)
  - Gris = neutral (no evaluado)

### 3.2 Typography
- **Inter** for UI, **JetBrains Mono** for IDs/MAWB/guía/números (both already loaded).
- Scale (px): 12 / 14 / 16 / 18 / 24 / 32. Weights 400 / 500 / 600 / 700.
- `tabular-nums`, right-aligned for amounts and counts.

### 3.3 Spacing & surfaces
- 4px base on 8px grid: 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64.
- Radius 6–8px (consistent, not playful).
- Flat-first: 1px hairline borders separate surfaces; **shadows only on overlays** (dropdowns, popovers, modals). Resting cards/tables use borders, not shadows.

### 3.4 Token cleanup
`src/index.css` currently carries a leftover Material blue-purple `@theme` palette that no component uses. Replace it with the navy/gold/slate token set above. Keep the existing scrollbar + drawer animation utilities.

---

## 4. Shell — sidebar (replaces top bar)

Replaces `AppShell.tsx` top bar with a fixed left sidebar; main content shifts right.

```
┌────────────────────┬─────────────────────────────────────────────┐
│ ◍ Capital Cent.    │  <Page title>                                │
│   RIESGO · T1      │  <Page subtitle>                             │
│                    ├─────────────────────────────────────────────┤
│ RESUMEN            │                                             │
│ ▸ Dashboard        │   (active view content)                     │
│ OPERACIÓN          │                                             │
│   Realizar Registro│                                             │
│   Seguimiento      │                                             │
│   Reporte General  │                                             │
│ CONSULTA           │                                             │
│   Consulta         │                                             │
│ SISTEMA            │                                             │
│   Acerca de        │                                             │
│ ──────────────     │                                             │
│ (A) Ana López   ⏻  │                                             │
│     Capturista     │                                             │
└────────────────────┴─────────────────────────────────────────────┘
```

- **Width 240px**, collapsible to a ~64px icon rail (toggle persists in `localStorage`).
- Brand (globe mark + "Capital Centennials" / "RIESGO · T1") at top.
- 6 sections kept verbatim from the PDF, lightly grouped: **RESUMEN** (Dashboard) · **OPERACIÓN** (Realizar Registro, Seguimiento, Reporte General) · **CONSULTA** (Consulta) · **SISTEMA** (Acerca de).
- **Active state** = soft navy-tint fill + thin gold left marker (the one brand flourish). Hover = one neutral step lighter. No heavy left-border template look.
- **Footer** = user avatar + name + role + logout (moved out of the top bar).
- **Role-aware visibility:** `autoridad` sees Dashboard, Consulta, Acerca de (read-only); `capturista`/`admin` see the operational flows. (Exact matrix confirmable; default: hide write-flows from autoridad.)
- **Default landing section = Dashboard** for all roles.
- Page header (title + subtitle, currently in `App.tsx`) stays at the top of the main column.

---

## 5. Sections

### 5.1 Dashboard (landing, role-aware) — PRIMARY

Repurposes the off-spec tax-liquidation `DashboardView` to the PDF spec: *"gráficas de desempeño por usuario y reportes de análisis de riesgo."*

**Role behavior**
- **capturista** → "Mi desempeño": own registros, own semáforo split, own recent análisis. No peer comparison.
- **admin** → global overview + desempeño por usuario (team table), all registros.
- **autoridad** → global, read-only, risk-first; no action CTAs.

**Layout (top → bottom)**
- **A. Header + period filter** — segmented Hoy / 7d / 30d / Todo. Defaults to Todo if backend lacks date-range filtering (flagged).
- **B. KPI row (4 cards), balanced health + throughput** — Registros · Guías analizadas · **% Aprobados (verde)** · **En revisión (rojo)**. Navy/neutral, tabular nums, semáforo dot accents. No emoji, no `border-l-4`.
- **C. Distribución semáforo (spine)** — stacked bar (Verde/Amarillo/Rojo, counts + %), rojo emphasized; optional tendencia mini-bars if time data available. CSS/SVG only.
- **D. Desempeño por usuario** — admin/autoridad: per-capturista table (# registros, # guías, % verde, # rojo; sortable, worst-first). capturista: collapses to own stats.
- **E. Análisis de riesgo recientes** — recent registros table (MAWB · cliente · fecha · semáforo summary pills · capturista [admin] · row action → Consulta detail / download). Worst-first toggle.
- **F. Empty / first-use state** — monochrome icon, "Aún no hay análisis registrados," CTA → Realizar Registro. Distinct from no-results-for-filter.

**Charts:** lightweight CSS/SVG (stacked bar, mini bars, simple donut). No new dependency; `motion` (already installed) for subtle entrance animation.

**Data layer (typed `DashboardData` interface):**
- `GET /api/dashboard` (extended — see §6): role-aware counts + semáforo distribution + per-user breakdown.
- `GET /api/records` (existing, role-scoped): recent análisis.
- Anything unbacked by data (time-trend if no usable timestamp grouping, top-motivos if no reason column) is omitted gracefully or mocked-and-flagged.

### 5.2 Realizar Registro — 3-step flow

Matches PDF Paso 1→2→3, driven by a `Stepper`:
- **Paso 1** — manifest upload: MAWB + Cliente fields + dropzone (.xlsx/.xls/.csv).
- **Paso 2** — "Realizar análisis": the 7 validations (ID, Cantidad, Monto, Consignatarios, Direcciones, Artículos Prohibidos, Piratería, Importaciones por consignatario) shown as a checklist that resolves as analysis runs.
- **Paso 3** — result: summary cards (Analizados / Aprobados / Validar en previo / Rojos) + `semáforo` table (worst-first sort, sticky header, mono IDs, status pills).

Keeps the existing working API calls (`POST /api/manifests`, `POST /api/manifests/:id/risk`). Refactors current single-form `RegistroView` into the stepped flow.

### 5.3 Seguimiento — new build (front-end)

- Search a record (search field per PDF).
- **Pedimento data capture form:** Tasa de importación, Fecha de entrada, T1, Clave T1, Agente Aduanal, Patente, Clave de aduana de entrada, Clave de aduana de despacho, Pedimento.
- **Import Pedimento PDF** dropzone (note 40–80 MB file size).
- Wired to existing endpoints where present (`POST /api/manifests/:id/pedimento`, `POST /api/manifests/:id/pedimento-pdf`); mocked-and-flagged where not.

### 5.4 Reporte General — new build (front-end)

- Two grouped field sets: **Datos del Remitente** (Nombre/razón social, Id fiscal, Domicilio, Teléfono, Correo) and **Datos de la Plataforma** (Nombre comercial, País de origen, Denominación/razón social, Correo) — the exact PDF columns; capturable from a client catalog.
- **Generar Reporte** → produces/downloads the report (manifiesto + pedimento + cliente). Uses existing exports endpoint (`/api/records/:id/report.xlsx`); capture form mocked-and-flagged where backend persistence isn't ready.

### 5.5 Consulta — redesign

- Search → results list → **detail side-panel** with the 3 artifacts as **file cards** (type icon + name + status pill + download): Análisis de Riesgo (XLS), Pedimento (PDF), Reporte General (XLS). Builds on existing `ConsultaView` + endpoints.

### 5.6 Acerca de — re-skin

Clean content layout: company description + Misión / Visión / Valores (content from PDF). Navy/neutral typography.

### 5.7 Login — re-skin

Re-skin from emerald-on-green to **navy gradient + gold globe mark**, matching the PDF login screen. Keep existing auth logic.

---

## 6. Backend extension (minimal, Dashboard only)

Extend `GET /api/dashboard` (`server/src/routes/dashboard.ts`):
1. **Role-aware scope:** if `canSeeAll(role)` → aggregate across all manifests/shipments; else scope to `created_by = userId` (current behavior).
2. **Per-user breakdown:** join `users`, `GROUP BY created_by` → `[{ userId, username, manifests, distribution: {verde, amarillo, rojo} }]` for the "desempeño por usuario" panel (admin/autoridad only).
3. Response shape (additive, backward compatible):
   ```
   {
     manifests: number,
     distribution: { verde, amarillo, rojo },
     byUser?: [{ userId, username, manifests, distribution }]   // when canSeeAll
   }
   ```
- Optional/needs-verification: a "top motivos de riesgo" breakdown depends on whether `shipments` stores a reason column. If absent, omit (not mocked in backend).

---

## 7. Shared UI primitives (new `src/components/ui/`)

Small, focused, reused across all views to keep consistency and files small:
- `Button` — navy primary / neutral secondary / ghost variants.
- `Field` / `Input` — labeled input with focus ring.
- `Card` — flat, hairline border.
- `StatusPill` — semáforo pill (color + label).
- `Stepper` — Paso 1/2/3 progress.
- `PageHeader` — title + subtitle (+ optional actions).
- `EmptyState` — monochrome icon + headline + one CTA.
- `FileCard` — artifact download card (type icon + name + status + action).
- `Sidebar` (+ `SidebarItem`, `SidebarGroup`, `SidebarFooter`) — the shell.

---

## 8. Affected files

**New:** `src/components/ui/*` (primitives), `src/components/Sidebar.tsx`, `src/components/SeguimientoView.tsx`, `src/components/ReporteGeneralView.tsx`.
**Modified:** `src/App.tsx` (sidebar layout, default = dashboard), `src/components/AppShell.tsx` → replaced by Sidebar, `src/components/DashboardView.tsx` (repurpose), `src/components/RegistroView.tsx` (stepper), `src/components/ConsultaView.tsx` (cards + side panel), `src/components/AcercaDeView.tsx`, `src/components/LoginView.tsx`, `src/components/RiskResultTable.tsx` (token/density refresh), `src/index.css` (tokens), `server/src/routes/dashboard.ts` (role-aware + byUser).

---

## 9. Risks & open items

- **Role/nav matrix** for `autoridad` (which write-flows to hide) — default assumption documented; confirm during implementation.
- **Period filter** depends on date-range support; defaults to "Todo" and flagged if unsupported.
- **Seguimiento / Reporte persistence** — capture forms may outrun backend; mocked-and-flagged sections clearly marked for later wiring.
- **Top-motivos** Dashboard panel contingent on a `shipments` reason column; omitted if absent.

---

## 10. Verification

- `npm run lint` (tsc --noEmit) clean.
- `npm test` (vitest) passes; extend/add tests for the dashboard endpoint change.
- Manual: each section renders per role; sidebar collapse persists; semáforo colors correct and accessible (WCAG AA); Dashboard shows real data for admin (all users) vs capturista (own).
