import { describe, expect, it } from 'vitest';
import { ETAPAS, canAdvanceEtapa, type Etapa } from './estados';

describe('canAdvanceEtapa', () => {
  it('allows a step forward', () => {
    expect(canAdvanceEtapa('prealerta', 'en_vuelo')).toBe(true);
    expect(canAdvanceEtapa('arribado', 'disponible')).toBe(true);
  });

  it('allows skipping ahead — facts can arrive out of order', () => {
    // A late-captured modulación can land before anyone recorded the load finishing; refusing the
    // jump would strand the operación behind reality.
    expect(canAdvanceEtapa('disponible', 'modulado')).toBe(true);
  });

  it('never regresses', () => {
    expect(canAdvanceEtapa('en_vuelo', 'prealerta')).toBe(false);
    expect(canAdvanceEtapa('entregado', 'en_transito')).toBe(false);
  });

  it('treats a repeat of the same etapa as a no-op, not a transition', () => {
    // This is what keeps a redelivered webhook from appending a duplicate event.
    for (const e of ETAPAS) expect(canAdvanceEtapa(e, e)).toBe(false);
  });

  it('lets cancelada be reached from any live etapa', () => {
    const live = ETAPAS.filter((e) => e !== 'cerrada' && e !== 'cancelada');
    for (const e of live) expect(canAdvanceEtapa(e, 'cancelada')).toBe(true);
  });

  it('treats cerrada and cancelada as terminal', () => {
    for (const to of ETAPAS) {
      expect(canAdvanceEtapa('cerrada', to)).toBe(false);
      expect(canAdvanceEtapa('cancelada', to)).toBe(false);
    }
  });

  it('rejects an etapa outside the vocabulary instead of ordering it as -1', () => {
    expect(canAdvanceEtapa('prealerta', 'inventada' as Etapa)).toBe(false);
  });
});
