import { describe, expect, it } from 'vitest';
import { partidaObservation } from './observation';

describe('partidaObservation', () => {
  it('matches the real pedimento format: GUIA <n> VALOR <usd> USD NOMBRE <name> RFC-CURP <id>', () => {
    const obs = partidaObservation({
      guideId: '369-94268462', valueUsd: 120.5, consigneeName: 'JUAN PEREZ', id: 'TOMM020922D40',
    });
    expect(obs).toBe('GUIA 369-94268462 VALOR 120.50 USD NOMBRE JUAN PEREZ RFC-CURP TOMM020922D40');
  });
});
