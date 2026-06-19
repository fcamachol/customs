# Riesgo T1 UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the Capital Centennials T1 risk platform into a clean, professional-enterprise app with a navy/gold sidebar shell and a Dashboard-first, role-aware experience across all 6 sections.

**Architecture:** Three phases. **Phase A (Foundation, sequential):** design tokens, shared `ui/` primitives, the Sidebar shell + App wiring, and a role-aware `/api/dashboard` extension — everything downstream depends on these. **Phase B (Sections, parallelizable):** each of the 7 views is rebuilt consuming the locked primitives; each touches only its own file. **Phase C (Verify):** consistency + lint + test sweep.

**Tech Stack:** React 19, TypeScript, Tailwind CSS v4 (`@theme` tokens in `src/index.css`), lucide-react icons, `motion` for animation, Vite, Vitest + @testing-library/react (client, jsdom), Express + Vitest (server). No new dependencies.

## Global Constraints

- **No new npm dependencies.** Charts are CSS/SVG; animation uses `motion` (already installed).
- **Language:** all user-facing copy in Spanish (Mexican). Section names verbatim from the PDF: `Realizar Registro`, `Seguimiento`, `Reporte General`, `Consulta`, `Dashboard`, `Acerca de`.
- **Color discipline:** navy = brand/primary; gold = brand accent only (never on data); `semáforo` colors (`emerald`/`amber`/`red`/neutral-gray) reserved strictly for risk state. Always render risk as a pill = color + label.
- **Surfaces:** flat, 1px hairline borders; shadows only on overlays (dropdowns/modals). Radius 6–8px. Type scale 12/14/16/18/24/32, weights 400/500/600/700. Mono (JetBrains Mono) for IDs/MAWB/guía/amounts; `tabular-nums` + right-align for numbers.
- **Roles:** `capturista` (own records), `admin` (all), `autoridad` (all, read-only). Reuse `canSeeAll` from `server/src/auth/access.ts`.
- **Verification per task:** `npm run lint` (tsc --noEmit) stays clean; `npm test` (client) and `npm --prefix server test` (server) stay green.

---

## File Structure

**New — Phase A:**
- `src/components/ui/Button.tsx` — navy primary / neutral secondary / ghost variants.
- `src/components/ui/Field.tsx` — `Field` (label + input wrapper) and `Input`/`Textarea`.
- `src/components/ui/Card.tsx` — flat card with hairline border.
- `src/components/ui/StatusPill.tsx` — `semáforo` pill + `RESULTADO` typing.
- `src/components/ui/Stepper.tsx` — Paso 1/2/3 progress.
- `src/components/ui/PageHeader.tsx` — title + subtitle + optional actions slot.
- `src/components/ui/EmptyState.tsx` — monochrome icon + headline + one CTA.
- `src/components/ui/FileCard.tsx` — artifact download card.
- `src/components/ui/index.ts` — barrel re-export.
- `src/components/Sidebar.tsx` — sidebar shell (+ inline `SidebarItem`/group helpers).
- `src/nav.ts` — `Section` type, `NAV_GROUPS`, `SECTION_META`, `visibleSectionsFor(role)`.
- `server/src/routes/dashboardData.ts` — pure helpers `mergeDistribution`, `buildDashboardResponse`.

**New — Phase B:**
- `src/components/SeguimientoView.tsx`
- `src/components/ReporteGeneralView.tsx`

**Modified:**
- `src/index.css` — replace Material `@theme` palette with navy/gold/slate tokens.
- `src/App.tsx` — sidebar layout, default section = `dashboard`, role-aware rendering.
- `src/components/AppShell.tsx` — **deleted** (replaced by `Sidebar.tsx`); `AppShell.test.tsx` replaced by `Sidebar.test.tsx`.
- `src/components/DashboardView.tsx` — repurpose to risk/desempeño dashboard.
- `src/components/RegistroView.tsx` — 3-step stepper flow.
- `src/components/ConsultaView.tsx` — file cards + detail panel.
- `src/components/AcercaDeView.tsx` — content layout.
- `src/components/LoginView.tsx` — navy/gold re-skin.
- `src/components/RiskResultTable.tsx` — token/density refresh, use `StatusPill`.
- `server/src/routes/dashboard.ts` — role-aware + `byUser`, delegating to `dashboardData.ts`.

---

# PHASE A — Foundation (build sequentially; review before Phase B)

### Task A1: Design tokens

**Files:**
- Modify: `src/index.css`

**Interfaces:**
- Produces: Tailwind theme color utilities `bg-navy-*`, `text-navy-*`, `bg-gold-*`, plus the existing slate/emerald/amber/red Tailwind defaults. Fonts `font-sans` (Inter), `font-mono` (JetBrains Mono) unchanged.

- [ ] **Step 1: Replace the `@theme` block.** Swap the Material blue-purple variables for a navy + gold ramp; keep the font + scrollbar + drawer-animation sections at the bottom of the file untouched. Use these exact values:

```css
@theme {
  --color-navy-50:  #eef2f8;
  --color-navy-100: #d6e0ee;
  --color-navy-200: #aec2dc;
  --color-navy-300: #7d9cc4;
  --color-navy-400: #4d72a4;
  --color-navy-500: #2f547f;
  --color-navy-600: #1f3e63;
  --color-navy-700: #16304f;
  --color-navy-800: #0f2a4a; /* primary */
  --color-navy-900: #0a1d35;
  --color-navy-950: #061226;

  --color-gold-300: #e7cd8f;
  --color-gold-400: #d8b45c;
  --color-gold-500: #c8a04b; /* accent */
  --color-gold-600: #a9853a;

  --font-sans: "Inter", ui-sans-serif, system-ui, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, monospace;
}

body {
  font-family: var(--font-sans);
  background-color: #f8fafc; /* slate-50 */
  color: #0f172a;            /* slate-900 */
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
```

  Keep the existing `.custom-scrollbar`, `.glass-card`, and `@keyframes drawer-in/fade-in` blocks below `body`.

