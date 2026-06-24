import { describe, expect, it } from 'vitest';
import { parseSubdivision, normPedimentoNumero } from './subdivision';

const SEGUNDA = `SEGUNDA SUBDIVISION DE LA GUIA MASTER NO. 369-94268462 DE CONFORMIDAD CON EL ARTICULO 65 DEL
REGLAMENTO DE LA LEY ADUANERA, SALIENDO DE ESTA OPERACIÓN 34 BULTOS CON UN PESO DE 808 KG. SE
RELACIONA CON LOS PEDIMENTOS 25 85 1653 5001668 Y 25 85 1653 5001685.`;

const TERCERA = `TERCERA Y ULTIMA SUBDIVISION DE LA GUIA MASTER NO. 369-94268462 DE CONFORMIDAD CON EL ARTICULO 65 DEL
REGLAMENTO DE LA LEY ADUANERA, SALIENDO DE ESTA OPERACIÓN 19 BULTOS CON UN PESO DE 454 KG. SE
RELACIONA CON LOS PEDIMENTOS 25 85 1653 5001668 Y 25 85 1653 5001684.`;

describe('normPedimentoNumero', () => {
  it('strips spaces to a 15-digit string', () => {
    expect(normPedimentoNumero('25 85 1653 5001668')).toBe('258516535001668');
  });
});

describe('parseSubdivision', () => {
  it('parses the SEGUNDA subdivisión', () => {
    const r = parseSubdivision(SEGUNDA);
    expect(r.masterGuide).toBe('369-94268462');
    expect(r.ordinal).toBe(2);
    expect(r.isLast).toBe(false);
    expect(r.bultos).toBe(34);
    expect(r.pesoBrutoKg).toBe(808);
    expect(r.siblings).toEqual(['258516535001668', '258516535001685']);
  });
  it('parses the TERCERA Y ULTIMA subdivisión and flags isLast', () => {
    const r = parseSubdivision(TERCERA);
    expect(r.ordinal).toBe(3);
    expect(r.isLast).toBe(true);
    expect(r.bultos).toBe(19);
    expect(r.siblings).toEqual(['258516535001668', '258516535001684']);
  });
  it('returns empty/nulls on non-matching text (never throws)', () => {
    const r = parseSubdivision('texto sin subdivisión');
    expect(r).toEqual({ masterGuide: null, ordinal: null, isLast: false, siblings: [], bultos: null, pesoBrutoKg: null });
  });
});
