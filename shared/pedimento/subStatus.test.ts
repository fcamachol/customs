import { describe, it, expect } from 'vitest';
import { nextSubStatus, SUB_STATUSES } from './subStatus';

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