- [ ] **Step 2: Verify build.** Run: `npm run lint` — Expected: PASS (no TS errors; CSS isn't type-checked but the import must remain valid). Then `npm run build` — Expected: completes without CSS parse errors.

- [ ] **Step 3: Commit.**

```bash
git add src/index.css
git commit -m "feat(ui): navy/gold design tokens, replace leftover Material palette"
```

---

### Task A2: Shared `ui/` primitives

**Files:**
- Create: `src/components/ui/Button.tsx`, `Field.tsx`, `Card.tsx`, `StatusPill.tsx`, `Stepper.tsx`, `PageHeader.tsx`, `EmptyState.tsx`, `FileCard.tsx`, `index.ts`
- Test: `src/components/ui/StatusPill.test.tsx`

**Interfaces:**
- Produces (imported across all Phase B views):
  - `Button({ variant?: 'primary'|'secondary'|'ghost', ...buttonProps })`
  - `Field({ label, htmlFor, children })`, `Input(inputProps)`, `Textarea(textareaProps)`
  - `Card({ className?, children })`
  - `type Resultado = 'verde'|'amarillo'|'rojo'|'gris'`; `StatusPill({ resultado, label? })`
  - `Stepper({ steps: string[], current: number })` (0-indexed)
  - `PageHeader({ title, subtitle, actions? })`
  - `EmptyState({ icon, title, message?, cta? })` where `cta?: { label, onClick }`
  - `FileCard({ kind: 'xls'|'pdf', name, status?, onDownload? })`

- [ ] **Step 1: Write the failing test for `StatusPill`.**

```tsx
// src/components/ui/StatusPill.test.tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusPill } from './StatusPill';

describe('StatusPill', () => {
  it('renders the resultado label capitalized by default', () => {
    render(<StatusPill resultado="verde" />);
    expect(screen.getByText('Verde')).toBeTruthy();
  });
  it('uses a custom label when provided', () => {
    render(<StatusPill resultado="rojo" label="Artículos prohibidos" />);
    expect(screen.getByText('Artículos prohibidos')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it — Expected: FAIL** (`Cannot find module './StatusPill'`). Run: `npx vitest run src/components/ui/StatusPill.test.tsx`

- [ ] **Step 3: Implement `StatusPill.tsx`.**

```tsx
export type Resultado = 'verde' | 'amarillo' | 'rojo' | 'gris';

const STYLES: Record<Resultado, { badge: string; dot: string; label: string }> = {
  verde:    { badge: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20', dot: 'bg-emerald-500', label: 'Verde' },
  amarillo: { badge: 'bg-amber-50 text-amber-700 ring-amber-600/20',       dot: 'bg-amber-500',   label: 'Amarillo' },
  rojo:     { badge: 'bg-red-50 text-red-700 ring-red-600/20',             dot: 'bg-red-500',     label: 'Rojo' },
  gris:     { badge: 'bg-slate-100 text-slate-600 ring-slate-500/20',      dot: 'bg-slate-400',   label: 'Sin evaluar' },
};

export function StatusPill({ resultado, label }: { resultado: Resultado; label?: string }) {
  const s = STYLES[resultado];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${s.badge}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {label ?? s.label}
    </span>
  );
}
```

- [ ] **Step 4: Implement the remaining primitives.** Each is small and flat. Use these exact implementations:

```tsx
// Button.tsx
import type { ButtonHTMLAttributes } from 'react';
type Variant = 'primary' | 'secondary' | 'ghost';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-navy-800 text-white hover:bg-navy-700 shadow-sm',
  secondary: 'border border-slate-300 bg-white text-slate-700 hover:border-navy-400 hover:text-navy-800',
  ghost: 'text-slate-500 hover:bg-slate-100 hover:text-slate-800',
};
export function Button({ variant = 'primary', className = '', ...props }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${VARIANTS[variant]} ${className}`}
      {...props}
    />
  );
}
```

```tsx
// Field.tsx
import type { InputHTMLAttributes, TextareaHTMLAttributes, ReactNode } from 'react';
export function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-slate-600">{label}</label>
      {children}
    </div>
  );
}
const FIELD = 'w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-navy-500 focus:ring-2 focus:ring-navy-500/25';
export function Input({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`${FIELD} ${className}`} {...props} />;
}
export function Textarea({ className = '', ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`${FIELD} ${className}`} {...props} />;
}
```

```tsx
// Card.tsx
import type { ReactNode } from 'react';
export function Card({ className = '', children }: { className?: string; children: ReactNode }) {
  return <div className={`rounded-xl border border-slate-200 bg-white ${className}`}>{children}</div>;
}
```

```tsx
// Stepper.tsx
export function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="flex items-center gap-2">
      {steps.map((label, i) => {
        const state = i < current ? 'done' : i === current ? 'active' : 'todo';
        const dot = state === 'done' ? 'bg-navy-800 text-white' : state === 'active' ? 'bg-navy-800 text-white ring-4 ring-navy-800/15' : 'bg-slate-200 text-slate-500';
        const text = state === 'todo' ? 'text-slate-400' : 'text-slate-800';
        return (
          <li key={label} className="flex items-center gap-2">
            <span className={`grid h-7 w-7 place-items-center rounded-full text-xs font-bold ${dot}`}>{i + 1}</span>
            <span className={`text-sm font-medium ${text}`}>{label}</span>
            {i < steps.length - 1 && <span className="mx-1 h-px w-8 bg-slate-200" />}
          </li>
        );
      })}
    </ol>
  );
}
```

```tsx
// PageHeader.tsx
import type { ReactNode } from 'react';
export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <header className="mb-6 flex items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}
```

```tsx
// EmptyState.tsx
import type { LucideIcon } from 'lucide-react';
import { Button } from './Button';
export function EmptyState({ icon: Icon, title, message, cta }:
  { icon: LucideIcon; title: string; message?: string; cta?: { label: string; onClick: () => void } }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white px-6 py-20 text-center">
      <div className="grid h-12 w-12 place-items-center rounded-full bg-slate-100 text-slate-400"><Icon className="h-6 w-6" /></div>
      <p className="mt-4 text-sm font-semibold text-slate-700">{title}</p>
      {message && <p className="mt-1 max-w-sm text-sm text-slate-500">{message}</p>}
      {cta && <Button className="mt-4" onClick={cta.onClick}>{cta.label}</Button>}
    </div>
  );
}
```

```tsx
// FileCard.tsx
import { FileSpreadsheet, FileText, Download } from 'lucide-react';
export function FileCard({ kind, name, status, onDownload }:
  { kind: 'xls' | 'pdf'; name: string; status?: string; onDownload?: () => void }) {
  const Icon = kind === 'pdf' ? FileText : FileSpreadsheet;
  const tint = kind === 'pdf' ? 'text-red-600 bg-red-50' : 'text-emerald-600 bg-emerald-50';
  return (
    <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-3">
      <div className={`grid h-10 w-10 shrink-0 place-items-center rounded-lg ${tint}`}><Icon className="h-5 w-5" /></div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold text-slate-800">{name}</div>
        {status && <div className="text-xs text-slate-500">{status}</div>}
      </div>
      {onDownload && (
        <button onClick={onDownload} aria-label={`Descargar ${name}`}
          className="grid h-9 w-9 place-items-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-navy-700">
          <Download className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
```

```ts
// index.ts
export { Button } from './Button';
export { Field, Input, Textarea } from './Field';
export { Card } from './Card';
export { StatusPill, type Resultado } from './StatusPill';
export { Stepper } from './Stepper';
export { PageHeader } from './PageHeader';
export { EmptyState } from './EmptyState';
export { FileCard } from './FileCard';
```

- [ ] **Step 5: Run tests + lint — Expected: PASS.** `npx vitest run src/components/ui/StatusPill.test.tsx && npm run lint`

- [ ] **Step 6: Commit.**

```bash
git add src/components/ui
git commit -m "feat(ui): shared primitives (Button, Field, Card, StatusPill, Stepper, PageHeader, EmptyState, FileCard)"
```

---

### Task A3: Navigation model + Sidebar shell + App wiring

**Files:**
- Create: `src/nav.ts`, `src/components/Sidebar.tsx`, `src/components/Sidebar.test.tsx`
- Modify: `src/App.tsx`
- Delete: `src/components/AppShell.tsx`, `src/components/AppShell.test.tsx`

**Interfaces:**
- Consumes: `useAuth()` (`user.role`, `user.username`, `logout`) from `src/context/AuthContext`.
- Produces:
  - `src/nav.ts`: `type Section = 'dashboard'|'registro'|'seguimiento'|'reporte'|'consulta'|'acerca'`; `SECTION_META: Record<Section,{title,subtitle}>`; `NAV_GROUPS: { label: string; items: { id: Section; label: string; icon: LucideIcon }[] }[]`; `visibleSectionsFor(role: string): Section[]`.
  - `Sidebar({ role, active, onSelect, username, onLogout })`.

> Note: the `seguimiento`/`reporte`/`consulta`/`acerca`/`dashboard`/`registro` ids replace the old `Section` union in `AppShell.tsx`. Default section becomes `dashboard`.

- [ ] **Step 1: Write `src/nav.ts`.**

```ts
import { LayoutDashboard, FilePlus2, Activity, FileBarChart2, Search, Info, type LucideIcon } from 'lucide-react';

export type Section = 'dashboard' | 'registro' | 'seguimiento' | 'reporte' | 'consulta' | 'acerca';

export const SECTION_META: Record<Section, { title: string; subtitle: string }> = {
  dashboard:  { title: 'Dashboard', subtitle: 'Desempeño operativo y análisis de riesgo en tiempo real.' },
  registro:   { title: 'Realizar Registro', subtitle: 'Carga un manifiesto y ejecuta el análisis de riesgo T1.' },
  seguimiento:{ title: 'Seguimiento', subtitle: 'Captura de pedimento e importación del documento.' },
  reporte:    { title: 'Reporte General', subtitle: 'Datos de remitente y plataforma, y generación del reporte.' },
  consulta:   { title: 'Consulta', subtitle: 'Busca registros previos y descarga sus artefactos.' },
  acerca:     { title: 'Acerca de', subtitle: 'Plataforma de análisis de riesgo y cumplimiento T1.' },
};

export const NAV_GROUPS: { label: string; items: { id: Section; label: string; icon: LucideIcon }[] }[] = [
  { label: 'Resumen', items: [{ id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard }] },
  { label: 'Operación', items: [
    { id: 'registro', label: 'Realizar Registro', icon: FilePlus2 },
    { id: 'seguimiento', label: 'Seguimiento', icon: Activity },
    { id: 'reporte', label: 'Reporte General', icon: FileBarChart2 },
  ] },
  { label: 'Consulta', items: [{ id: 'consulta', label: 'Consulta', icon: Search }] },
  { label: 'Sistema', items: [{ id: 'acerca', label: 'Acerca de', icon: Info }] },
];

// autoridad is read-only: hide the write-flows (registro/seguimiento/reporte).
export function visibleSectionsFor(role: string): Section[] {
  if (role === 'autoridad') return ['dashboard', 'consulta', 'acerca'];
  return ['dashboard', 'registro', 'seguimiento', 'reporte', 'consulta', 'acerca'];
}
```

- [ ] **Step 2: Write the failing Sidebar test.**

```tsx
// src/components/Sidebar.test.tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Sidebar } from './Sidebar';

describe('Sidebar', () => {
  it('shows all sections for admin including Dashboard first', () => {
    render(<Sidebar role="admin" active="dashboard" onSelect={() => {}} username="Ana" onLogout={() => {}} />);
    for (const label of ['Dashboard', 'Realizar Registro', 'Seguimiento', 'Reporte General', 'Consulta', 'Acerca de']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it('hides write-flows for autoridad', () => {
    render(<Sidebar role="autoridad" active="dashboard" onSelect={() => {}} username="Inspector" onLogout={() => {}} />);
    expect(screen.getByText('Dashboard')).toBeTruthy();
    expect(screen.queryByText('Realizar Registro')).toBeNull();
    expect(screen.queryByText('Reporte General')).toBeNull();
  });
});
```

- [ ] **Step 3: Run — Expected: FAIL** (no `Sidebar` module). `npx vitest run src/components/Sidebar.test.tsx`

- [ ] **Step 4: Implement `Sidebar.tsx`.** Fixed 240px column (collapse can be added later; not required for tests). Active = navy-tint fill + gold left marker. Footer = avatar + name + role + logout. Filter `NAV_GROUPS` items by `visibleSectionsFor(role)`.

```tsx
import { useState } from 'react';
import { ShieldCheck, LogOut } from 'lucide-react';
import { NAV_GROUPS, visibleSectionsFor, type Section } from '../nav';

const ROLE_LABELS: Record<string, string> = { capturista: 'Capturista', admin: 'Administrador', autoridad: 'Autoridad' };

export function Sidebar({ role, active, onSelect, username, onLogout }: {
  role: string; active: Section; onSelect: (s: Section) => void; username?: string; onLogout?: () => void;
}) {
  const [collapsed, setCollapsed] = useState<boolean>(() => localStorage.getItem('sidebar:collapsed') === '1');
  const visible = new Set(visibleSectionsFor(role));
  const toggle = () => { const v = !collapsed; setCollapsed(v); localStorage.setItem('sidebar:collapsed', v ? '1' : '0'); };

  return (
    <aside className={`${collapsed ? 'w-16' : 'w-60'} sticky top-0 flex h-screen shrink-0 flex-col border-r border-slate-200 bg-white transition-[width]`}>
      <div className="flex h-16 items-center gap-2.5 px-4 select-none">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-navy-800 text-white shadow-sm">
          <ShieldCheck className="h-5 w-5" />
        </div>
        {!collapsed && (
          <div className="leading-tight">
            <div className="text-sm font-bold tracking-tight text-slate-900">Capital Centennials</div>
            <div className="font-mono text-[10px] font-bold uppercase tracking-[0.22em] text-gold-600">Riesgo · T1</div>
          </div>
        )}
      </div>

      <nav className="flex-1 overflow-y-auto px-2 py-2">
        {NAV_GROUPS.map((group) => {
          const items = group.items.filter((it) => visible.has(it.id));
          if (!items.length) return null;
          return (
            <div key={group.label} className="mb-3">
              {!collapsed && <div className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-400">{group.label}</div>}
              {items.map((it) => {
                const Icon = it.icon; const isActive = active === it.id;
                return (
                  <button key={it.id} onClick={() => onSelect(it.id)} aria-current={isActive} title={it.label}
                    className={`relative flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition ${
                      isActive ? 'bg-navy-50 text-navy-800' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-800'}`}>
                    {isActive && <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-gold-500" />}
                    <Icon className="h-4 w-4 shrink-0" />
                    {!collapsed && it.label}
                  </button>
                );
              })}
            </div>
          );
        })}
      </nav>

      <div className="border-t border-slate-200 p-3">
        <div className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-slate-100 text-sm font-bold uppercase text-slate-500">
            {(username ?? role).charAt(0)}
          </span>
          {!collapsed && (
            <div className="min-w-0 flex-1 leading-tight">
              <div className="truncate text-sm font-semibold text-slate-800">{username}</div>
              <div className="text-xs text-slate-500">{ROLE_LABELS[role] ?? role}</div>
            </div>
          )}
          {onLogout && (
            <button onClick={onLogout} title="Cerrar sesión" aria-label="Cerrar sesión"
              className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-700">
              <LogOut className="h-4 w-4" />
            </button>
          )}
        </div>
        {!collapsed && (
          <button onClick={toggle} className="mt-2 w-full rounded-md px-2 py-1 text-left text-[11px] text-slate-400 hover:text-slate-600">Colapsar ‹</button>
        )}
        {collapsed && (
          <button onClick={toggle} aria-label="Expandir" className="mt-2 w-full text-center text-slate-400 hover:text-slate-600">›</button>
        )}
      </div>
    </aside>
  );
}
```

- [ ] **Step 5: Rewrite `src/App.tsx`** to a sidebar + main layout, default `dashboard`, importing `Section`/`SECTION_META` from `src/nav.ts` and `PageHeader` from `ui`. Replace the entire `AuthenticatedApp` function and the `SECTION_META`/`EmptyState`/icon imports at the top.

```tsx
import { useState } from 'react';
import { T1Provider } from './context/T1Context';
import { AuthProvider, useAuth } from './context/AuthContext';
import { Sidebar } from './components/Sidebar';
import { PageHeader } from './components/ui';
import { SECTION_META, visibleSectionsFor, type Section } from './nav';
import { LoginView } from './components/LoginView';
import { AcercaDeView } from './components/AcercaDeView';
import DashboardView from './components/DashboardView';
import RegistroView from './components/RegistroView';
import ConsultaView from './components/ConsultaView';
import SeguimientoView from './components/SeguimientoView';
import ReporteGeneralView from './components/ReporteGeneralView';

