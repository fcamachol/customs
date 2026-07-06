import type { SubStatus, ScanVerdict } from './steps';
import type { ManifestCoverageStatus } from '../../../shared/pedimento/coverage';

// Small rounded status chip used across the Seguimiento queue and the per-pedimento cards.
export function Pill({ label, cls }: { label: string; cls: string }) {
  return <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${cls}`}>{label}</span>;
}

// Coverage chip styling for the Seguimiento work-queue rows + the capture-workspace header.
export const COVERAGE_META: Record<ManifestCoverageStatus, { label: string; cls: string }> = {
  sin_pedimento: { label: 'Sin pedimento', cls: 'bg-slate-100 text-slate-600 ring-slate-500/20' },
  parcial:       { label: 'Parcial',       cls: 'bg-amber-50 text-amber-700 ring-amber-600/20' },
  completo:      { label: 'Completo',      cls: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20' },
};

export function CoverageBadge({ status, uploadedCount, expectedCount }: { status: ManifestCoverageStatus; uploadedCount: number; expectedCount: number | null }) {
  const meta = COVERAGE_META[status];
  const count = expectedCount ? `${uploadedCount}/${expectedCount}` : `${uploadedCount}`;
  return (
    <span className="inline-flex items-center gap-1.5">
      <Pill label={meta.label} cls={meta.cls} />
      {uploadedCount > 0 && <span className="text-xs font-medium text-slate-400">{count} pedimento(s)</span>}
    </span>
  );
}

// Per-subdivisión lifecycle chip + the entry-button label, keyed by subStatus.
export const SUB_STATUS_BADGE: Record<SubStatus, { label: string; cls: string; action: string }> = {
  pendiente:   { label: 'Pendiente',   cls: 'bg-slate-100 text-slate-600 ring-slate-500/20',     action: 'Capturar' },
  capturado:   { label: 'Capturado',   cls: 'bg-navy-50 text-navy-700 ring-navy-600/20',         action: 'Capturar' },
  prevalidado: { label: 'Prevalidado', cls: 'bg-amber-50 text-amber-700 ring-amber-600/20',      action: 'Continuar' },
  cargado:     { label: 'Cargado',     cls: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20', action: 'Ver' },
  rechazado:   { label: 'Rechazado',   cls: 'bg-red-50 text-red-700 ring-red-600/20',            action: 'Revisar' },
};

// RF-08/RF-10 — pedimento scan verdict badge shown on each subdivisión row/card.
export const SCAN_BADGE: Record<ScanVerdict, { label: string; cls: string }> = {
  clean:       { label: 'Limpio',    cls: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20' },
  suspicious:  { label: 'Revisar',   cls: 'bg-amber-50 text-amber-700 ring-amber-600/20' },
  unscannable: { label: 'Revisar',   cls: 'bg-amber-50 text-amber-700 ring-amber-600/20' },
  blocked:     { label: 'Bloqueado', cls: 'bg-red-50 text-red-700 ring-red-600/20' },
};
