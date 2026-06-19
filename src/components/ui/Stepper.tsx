export function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="flex items-center gap-2">
      {steps.map((label, i) => {
        const state = i < current ? 'done' : i === current ? 'active' : 'todo';
        const dot = state === 'done' ? 'bg-navy-800 text-white' : state === 'active' ? 'bg-navy-800 text-white ring-4 ring-navy-800/15' : 'bg-slate-200 text-slate-500';
        const text = state === 'todo' ? 'text-slate-400' : 'text-slate-800';
        return (
          <li key={label} className="flex items-center gap-2">
            <span className={`grid h-7 w-7 place-items-center rounded-full text-xs font-bold ${dot}`}>{i + 1}</span>
            <span className={`text-sm font-medium ${text}`}>{label}</span>
            {i < steps.length - 1 && <span className="mx-1 h-px w-8 bg-slate-200" />}
          </li>
        );
      })}
    </ol>
  );
}