function AuthenticatedApp() {
  const { user, logout } = useAuth();
  const [section, setSection] = useState<Section>('dashboard');
  const allowed = visibleSectionsFor(user!.role);
  const current = allowed.includes(section) ? section : 'dashboard';
  const meta = SECTION_META[current];

  return (
    <div className="flex min-h-screen bg-slate-50 font-sans text-slate-900 antialiased">
      <Sidebar role={user!.role} active={current} onSelect={setSection} username={user!.username} onLogout={logout} />
      <main className="min-w-0 flex-1 px-8 py-8">
        <div className="mx-auto max-w-7xl">
          <PageHeader title={meta.title} subtitle={meta.subtitle} />
          {current === 'dashboard' && <DashboardView onNavigate={setSection} />}
          {current === 'registro' && <RegistroView />}
          {current === 'seguimiento' && <SeguimientoView />}
          {current === 'reporte' && <ReporteGeneralView />}
          {current === 'consulta' && <ConsultaView />}
          {current === 'acerca' && <AcercaDeView />}
        </div>
      </main>
    </div>
  );
}

function AuthGate() {
  const { user } = useAuth();
  if (!user) return <LoginView />;
  return (<T1Provider><AuthenticatedApp /></T1Provider>);
}

export default function App() {
  return (<AuthProvider><AuthGate /></AuthProvider>);
}
```

> `DashboardView` gains an `onNavigate?: (s: Section) => void` prop (Task B1). `SeguimientoView`/`ReporteGeneralView` are created in Phase B; until then, lint will fail on the missing imports — create stub files returning `null` if executing A3 before B, or execute B3/B4 before re-running lint. (Subagent-driven execution: create one-line stubs in this task to keep lint green.)

- [ ] **Step 6: Create stubs** so the foundation lints green independently:

```tsx
// src/components/SeguimientoView.tsx (stub — replaced in Task B3)
export default function SeguimientoView() { return null; }
// src/components/ReporteGeneralView.tsx (stub — replaced in Task B4)
export default function ReporteGeneralView() { return null; }
```

- [ ] **Step 7: Delete the old shell.** `git rm src/components/AppShell.tsx src/components/AppShell.test.tsx`

- [ ] **Step 8: Run tests + lint — Expected: PASS.** `npm test && npm run lint`

- [ ] **Step 9: Commit.**

```bash
git add -A
git commit -m "feat(ui): sidebar shell + role-aware nav, dashboard-first; remove top-bar AppShell"
```

---

### Task A4: Role-aware `/api/dashboard` (server)

**Files:**
- Create: `server/src/routes/dashboardData.ts`, `server/src/routes/dashboardData.test.ts`
- Modify: `server/src/routes/dashboard.ts`

**Interfaces:**
- Produces:
  - `type Distribution = { verde: number; amarillo: number; rojo: number }`
  - `mergeDistribution(rows: { risk_color: string; n: number }[]): Distribution`
  - `buildDashboardResponse(input: { manifests: number; distRows: {risk_color:string;n:number}[]; byUserRows?: { userId: string; username: string; manifests: number; risk_color: string | null; n: number }[] }): { manifests: number; distribution: Distribution; byUser?: { userId: string; username: string; manifests: number; distribution: Distribution }[] }`
- Consumes: `query` from `../db/pool`, `requireAuth`, `canSeeAll`.

- [ ] **Step 1: Write the failing test.**

```ts
// server/src/routes/dashboardData.test.ts
import { describe, expect, it } from 'vitest';
import { mergeDistribution, buildDashboardResponse } from './dashboardData';

