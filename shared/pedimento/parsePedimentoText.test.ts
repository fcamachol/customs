import { describe, expect, it } from 'vitest';
import { parsePedimentoText } from './parsePedimentoText';

// Trimmed text captured from a real Anexo-22 pedimento (2 partidas).
const SAMPLE = `
DATOS DEL IMPORTADOR / EXPORTADOR
NUM. PEDIMENTO: CVE. PEDIMENTO:
25 85 1653 5001684
ADM130509UQ0
ADMERCE SA DE CV
T1
PARTIDAS
99010001	001 00 0 1 6 1.000 6 CHN CHN
TRAJE
OBSERVACIONES A NIVEL PARTIDA
GUIA JMX101245831553 VALOR 60.110 USD NOMBRE MAURICIO TORRES MONTEJO RFC-CURP TOMM020922D40
99010001	002 00 0 1 6 1.000 6 CHN CHN
COJIN
OBSERVACIONES A NIVEL PARTIDA
GUIA JMX101255006278 VALOR 12.000 USD NOMBRE ANA LOPEZ RUIZ RFC-CURP PERJ800101AA8
GLG1502247K9
`;

describe('parsePedimentoText', () => {
  it('extracts every partida observation as a line keyed by guía', () => {
    const out = parsePedimentoText(SAMPLE);
    expect(out.lines).toHaveLength(2);
    expect(out.lines[0]).toMatchObject({ guia: 'JMX101245831553', valueUsd: 60.11, consigneeName: 'MAURICIO TORRES MONTEJO', id: 'TOMM020922D40' });
    expect(out.lines[1].guia).toBe('JMX101255006278');
  });
  it('extracts header fields via anchored regexes', () => {
    const out = parsePedimentoText(SAMPLE);
    expect(out.header.numeroPedimento).toBe('258516535001684');
    expect(out.header.clave).toBe('T1');
    expect(out.header.importerRfc).toBe('ADM130509UQ0');
  });
  it('marks deterministic extraction with confidence > 0', () => {
    const out = parsePedimentoText(SAMPLE);
    expect(out.extractionMethod).toBe('deterministic');
    expect(out.usedPositional).toBe(false);
    expect(out.confidence).toBeGreaterThan(0);
  });
  it('exposes the extended header fields, defaulting to null when absent', () => {
    const out = parsePedimentoText(SAMPLE);
    expect(out.header).toMatchObject({
      patente: null,        // SAMPLE has a numero but Task 2 wires patente; here it is still null
      agencyRfc: null,
      entryDate: null,
      paymentDate: null,
    });
  });
});
