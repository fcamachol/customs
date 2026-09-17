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

/**
 * Estado del pedimento en palabras del operador.
 *
 * Los valores internos (`capturado`, `rechazado`…) son vocabulario de la máquina de estados; quien
 * lee el mensaje está capturando pedimentos, no depurando el sistema.
 */
const ESTADO_LEGIBLE: Record<SubStatus, string> = {
  pendiente: 'pendiente de captura',
  capturado: 'capturado',
  prevalidado: 'prevalidado',
  cargado: 'finalizado',
  rechazado: 'rechazado',
};

/**
 * Qué hacer cuando la transición no procede.
 *
 * Un mensaje que dice «prevalidate_block desde rechazado» nombra un evento interno y deja al
 * operador sin saber qué hacer. Estos textos dicen el estado en que está el pedimento y cuál es el
 * siguiente paso, que es lo único accionable desde la pantalla.
 */
function comoSeguir(current: SubStatus, event: SubStatusEvent): string {
  const estado = ESTADO_LEGIBLE[current];
  if (current === 'cargado') {
    return 'Este pedimento ya está finalizado y no admite más cambios. Para modificarlo hay que reabrirlo.';
  }
  switch (event) {
    case 'finalize':
      return current === 'rechazado'
        ? 'No se puede finalizar un pedimento rechazado. Corrige lo señalado arriba, vuelve a capturarlo y prevalídalo.'
        : `Para finalizar, el pedimento tiene que estar prevalidado. Hoy está ${estado}: ejecuta la prevalidación primero.`;
    case 'prevalidate_pass':
    case 'prevalidate_block':
      return current === 'rechazado'
        ? 'Este pedimento ya fue rechazado en una prevalidación anterior. Corrige lo señalado y vuelve a capturarlo para poder prevalidarlo de nuevo.'
        : `Para prevalidar, el pedimento tiene que estar capturado. Hoy está ${estado}: completa la captura primero.`;
    case 'reopen':
      return `Sólo se reabre un pedimento rechazado. Este está ${estado}.`;
    case 'capture':
      return `Este pedimento no admite captura mientras esté ${estado}.`;
  }
}

export function nextSubStatus(current: SubStatus, event: SubStatusEvent): TransitionResult {
  const rule = TABLE[event];
  if (rule.from.includes(current)) return { ok: true, next: rule.to, reason: null };
  return { ok: false, next: null, reason: comoSeguir(current, event) };
}