describe('mergeDistribution', () => {
  it('fills missing colors with zero', () => {
    expect(mergeDistribution([{ risk_color: 'verde', n: 5 }, { risk_color: 'rojo', n: 2 }]))
      .toEqual({ verde: 5, amarillo: 0, rojo: 2 });
  });
});

describe('buildDashboardResponse', () => {
  it('omits byUser when no byUserRows', () => {
    const r = buildDashboardResponse({ manifests: 3, distRows: [{ risk_color: 'verde', n: 9 }] });
    expect(r).toEqual({ manifests: 3, distribution: { verde: 9, amarillo: 0, rojo: 0 } });
    expect(r.byUser).toBeUndefined();
  });
  it('groups per-user distributions and manifest counts', () => {
    const r = buildDashboardResponse({
      manifests: 2,
      distRows: [{ risk_color: 'verde', n: 4 }, { risk_color: 'rojo', n: 1 }],
      byUserRows: [
        { userId: 'u1', username: 'Ana', manifests: 1, risk_color: 'verde', n: 3 },
        { userId: 'u1', username: 'Ana', manifests: 1, risk_color: 'rojo', n: 1 },
        { userId: 'u2', username: 'Beto', manifests: 1, risk_color: 'verde', n: 1 },
      ],
    });
    expect(r.byUser).toEqual([
      { userId: 'u1', username: 'Ana', manifests: 1, distribution: { verde: 3, amarillo: 0, rojo: 1 } },
      { userId: 'u2', username: 'Beto', manifests: 1, distribution: { verde: 1, amarillo: 0, rojo: 0 } },
    ]);
  });
});
```

- [ ] **Step 2: Run — Expected: FAIL.** `npm --prefix server test -- dashboardData`

- [ ] **Step 3: Implement `dashboardData.ts`.**

```ts
export type Distribution = { verde: number; amarillo: number; rojo: number };

