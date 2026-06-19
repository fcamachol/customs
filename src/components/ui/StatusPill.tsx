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
