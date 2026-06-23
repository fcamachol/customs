import { useState, useEffect } from 'react';
import { ShieldCheck, LogOut, ChevronDown, type LucideIcon } from 'lucide-react';
import { NAV_GROUPS, visibleSectionsFor, isParent, type Section, type NavChild, type NavItem } from '../nav';
import { apiGet } from '../api';

const ROLE_LABELS: Record<string, string> = { capturista: 'Capturista', admin: 'Administrador', autoridad: 'Autoridad', super_admin: 'Super Admin' };

interface BrandingConfig { logoUrl?: string; rfc?: string; companyName?: string; }

export function Sidebar({ role, active, onSelect, username, onLogout }: {
  role: string; active: Section; onSelect: (s: Section) => void; username?: string; onLogout?: () => void;
}) {
  const [collapsed, setCollapsed] = useState<boolean>(() => typeof localStorage !== 'undefined' && localStorage.getItem('sidebar:collapsed') === '1');
  const [branding, setBranding] = useState<BrandingConfig>({});
  const [openParents, setOpenParents] = useState<Set<string>>(new Set());
  const visible = new Set(visibleSectionsFor(role));
  const toggle = () => { const v = !collapsed; setCollapsed(v); localStorage.setItem('sidebar:collapsed', v ? '1' : '0'); };
  const expand = () => { setCollapsed(false); localStorage.setItem('sidebar:collapsed', '0'); };

  useEffect(() => {
    apiGet<{ key: string; value: BrandingConfig | null }>('/api/catalogs/config/branding')
      .then((res) => { if (res.value) setBranding(res.value); })
      .catch(() => {});
  }, []);

  const companyName = branding.companyName || 'Capital Centennials';
  const rfc = branding.rfc;

  // A plain destination link (used for leaves and for a parent with a single visible child).
  function renderLeaf(id: Section, label: string, icon: LucideIcon) {
    const isActive = active === id;
    const Icon = icon;
    return (
      <button
        key={id}
        onClick={() => onSelect(id)}
        aria-current={isActive ? 'page' : undefined}
        title={label}
        className={`relative flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition ${
          isActive ? 'bg-navy-50 text-navy-800' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-800'}`}
      >
        {isActive && <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-gold-500" />}
        <Icon className="h-4 w-4 shrink-0" />
        {!collapsed && label}
      </button>
    );
  }

  function renderChild(c: NavChild) {
    const isActive = active === c.id;
    return (
      <button
        key={c.id}
        onClick={() => onSelect(c.id)}
        aria-current={isActive ? 'page' : undefined}
        className={`relative flex w-full items-center justify-between gap-2 rounded-lg py-1.5 pl-9 pr-2.5 text-sm transition ${
          isActive ? 'bg-navy-50 font-semibold text-navy-800' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-800'}`}
      >
        {isActive && <span className="absolute left-3 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-gold-500" />}
        <span className="truncate">{c.label}</span>
        {c.badge && (
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-slate-500">{c.badge}</span>
        )}
      </button>
    );
  }

  function renderParent(it: Extract<NavItem, { parentId: string }>) {
    const childActive = it.children.some((c) => c.id === active);
    const expanded = childActive || openParents.has(it.parentId);
    const Icon = it.icon;
    return (
      <div key={it.parentId}>
        <button
          type="button"
          title={it.label}
          aria-expanded={expanded}
          onClick={() => {
            if (collapsed) { expand(); setOpenParents((p) => new Set(p).add(it.parentId)); onSelect(it.children[0].id); return; }
            setOpenParents((p) => { const n = new Set(p); if (n.has(it.parentId)) n.delete(it.parentId); else n.add(it.parentId); return n; });
          }}
          className={`relative flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition ${
            childActive ? 'text-navy-800' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-800'}`}
        >
          <Icon className="h-4 w-4 shrink-0" />
          {!collapsed && <span className="flex-1 text-left">{it.label}</span>}
          {!collapsed && <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform ${expanded ? '' : '-rotate-90'}`} />}
        </button>
        {!collapsed && expanded && (
          <div className="mt-0.5 space-y-0.5">
            {it.children.map((c) => renderChild(c))}
          </div>
        )}
      </div>
    );
  }

  return (
    <aside className={`${collapsed ? 'w-16' : 'w-60'} sticky top-0 flex h-screen shrink-0 flex-col border-r border-slate-200 bg-white transition-[width]`}>
      <div className="flex h-16 items-center gap-2.5 px-4 select-none">
        {branding.logoUrl ? (
          <img src={branding.logoUrl} alt={companyName} className="h-9 w-9 shrink-0 rounded-xl object-contain" />
        ) : (
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-navy-800 text-white shadow-sm">
            <ShieldCheck className="h-5 w-5" />
          </div>
        )}
        {!collapsed && (
          <div className="leading-tight min-w-0">
            <div className="text-sm font-bold tracking-tight text-slate-900 truncate">{companyName}</div>
            {rfc ? (
              <div className="font-mono text-[10px] text-slate-400 truncate">{rfc}</div>
            ) : (
              <div className="font-mono text-[10px] font-bold uppercase tracking-[0.22em] text-gold-600">Riesgo · T1</div>
            )}
          </div>
        )}
      </div>

      <nav className="flex-1 overflow-y-auto px-2 py-2">
        {NAV_GROUPS.map((group) => {
          // Filter each entry: leaves by visibility; parents keep only visible children.
          const entries: NavItem[] = [];
          for (const it of group.items) {
            if (!isParent(it)) { if (visible.has(it.id)) entries.push(it); continue; }
            const children = it.children.filter((c) => visible.has(c.id));
            if (children.length) entries.push({ ...it, children });
          }
          if (!entries.length) return null;

          return (
            <div key={group.label} className="mb-3" role="group" aria-label={group.label}>
              {!collapsed && (
                <div className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-400">{group.label}</div>
              )}
              {entries.map((it) => {
                if (!isParent(it)) return renderLeaf(it.id, it.label, it.icon);
                // A parent with one visible child collapses to a plain link ("leave just the parent").
                if (it.children.length === 1) return renderLeaf(it.children[0].id, it.children[0].label, it.icon);
                return renderParent(it);
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
