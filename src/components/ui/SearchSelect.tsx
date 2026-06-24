import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Check, ChevronDown, Search, X } from 'lucide-react';

export interface SearchSelectOption {
  value: string;
  label: string;
}

/**
 * Compact searchable single-select (typeahead "drop search"). Type to filter the
 * option list, click to select, ✕ to clear. Stores the selected option's `value`.
 * Styled to match Input/SELECT_CLS (slate borders, navy focus ring).
 */
export function SearchSelect({
  value,
  onChange,
  options,
  placeholder = 'Seleccionar…',
  disabled = false,
  className = '',
  id,
}: {
  value: string;
  onChange: (value: string) => void;
  options: SearchSelectOption[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  id?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const selected = options.find((o) => o.value === value) ?? null;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, query]);

  // Close on click-outside.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery('');
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  // Keep the highlighted row in range as the filtered set changes.
  useEffect(() => { setActive(0); }, [query, open]);

  function commit(v: string) {
    onChange(v);
    setOpen(false);
    setQuery('');
  }

  function onKeyDown(e: ReactKeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) { setOpen(true); return; }
      setActive((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      if (open && filtered[active]) { e.preventDefault(); commit(filtered[active].value); }
    } else if (e.key === 'Escape') {
      setOpen(false);
      setQuery('');
    }
  }

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <div
        className={`flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm transition focus-within:border-navy-500 focus-within:ring-2 focus-within:ring-navy-500/25 ${
          disabled ? 'cursor-not-allowed opacity-60' : ''
        }`}
      >
        <Search className="h-4 w-4 shrink-0 text-slate-400" />
        <input
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          autoComplete="off"
          disabled={disabled}
          id={id}
          value={open ? query : selected?.label ?? ''}
          placeholder={selected ? selected.label : placeholder}
          onChange={(e) => { setQuery(e.target.value); if (!open) setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          className="min-w-0 flex-1 bg-transparent text-slate-900 outline-none placeholder:text-slate-400"
        />
        {selected && !disabled ? (
          <button
            type="button"
            aria-label="Limpiar"
            onClick={() => { commit(''); }}
            className="shrink-0 rounded p-0.5 text-slate-400 transition hover:text-slate-600"
          >
            <X className="h-4 w-4" />
          </button>
        ) : (
          <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />
        )}
      </div>

      {open && !disabled && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-slate-200 bg-white py-1 shadow-lg"
        >
          {filtered.length === 0 ? (
            <li className="px-3 py-2 text-sm text-slate-400">Sin coincidencias</li>
          ) : (
            filtered.map((o, i) => (
              <li key={o.value} role="option" aria-selected={o.value === value}>
                <button
                  type="button"
                  onMouseEnter={() => setActive(i)}
                  onClick={() => commit(o.value)}
                  className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm transition-colors ${
                    i === active ? 'bg-navy-50 text-navy-700' : 'text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  <span className="truncate">{o.label}</span>
                  {o.value === value && <Check className="h-4 w-4 shrink-0 text-navy-600" />}
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
