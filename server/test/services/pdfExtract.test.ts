import { describe, expect, it } from 'vitest';
import { extractFromText } from '../../src/services/pdfExtract';

const TEXT = `... NUM. PEDIMENTO: 25 85 1653 5001684 ...
SEGUNDA SUBDIVISION DE LA GUIA MASTER NO. 369-94268462 ... 34 BULTOS CON UN PESO DE 808 KG. SE RELACIONA CON LOS PEDIMENTOS 25 85 1653 5001668 Y 25 85 1653 5001685.
GUIA JMX101245831553 VALOR 60.110 USD NOMBRE MAURICIO TORRES MONTEJO RFC-CURP TOMM020922D40
GUIA JMX101255006278 VALOR 54.710 USD NOMBRE BEATRIZ VILLEGAS MUNOZ RFC-CURP VIMB420426SE1`;

describe('extractFromText', () => {
  it('extracts covered guías and subdivisión info', () => {
    const r = extractFromText(TEXT);
    expect(r.coveredGuias).toEqual(['JMX101245831553', 'JMX101255006278']);
    expect(r.subdivision.ordinal).toBe(2);
    expect(r.subdivision.masterGuide).toBe('369-94268462');
    expect(r.subdivision.siblings).toEqual(['258516535001668', '258516535001685']);
  });
});
