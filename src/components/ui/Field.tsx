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
