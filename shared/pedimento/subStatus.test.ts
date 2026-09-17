import { describe, it, expect } from 'vitest';
import { nextSubStatus, SUB_STATUSES, type SubStatusEvent } from './subStatus';

describe('nextSubStatus', () => {
  it('capture: pendiente/capturado/prevalidado/rechazado -> capturado', () => {
    for (const s of ['pendiente', 'capturado', 'prevalidado', 'rechazado'] as const) {
      expect(nextSubStatus(s, 'capture')).toEqual({ ok: true, next: 'capturado', reason: null });
    }
  });
  it('capture is rejected once cargado (terminal)', () => {
    const r = nextSubStatus('cargado', 'capture');
    expect(r.ok).toBe(false); expect(r.next).toBeNull(); expect(r.reason).toMatch(/cargado|finaliz/i);
  });
  it('prevalidate_pass: capturado/prevalidado -> prevalidado', () => {
    expect(nextSubStatus('capturado', 'prevalidate_pass').next).toBe('prevalidado');
    expect(nextSubStatus('prevalidado', 'prevalidate_pass').next).toBe('prevalidado');
  });
  it('prevalidate_pass rejected from pendiente (must capture first)', () => {
    expect(nextSubStatus('pendiente', 'prevalidate_pass').ok).toBe(false);
  });
  it('prevalidate_block: capturado/prevalidado -> rechazado', () => {
    expect(nextSubStatus('capturado', 'prevalidate_block').next).toBe('rechazado');
    expect(nextSubStatus('prevalidado', 'prevalidate_block').next).toBe('rechazado');
  });
  it('finalize: only prevalidado -> cargado', () => {
    expect(nextSubStatus('prevalidado', 'finalize').next).toBe('cargado');
    expect(nextSubStatus('capturado', 'finalize').ok).toBe(false);
  });
  it('reopen: only rechazado -> capturado', () => {
    expect(nextSubStatus('rechazado', 'reopen').next).toBe('capturado');
    expect(nextSubStatus('cargado', 'reopen').ok).toBe(false);
  });
  it('exposes all five statuses', () => {
    expect(SUB_STATUSES).toEqual(['pendiente', 'capturado', 'prevalidado', 'cargado', 'rechazado']);
  });
});

describe('los mensajes se leen sin conocer la máquina de estados', () => {
  // El operador está capturando pedimentos, no depurando el sistema. Un mensaje que dice
  // "prevalidate_block desde rechazado" nombra un evento interno y no le dice qué hacer.
  it('nunca filtra el nombre interno del evento ni del estado crudo', () => {
    const eventos: SubStatusEvent[] = ['capture', 'prevalidate_pass', 'prevalidate_block', 'finalize', 'reopen'];
    for (const current of SUB_STATUSES) {
      for (const event of eventos) {
        const r = nextSubStatus(current, event);
        if (r.ok) continue;
        expect(r.reason).toBeTruthy();
        expect(r.reason).not.toContain('prevalidate_');
        expect(r.reason).not.toContain('finalize');
        expect(r.reason).not.toContain('reopen');
        expect(r.reason).not.toContain('capture');
        expect(r.reason).not.toMatch(/Transición no permitida/);
      }
    }
  });

  it('dice cuál es el siguiente paso, no sólo que no se puede', () => {
    expect(nextSubStatus('capturado', 'finalize').reason).toMatch(/prevalidación/i);
    expect(nextSubStatus('rechazado', 'finalize').reason).toMatch(/corrige/i);
    expect(nextSubStatus('pendiente', 'prevalidate_pass').reason).toMatch(/captura/i);
    expect(nextSubStatus('capturado', 'reopen').reason).toMatch(/rechazado/i);
  });

  it('un pedimento finalizado explica que hay que reabrirlo', () => {
    expect(nextSubStatus('cargado', 'capture').reason).toMatch(/reabrirlo/i);
  });
});
