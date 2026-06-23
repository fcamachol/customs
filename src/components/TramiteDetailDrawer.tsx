import { useEffect } from 'react';
import { X } from 'lucide-react';

// Groups a flat header→value trámite row (34/36 columns) into the report's logical blocks.
const GROUPS: { title: string; match: (key: string) => boolean }[] = [
  { title: 'Riesgo', match: (k) => k === 'Resultado' || k === 'Motivo' },
  { title: 'Consignatario', match: (k) => k.startsWith('Consignatario ') },
  { title: 'Remitente', match: (k) => k.startsWith('Remitente ') },
  { title: 'Plataforma', match: (k) => k.startsWith('Plataforma ') },
  { title: 'Mercancía', match: () => true }, // catch-all (must be last)
];

function groupRow(row: Record<string, string>): { title: string; entries: [string, string][] }[] {
  const out = GROUPS.map((g) => ({ title: g.title, entries: [] as [string, string][] }));
  for (const [key, value] of Object.entries(row)) {
    const idx = GROUPS.findIndex((g) => g.match(key));
    out[idx].entries.push([key, value]);
  }
  return out.filter((g) => g.entries.length > 0);
}

export function TramiteDetailDrawer({
  row,
  title,
  onClose,
}: {
  row: Record<string, string>;
  title: string;
  onClose: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const groups = groupRow(row);

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* scrim */}
      <button type="button" aria-label="Cerrar" onClick={onClose} className="absolute inset-0 bg-slate-900/30" />
      {/* panel */}
      <aside
        role="dialog"
        aria-label="Detalle del trámite"
        className="relative flex h-full w-full max-w-md flex-col overflow-hidden bg-white shadow-xl"
      >
        <header className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <h3 className="text-sm font-bold text-slate-800">{title}</h3>
          <button type="button" onClick={onClose} className="rounded-md p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600">
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {groups.map((g) => (
            <section key={g.title} className="mb-5">
              <h4 className="mb-2 text-[11px] font-bold uppercase tracking-wide text-navy-700">{g.title}</h4>
              <dl className="divide-y divide-slate-100 rounded-lg border border-slate-200">
                {g.entries.map(([k, v]) => (
                  <div key={k} className="grid grid-cols-2 gap-2 px-3 py-2">
                    <dt className="text-xs text-slate-500">{k}</dt>
                    <dd className="break-words text-right text-xs font-medium text-slate-800">{v || '—'}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </aside>
    </div>
  );
}