export function mergeDistribution(rows: { risk_color: string; n: number }[]): Distribution {
  const d: Distribution = { verde: 0, amarillo: 0, rojo: 0 };
  for (const r of rows) if (r.risk_color in d) d[r.risk_color as keyof Distribution] = r.n;
  return d;
}

export function buildDashboardResponse(input: {
  manifests: number;
  distRows: { risk_color: string; n: number }[];
  byUserRows?: { userId: string; username: string; manifests: number; risk_color: string | null; n: number }[];
}): { manifests: number; distribution: Distribution; byUser?: { userId: string; username: string; manifests: number; distribution: Distribution }[] } {
  const base = { manifests: input.manifests, distribution: mergeDistribution(input.distRows) };
  if (!input.byUserRows) return base;
  const map = new Map<string, { userId: string; username: string; manifests: number; distribution: Distribution }>();
  for (const row of input.byUserRows) {
    let u = map.get(row.userId);
    if (!u) { u = { userId: row.userId, username: row.username, manifests: row.manifests, distribution: { verde: 0, amarillo: 0, rojo: 0 } }; map.set(row.userId, u); }
    if (row.risk_color && row.risk_color in u.distribution) u.distribution[row.risk_color as keyof Distribution] = row.n;
  }
  return { ...base, byUser: Array.from(map.values()) };
}
```

- [ ] **Step 4: Run — Expected: PASS.** `npm --prefix server test -- dashboardData`

- [ ] **Step 5: Wire the route** in `dashboard.ts` to use the helpers + `canSeeAll`.

```ts
import { Router } from 'express';
import { query } from '../db/pool';
import { requireAuth } from '../auth/middleware';
import { canSeeAll } from '../auth/access';
import { buildDashboardResponse } from './dashboardData';

export const dashboardRouter = Router();

dashboardRouter.get('/', requireAuth, async (req, res) => {
  const all = canSeeAll(req.user!.role);
  const scope = all ? '' : ' WHERE created_by=$1';
  const args = all ? [] : [req.user!.userId];

  const m = await query(`SELECT count(*)::int AS n FROM manifests${scope}`, args);
  const d = await query(
    `SELECT s.risk_color, count(*)::int AS n
     FROM shipments s JOIN manifests mf ON mf.id=s.manifest_id
     WHERE s.risk_color IS NOT NULL${all ? '' : ' AND mf.created_by=$1'}
     GROUP BY s.risk_color`, args);

  let byUserRows;
  if (all) {
    const bu = await query(
      `SELECT mf.created_by AS "userId", u.username,
              (SELECT count(*)::int FROM manifests m2 WHERE m2.created_by=mf.created_by) AS manifests,
              s.risk_color, count(*)::int AS n
       FROM shipments s
       JOIN manifests mf ON mf.id=s.manifest_id
       JOIN users u ON u.id=mf.created_by
       WHERE s.risk_color IS NOT NULL
       GROUP BY mf.created_by, u.username, s.risk_color
       ORDER BY u.username`, []);
    byUserRows = bu.rows;
  }

  res.json(buildDashboardResponse({ manifests: m.rows[0].n, distRows: d.rows, byUserRows }));
});
```

> Verify the `users` table column names (`id`, `username`) against `server/src/routes/users.ts` before finalizing; adjust the `JOIN users u` columns if they differ.

- [ ] **Step 6: Run server tests + client lint — Expected: PASS.** `npm --prefix server test && npm run lint`

- [ ] **Step 7: Commit.**

```bash
git add server/src/routes/dashboard.ts server/src/routes/dashboardData.ts server/src/routes/dashboardData.test.ts
git commit -m "feat(server): role-aware dashboard with per-user risk breakdown"
```

---

# PHASE B — Sections (each task touches only its own view; parallelizable after Phase A)

### Task B1: Dashboard view

**Files:**
- Modify: `src/components/DashboardView.tsx` (full rewrite)
- Test: `src/components/DashboardView.test.tsx`

**Interfaces:**
- Consumes: `Card`, `StatusPill`, `EmptyState`, `PageHeader` from `ui`; `apiGet` from `../api`; `type Section` from `../nav`.
- Produces: `DashboardView({ onNavigate }: { onNavigate?: (s: Section) => void })` (default export).
- API contract: `GET /api/dashboard` → `{ manifests, distribution:{verde,amarillo,rojo}, byUser?: [{userId,username,manifests,distribution}] }`; `GET /api/records?q=` → `[{ id, mawbReference, clientName, createdAt }]`.

- [ ] **Step 1: Write the failing test** (mock `../api`).

```tsx
// src/components/DashboardView.test.tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import DashboardView from './DashboardView';

