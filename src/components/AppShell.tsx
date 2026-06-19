import {
  ShieldCheck,
  FilePlus2,
  Activity,
  FileBarChart2,
  Search,
  LayoutDashboard,
  Info,
  LogOut,
  type LucideIcon,
} from 'lucide-react';

export type Section = 'registro' | 'seguimiento' | 'reporte' | 'consulta' | 'dashboard' | 'acerca';

const SECTIONS: { id: Section; label: string; icon: LucideIcon }[] = [
  { id: 'registro', label: 'Realizar Registro', icon: FilePlus2 },
  { id: 'seguimiento', label: 'Seguimiento', icon: Activity },
  { id: 'reporte', label: 'Reporte General', icon: FileBarChart2 },
  { id: 'consulta', label: 'Consulta', icon: Search },
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'acerca', label: 'Acerca de', icon: Info },
];

const ROLE_LABELS: Record<string, string> = {
  capturista: 'Capturista',
  admin: 'Administrador',
  autoridad: 'Autoridad',
};

export function AppShell({
  role,
  active,
  onSelect,
  username,
  onLogout,
}: {
  role: string;
  active: Section;
  onSelect: (s: Section) => void;
  username?: string;
  onLogout?: () => void;
}) {
  return (
    <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/90 backdrop-blur">
      <div className="mx-auto max-w-7xl px-6">
        {/* Top row: brand + identity */}
        <div className="flex h-16 items-center justify-between gap-4">
          <div className="flex shrink-0 items-center gap-2.5 select-none">
            <div className="grid h-9 w-9 place-items-center rounded-xl bg-emerald-600 text-white shadow-sm shadow-emerald-600/20">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <div className="leading-tight">
              <div className="text-sm font-bold tracking-tight text-slate-900">Capital Centennials</div>
              <div className="font-mono text-[10px] font-bold uppercase tracking-[0.22em] text-emerald-600">
                Riesgo · T1
              </div>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-3">
            <div className="hidden text-right sm:block">
              {username && <div className="text-sm font-semibold leading-tight text-slate-800">{username}</div>}
              <div className="text-xs leading-tight text-slate-500">{ROLE_LABELS[role] ?? role}</div>
            </div>
            <span className="grid h-9 w-9 place-items-center rounded-full bg-slate-100 text-sm font-bold uppercase text-slate-500">
              {(username ?? role).charAt(0)}
            </span>
            {onLogout && (
              <button
                type="button"
                onClick={onLogout}
                title="Cerrar sesión"
                aria-label="Cerrar sesión"
                className="grid h-9 w-9 place-items-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
              >
                <LogOut className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        {/* Bottom row: section tabs */}
        <nav aria-label="Secciones" className="-mb-px flex gap-1 overflow-x-auto">
          {SECTIONS.map((s) => {
            const Icon = s.icon;
            const isActive = active === s.id;
            return (
              <button
                key={s.id}
                aria-current={isActive}
                onClick={() => onSelect(s.id)}
                className={[
                  'inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-3 text-sm font-medium transition-colors',
                  isActive
                    ? 'border-emerald-600 text-emerald-700'
                    : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800',
                ].join(' ')}
              >
                <Icon className="h-4 w-4" />
                {s.label}
              </button>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
