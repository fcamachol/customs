import { describe, expect, it } from 'vitest';
import { partidaObservation, parseObservation, scanObservations } from './observation';

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
  // A different agente aduanal prints the same grammar with punctuation/accent variation. Tolerate
  // it (better data than none), but only punctuation/accents — never a semantic wording change.
  it('tolerates colons after the labels (GUIA:/VALOR:/NOMBRE:/RFC-CURP:)', () => {
    const r = parseObservation('GUIA: JMX101245831553 VALOR: 60.110 USD NOMBRE: MAURICIO TORRES MONTEJO RFC-CURP: TOMM020922D40');
    expect(r).toEqual({ guideId: 'JMX101245831553', valueUsd: 60.11, consigneeName: 'MAURICIO TORRES MONTEJO', id: 'TOMM020922D40' });
  });
  it('tolerates the RFC/CURP and RFC CURP separator variants', () => {
    expect(parseObservation('GUIA JMX1 VALOR 5.00 USD NOMBRE ANA LOPEZ RFC/CURP PERJ800101AA8')?.id).toBe('PERJ800101AA8');
    expect(parseObservation('GUIA JMX1 VALOR 5.00 USD NOMBRE ANA LOPEZ RFC CURP PERJ800101AA8')?.id).toBe('PERJ800101AA8');
  });
  it('tolerates the accented GUÍA label', () => {
    const r = parseObservation('GUÍA JMX2 VALOR 5.00 USD NOMBRE ANA LOPEZ RFC-CURP PERJ800101AA8');
    expect(r?.guideId).toBe('JMX2');
  });
  it('still rejects a semantic wording change (DESTINATARIO instead of NOMBRE)', () => {
    // Only punctuation/accent variation is tolerated — a different label means we cannot trust the
    // field mapping, so return null rather than mis-assign.
    expect(parseObservation('GUIA JMX3 VALOR 5.00 USD DESTINATARIO ANA LOPEZ RFC-CURP PERJ800101AA8')).toBeNull();
  });
});

describe('scanObservations', () => {
  it('scans variants (colon, RFC/CURP separator, accent) from whitespace-collapsed text', () => {
    const text = 'OBSERVACIONES A NIVEL PARTIDA\nGUÍA: JMX9 VALOR: 12.00 USD NOMBRE: ANA LOPEZ\nRFC/CURP JIMA800101AA8';
    const out = scanObservations(text);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ guideId: 'JMX9', valueUsd: 12, consigneeName: 'ANA LOPEZ', id: 'JIMA800101AA8' });
  });
});
