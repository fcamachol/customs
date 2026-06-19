import type { ReactNode } from 'react';

export function Card({ className = '', children, key }: { className?: string; children: ReactNode; key?: string }) {
  return <div key={key} className={`rounded-xl border border-slate-200 bg-white ${className}`}>{children}</div>;
}
