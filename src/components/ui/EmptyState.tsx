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
