export type SubStatus = 'pendiente' | 'capturado' | 'prevalidado' | 'cargado' | 'rechazado';
export const SUB_STATUSES: SubStatus[] = ['pendiente', 'capturado', 'prevalidado', 'cargado', 'rechazado'];

export type SubStatusEvent = 'capture' | 'prevalidate_pass' | 'prevalidate_block' | 'finalize' | 'reopen';

export interface TransitionResult { ok: boolean; next: SubStatus | null; reason: string | null }

// from-state sets per event. `cargado` appears in no `from` set → terminal.
const TABLE: Record<SubStatusEvent, { from: SubStatus[]; to: SubStatus }> = {
  capture:           { from: ['pendiente', 'capturado', 'prevalidado', 'rechazado'], to: 'capturado' },
  prevalidate_pass:  { from: ['capturado', 'prevalidado'], to: 'prevalidado' },
  prevalidate_block: { from: ['capturado', 'prevalidado'], to: 'rechazado' },
  finalize:          { from: ['prevalidado'], to: 'cargado' },
  reopen:            { from: ['rechazado'], to: 'capturado' },
};

export function nextSubStatus(current: SubStatus, event: SubStatusEvent): TransitionResult {
  const rule = TABLE[event];
  if (rule.from.includes(current)) return { ok: true, next: rule.to, reason: null };
  const why = current === 'cargado'
    ? 'El pedimento ya fue finalizado (cargado); no admite más cambios.'
    : `Transición no permitida: ${event} desde ${current}.`;
  return { ok: false, next: null, reason: why };
}