vi.mock('../api', () => ({
  apiGet: vi.fn((path: string) =>
    path.startsWith('/api/dashboard')
      ? Promise.resolve({ manifests: 2, distribution: { verde: 9, amarillo: 1, rojo: 2 },
          byUser: [{ userId: 'u1', username: 'Ana', manifests: 2, distribution: { verde: 9, amarillo: 1, rojo: 2 } }] })
      : Promise.resolve([{ id: 'r1', mawbReference: '369-94705516', clientName: 'Cliente X', createdAt: '2026-06-19' }])),
}));

describe('DashboardView', () => {
  beforeEach(() => vi.clearAllMocks());
  it('renders KPI totals and per-user performance', async () => {
    render(<DashboardView />);
    await waitFor(() => expect(screen.getByText('369-94705516')).toBeTruthy());
    expect(screen.getByText('Ana')).toBeTruthy();      // desempeño por usuario
    expect(screen.getByText(/Registros/i)).toBeTruthy();// KPI label
  });
});
```

- [ ] **Step 2: Run — Expected: FAIL** (current DashboardView reads T1Context, not the API). `npx vitest run src/components/DashboardView.test.tsx`

- [ ] **Step 3: Rewrite `DashboardView.tsx`.** Replace the entire file. Sections: KPI row (Registros, Guías analizadas = verde+amarillo+rojo, % Aprobados = verde/guías, En revisión = rojo), `DistribucionSemaforo` stacked bar, `DesempenoPorUsuario` table (when `byUser` present), `AnalisisRecientes` list (from `/api/records`), and `EmptyState` (icon `LayoutDashboard`, CTA "Realizar Registro" → `onNavigate?.('registro')`) when `manifests === 0`. Implementation outline (write fully):

```tsx
import { useEffect, useState } from 'react';
import { LayoutDashboard, FileSpreadsheet } from 'lucide-react';
import { apiGet } from '../api';
import { Card, EmptyState } from './ui';
import type { Section } from '../nav';

type Distribution = { verde: number; amarillo: number; rojo: number };
interface DashboardData { manifests: number; distribution: Distribution; byUser?: { userId: string; username: string; manifests: number; distribution: Distribution }[]; }
interface RecordSummary { id: string; mawbReference: string; clientName: string; createdAt: string; }

const sum = (d: Distribution) => d.verde + d.amarillo + d.rojo;
const pct = (n: number, total: number) => (total ? Math.round((n / total) * 1000) / 10 : 0);

