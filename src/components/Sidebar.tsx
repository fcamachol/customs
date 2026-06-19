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
            <div key={group.label} className="mb-3" role="group" aria-label={group.label}>
              {!collapsed && (
                <div
                  data-label={group.label}
                  className="nav-group-label px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-400"
                />
              )}
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
