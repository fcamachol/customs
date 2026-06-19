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