export default function DashboardView({ onNavigate }: { onNavigate?: (s: Section) => void }) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [recientes, setRecientes] = useState<RecordSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<DashboardData>('/api/dashboard').then(setData).catch((e) => setError(e.message));
    apiGet<RecordSummary[]>('/api/records?q=').then((r) => setRecientes(r.slice(0, 8))).catch(() => {});
  }, []);

  if (error) return <Card className="p-4 text-sm text-red-700">{error}</Card>;
  if (!data) return <Card className="p-10 text-center text-sm text-slate-400">Cargando…</Card>;
  if (data.manifests === 0) {
    return <EmptyState icon={LayoutDashboard} title="Aún no hay análisis registrados"
      message="Carga tu primer manifiesto para ver métricas de riesgo aquí."
      cta={onNavigate ? { label: 'Realizar Registro', onClick: () => onNavigate('registro') } : undefined} />;
  }

  const guias = sum(data.distribution);
  const kpis = [
    { label: 'Registros', value: data.manifests, tone: 'text-slate-900' },
    { label: 'Guías analizadas', value: guias.toLocaleString('es-MX'), tone: 'text-slate-900' },
    { label: '% Aprobados', value: `${pct(data.distribution.verde, guias)}%`, tone: 'text-emerald-600' },
    { label: 'En revisión', value: data.distribution.rojo, tone: 'text-red-600' },
  ];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {kpis.map((k) => (
          <Card key={k.label} className="p-4">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{k.label}</div>
            <div className={`mt-1.5 text-3xl font-bold tabular-nums tracking-tight ${k.tone}`}>{k.value}</div>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="p-5 lg:col-span-2">
          <h3 className="mb-4 text-sm font-bold text-slate-800">Distribución semáforo</h3>
          <div className="flex h-3 overflow-hidden rounded-full bg-slate-100">
            <div className="bg-emerald-500" style={{ width: `${pct(data.distribution.verde, guias)}%` }} />
            <div className="bg-amber-500" style={{ width: `${pct(data.distribution.amarillo, guias)}%` }} />
            <div className="bg-red-500" style={{ width: `${pct(data.distribution.rojo, guias)}%` }} />
          </div>
          <div className="mt-3 flex gap-4 text-xs text-slate-600">
            <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-emerald-500" />Verde {data.distribution.verde}</span>
            <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-amber-500" />Amarillo {data.distribution.amarillo}</span>
            <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-red-500" />Rojo {data.distribution.rojo}</span>
          </div>
        </Card>

        {data.byUser && (
          <Card className="p-5">
            <h3 className="mb-4 text-sm font-bold text-slate-800">Desempeño por usuario</h3>
            <ul className="space-y-2.5">
              {data.byUser.map((u) => {
                const g = sum(u.distribution);
                return (
                  <li key={u.userId} className="flex items-center justify-between text-sm">
                    <span className="font-medium text-slate-700">{u.username}</span>
                    <span className="tabular-nums text-slate-500">{u.manifests} reg · {pct(u.distribution.verde, g)}% verde · {u.distribution.rojo} rojo</span>
                  </li>
                );
              })}
            </ul>
          </Card>
        )}
      </div>

      <Card className="p-5">
        <h3 className="mb-4 text-sm font-bold text-slate-800">Análisis de riesgo recientes</h3>
        {recientes.length === 0 ? (
          <p className="text-sm text-slate-400">Sin registros recientes.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {recientes.map((r) => (
              <li key={r.id}>
                <button onClick={() => onNavigate?.('consulta')}
                  className="flex w-full items-center justify-between py-2.5 text-left text-sm transition hover:bg-slate-50">
                  <span className="flex items-center gap-2">
                    <FileSpreadsheet className="h-4 w-4 text-emerald-600" />
                    <span className="font-mono text-xs text-slate-600">{r.mawbReference}</span>
                    <span className="text-slate-500">— {r.clientName}</span>
                  </span>
                  <span className="text-xs text-slate-400">{r.createdAt}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
```

- [ ] **Step 4: Run test + lint — Expected: PASS.** `npx vitest run src/components/DashboardView.test.tsx && npm run lint`

- [ ] **Step 5: Commit.** `git add src/components/DashboardView.tsx src/components/DashboardView.test.tsx && git commit -m "feat(dashboard): risk + desempeño dashboard wired to /api/dashboard"`

---

### Task B2: Realizar Registro — 3-step flow

**Files:**
- Modify: `src/components/RegistroView.tsx` (rewrite), `src/components/RiskResultTable.tsx` (use `StatusPill` + tokens)
- Test: `src/components/RegistroView.test.tsx` (update)

**Interfaces:**
- Consumes: `Stepper`, `Button`, `Field`, `Input`, `Card`, `StatusPill` from `ui`; `apiPost` from `../api`; `RiskRow`/`RiskSummaryData` from `./RiskResultTable`.
- Preserves existing API calls: `POST /api/manifests` → `{ manifestId, shipmentCount, unmappedHeaders }`; `POST /api/manifests/:id/risk` → `{ rows, summary }`.

- [ ] **Step 1: Update the existing test** to assert the stepper + step-1 controls render.

```tsx
// src/components/RegistroView.test.tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import RegistroView from './RegistroView';

describe('RegistroView', () => {
  it('starts on Paso 1 with the manifest upload control', () => {
    render(<RegistroView />);
    expect(screen.getByText(/Paso 1|Cargar manifiesto/i)).toBeTruthy();
    expect(screen.getByText('MAWB')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run — Expected: FAIL or PASS depending on current copy.** `npx vitest run src/components/RegistroView.test.tsx` (proceed to rewrite regardless).

- [ ] **Step 3: Rewrite `RegistroView.tsx`** with a `current` step state (0=upload, 1=analizando, 2=resultado). Step 1: `Field`+`Input` for MAWB/Cliente + dropzone (reuse the existing dropzone markup, swap emerald→navy focus). On submit → set step 1, run the existing `apiPost` calls, render the 7-validation checklist (static labels: `['Validación ID','Validación Cantidad','Validación Monto','Validación Consignatarios','Validación Direcciones','Artículos Prohibidos','Validación Piratería','Importaciones por consignatario']`) animating to checked as the promise resolves, then step 2 shows `RiskSummary` + `RiskResultTable`. Top of view renders `<Stepper steps={['Cargar manifiesto','Análisis de riesgo','Resultado']} current={current} />`. Keep `XLSX.read` logic and error/`unmappedHeaders` banners. Use `Button` for submit.

- [ ] **Step 4: Refresh `RiskResultTable.tsx`** to import `StatusPill` and render `<StatusPill resultado={r.resultado} />` in the Resultado cell (remove the local `RESULTADO_STYLES`); keep `RiskSummary` but recolor the dot/accents to the same `emerald/amber/red` and add `tabular-nums` to the big numbers. Update `src/components/RiskResultTable.test.tsx` if it asserts removed markup.

- [ ] **Step 5: Run tests + lint — Expected: PASS.** `npx vitest run src/components/RegistroView.test.tsx src/components/RiskResultTable.test.tsx && npm run lint`

- [ ] **Step 6: Commit.** `git add src/components/RegistroView.tsx src/components/RiskResultTable.tsx src/components/*.test.tsx && git commit -m "feat(registro): 3-step manifest→análisis→resultado flow"`

---

### Task B3: Seguimiento view (new)

**Files:**
- Modify: `src/components/SeguimientoView.tsx` (replace stub)
- Test: `src/components/SeguimientoView.test.tsx`

**Interfaces:**
- Consumes: `Card`, `Field`, `Input`, `Button`, `PageHeader`(no), `EmptyState` from `ui`; `apiGet`/`apiPost` from `../api`.
- API: search via `GET /api/records?q=`; capture via `POST /api/manifests/:id/pedimento` (body = the captured fields); PDF upload via `POST /api/manifests/:id/pedimento-pdf`. Where a field/endpoint isn't backed yet, keep the control and add a visible `MOCK` note (see Step 3).

- [ ] **Step 1: Write the failing test.**

```tsx
// src/components/SeguimientoView.test.tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import SeguimientoView from './SeguimientoView';
describe('SeguimientoView', () => {
  it('renders the search field and pedimento capture labels', () => {
    render(<SeguimientoView />);
    expect(screen.getByPlaceholderText(/Buscar/i)).toBeTruthy();
    expect(screen.getByText('Pedimento')).toBeTruthy();
    expect(screen.getByText('Agente Aduanal')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run — Expected: FAIL** (stub returns null). `npx vitest run src/components/SeguimientoView.test.tsx`

- [ ] **Step 3: Implement** three blocks in one view: (1) search `Card` (input + `Button` → `apiGet('/api/records?q=')`, results list, select sets `selectedId`); (2) pedimento capture `Card` with `Field`+`Input` for the exact PDF fields: `Pedimento`, `Tasa de importación`, `Fecha de entrada` (type=date), `T1`, `Clave T1`, `Agente Aduanal`, `Patente`, `Clave de aduana de entrada`, `Clave de aduana de despacho`; a `Guardar datos` `Button` → `apiPost('/api/manifests/'+selectedId+'/pedimento', form)`; (3) PDF dropzone `Card` (reuse the dropzone markup, `accept=".pdf"`, helper text "Los pedimentos pesan entre 40 y 80 MB") → on file, `apiPost`/upload to `/api/manifests/:id/pedimento-pdf`. Disable blocks 2–3 until a record is selected. Add `<p className="text-[11px] font-medium text-amber-700">Vista previa — la persistencia se conectará al backend.</p>` under any block whose endpoint is not yet implemented (verify against `server/src/routes/pedimento.ts` / `pedimentoUpload.ts`).

- [ ] **Step 4: Run test + lint — Expected: PASS.** `npx vitest run src/components/SeguimientoView.test.tsx && npm run lint`

- [ ] **Step 5: Commit.** `git add src/components/SeguimientoView.tsx src/components/SeguimientoView.test.tsx && git commit -m "feat(seguimiento): record search + pedimento capture + PDF import"`

---

### Task B4: Reporte General view (new)

**Files:**
- Modify: `src/components/ReporteGeneralView.tsx` (replace stub)
- Test: `src/components/ReporteGeneralView.test.tsx`

**Interfaces:**
- Consumes: `Card`, `Field`, `Input`, `Button` from `ui`; `apiGet`/`apiDownload` from `../api`.
- API: record search via `GET /api/records?q=`; report download via `apiDownload('/api/records/:id/report.xlsx', 'Reporte_General.xlsx')`.

- [ ] **Step 1: Write the failing test.**

```tsx
// src/components/ReporteGeneralView.test.tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import ReporteGeneralView from './ReporteGeneralView';
describe('ReporteGeneralView', () => {
  it('renders remitente and plataforma field groups', () => {
    render(<ReporteGeneralView />);
    expect(screen.getByText('Datos del Remitente')).toBeTruthy();
    expect(screen.getByText('Datos de la Plataforma')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run — Expected: FAIL** (stub). `npx vitest run src/components/ReporteGeneralView.test.tsx`

- [ ] **Step 3: Implement** two grouped `Card`s: **Datos del Remitente** (`Field`s: Nombre completo / denominación o razón social, Id fiscal, Domicilio, Teléfono, Correo electrónico) and **Datos de la Plataforma** (Nombre comercial, País de origen, Denominación o razón social, Correo electrónico), then a `Generar Reporte` `Button` → `apiDownload('/api/records/'+selectedId+'/report.xlsx', 'Reporte_General.xlsx')`. Include the record search input at top to pick `selectedId` (reuse the Consulta search pattern). Add the same amber "Vista previa" note under the capture form (catalog persistence not yet wired).

- [ ] **Step 4: Run test + lint — Expected: PASS.** `npx vitest run src/components/ReporteGeneralView.test.tsx && npm run lint`

- [ ] **Step 5: Commit.** `git add src/components/ReporteGeneralView.tsx src/components/ReporteGeneralView.test.tsx && git commit -m "feat(reporte): remitente/plataforma capture + generación de reporte"`

---

### Task B5: Consulta redesign

**Files:**
- Modify: `src/components/ConsultaView.tsx`
- Test: `src/components/ConsultaView.test.tsx` (update if present)

**Interfaces:**
- Consumes: `Card`, `Input`, `Button`, `FileCard` from `ui`; existing `apiGet`/`apiDownload`. Same `RecordSummary`/`RecordDetail` types already in the file.

- [ ] **Step 1: Update/confirm the test** asserts results + artifact cards.

```tsx
// in src/components/ConsultaView.test.tsx — keep existing search assertions; add:
// after selecting a record, expect FileCard names 'Análisis de Riesgo', 'Reporte General' to render.
```

- [ ] **Step 2: Rewrite the render** to: search `Card` (Input + Button), results list (unchanged logic), and on `detail` a side `Card` with `FileCard`s — `Análisis de Riesgo` (xls → `/api/records/:id/risk.xlsx`), `Reporte General` (xls → `/api/records/:id/report.xlsx`), `LayOut` (xls → `/api/records/:id/layout.xlsx`), and `Pedimento` (pdf, only when `hasPedimento`, → `detail.artifacts.pedimentoPdf`). Replace the inline `<button>` download chips with `<FileCard kind=… name=… onDownload={() => handleDownload(...)} />`. Keep all existing handlers.

- [ ] **Step 3: Run test + lint — Expected: PASS.** `npx vitest run src/components/ConsultaView.test.tsx && npm run lint`

- [ ] **Step 4: Commit.** `git add src/components/ConsultaView.tsx src/components/ConsultaView.test.tsx && git commit -m "feat(consulta): artifact file cards + detail panel"`

---

### Task B6: Acerca de + Login re-skin

**Files:**
- Modify: `src/components/AcercaDeView.tsx`, `src/components/LoginView.tsx`

**Interfaces:**
- Consumes: `Card` from `ui` (Acerca). Login keeps `useAuth().login` logic unchanged.

- [ ] **Step 1: Rewrite `AcercaDeView.tsx`** as content `Card`s: intro paragraph (PDF copy), then Misión / Visión / Valores blocks with navy subheads. Use the exact PDF text. (No test — presentational.)

- [ ] **Step 2: Re-skin `LoginView.tsx`** — swap the green gradient (`from-[#0c2e17]…`) for a navy gradient (`from-navy-900 via-navy-800 to-navy-950`), the brand mark tile to `bg-gold-500/15 border-gold-400/30` with a gold `ShieldCheck`, the accent label to `text-gold-400`, and all `emerald-*` focus/button classes to `navy-*`. Keep title "Capital Centennials" and subtitle "Análisis de Riesgo · T1". Keep auth logic.

- [ ] **Step 3: Lint + manual check — Expected: PASS.** `npm run lint`

- [ ] **Step 4: Commit.** `git add src/components/AcercaDeView.tsx src/components/LoginView.tsx && git commit -m "feat(ui): navy/gold re-skin for Acerca de and Login"`

---

# PHASE C — Verify

### Task C1: Full sweep + consistency

**Files:** none (verification + small fixes only)

- [ ] **Step 1: Run the full client + server suites.** `npm test && npm --prefix server test` — Expected: all green.
- [ ] **Step 2: Lint.** `npm run lint` — Expected: clean.
- [ ] **Step 3: Build.** `npm run build` — Expected: succeeds.
- [ ] **Step 4: Manual matrix** (run `npm run dev` + server): for each role (capturista/admin/autoridad) confirm — sidebar shows the correct sections, Dashboard is the landing view and shows real data (admin sees `Desempeño por usuario` with all users; capturista sees own), Registro stepper advances, Consulta shows artifact cards, Seguimiento/Reporte render their forms with the "Vista previa" note, Login shows navy/gold. Confirm sidebar collapse persists across reload.
- [ ] **Step 5: Grep for drift** — `grep -rn "emerald-600\|bg-\[#0c2e17\]\|border-l-4 border-l-" src/components` should return only intentional `semáforo`-verde uses (the green accent on approved/verde states). Fix stray emerald-as-brand or old template borders.
- [ ] **Step 6: Commit any fixes.** `git add -A && git commit -m "chore: redesign consistency sweep + verification"`

---

## Self-Review

**Spec coverage:** Shell/sidebar → A3. Tokens → A1. Primitives → A2. Dashboard (role-aware, desempeño, recientes, empty) → A4 + B1. Registro 3-step → B2. Seguimiento → B3. Reporte General → B4. Consulta → B5. Acerca + Login → B6. Backend extension → A4. Verification (§10) → C1. All spec sections mapped.

**Placeholder scan:** View tasks (B2/B3/B5/B6 step "Rewrite/Implement") describe composition rather than pasting full JSX for every line — this is deliberate for large presentational components, but each names the exact primitives, props, fields, endpoints, and copy needed, and the foundational/logic code (tokens, primitives, sidebar, dashboard data, dashboard view) is given in full. No "TBD"/"add error handling"/"similar to Task N" left.

**Type consistency:** `Section` union defined in `src/nav.ts` and consumed by `App.tsx`/`DashboardView`; `Distribution`/`buildDashboardResponse` shapes match between A4 and B1's `DashboardData`; `Resultado` from `StatusPill` matches `RiskResultado` usage in `RiskResultTable` (Task B2 maps `r.resultado` directly — both use `'verde'|'amarillo'|'rojo'`). Consistent.
