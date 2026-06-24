import { describe, expect, it } from 'vitest';
import { partidaObservation, parseObservation } from './observation';

describe('partidaObservation', () => {
  it('matches the real pedimento format: GUIA <n> VALOR <usd> USD NOMBRE <name> RFC-CURP <id>', () => {
    const obs = partidaObservation({
      guideId: '369-94268462', valueUsd: 120.5, consigneeName: 'JUAN PEREZ', id: 'TOMM020922D40',
    });
    expect(obs).toBe('GUIA 369-94268462 VALOR 120.50 USD NOMBRE JUAN PEREZ RFC-CURP TOMM020922D40');
  });
});

describe('parseObservation', () => {
  it('round-trips with partidaObservation', () => {
    const s = partidaObservation({ guideId: 'JMX600026618783', valueUsd: 3.86, consigneeName: 'Aarón Arce', id: 'AERA790828HBSRBR04' });
    expect(parseObservation(s)).toEqual({ guideId: 'JMX600026618783', valueUsd: 3.86, consigneeName: 'AARÓN ARCE', id: 'AERA790828HBSRBR04' });
  });
  it('parses a real PDF observation with 3-decimal value and multi-word name', () => {
    const r = parseObservation('GUIA JMX101245831553 VALOR 60.110 USD NOMBRE MAURICIO TORRES MONTEJO RFC-CURP TOMM020922D40');
    expect(r).toEqual({ guideId: 'JMX101245831553', valueUsd: 60.11, consigneeName: 'MAURICIO TORRES MONTEJO', id: 'TOMM020922D40' });
  });
  it('returns null for non-grammar text', () => {
    expect(parseObservation('OBSERVACIONES A NIVEL PARTIDA')).toBeNull();
  });
});
