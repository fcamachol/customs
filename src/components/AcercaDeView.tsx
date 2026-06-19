import { ShieldCheck, Target, Compass } from 'lucide-react';

export function AcercaDeView() {
  return (
    <div className="space-y-6">
      <div className="flex items-start gap-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-emerald-600 text-white shadow-sm shadow-emerald-600/20">
          <ShieldCheck className="h-6 w-6" />
        </div>
        <div>
          <h2 className="text-lg font-bold tracking-tight text-slate-900">Capital Centennials</h2>
          <p className="mt-1 max-w-2xl text-sm text-slate-500">
            Plataforma de análisis de riesgo y cumplimiento aduanero T1 para importaciones de mensajería.
          </p>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="mb-3 flex items-center gap-2 text-emerald-700">
            <Target className="h-4 w-4" />
            <h3 className="text-sm font-bold uppercase tracking-wide">Misión</h3>
          </div>
          <p className="text-sm leading-relaxed text-slate-600">
            Garantizar importaciones de mensajería seguras y conformes.
          </p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="mb-3 flex items-center gap-2 text-emerald-700">
            <Compass className="h-4 w-4" />
            <h3 className="text-sm font-bold uppercase tracking-wide">Visión</h3>
          </div>
          <p className="text-sm leading-relaxed text-slate-600">
            Ser la plataforma de referencia en cumplimiento aduanero T1.
          </p>
        </div>
      </div>
    </div>
  );
}
