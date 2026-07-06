import { describe, expect, it } from 'vitest';
import { parseGuiaList, parseSubdivision, normPedimentoNumero } from './subdivision';

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

// Verbatim excerpts of the "(GUIA/ORDEN EMBARQUE)/ID:" sections from two real pedimentos.
// Consolidado: master + house guías as `<value> <M|H>` pairs, terminated by the next section.
const GUIA_LIST_CONSOLIDADO = `
NUMERO (GUIA/ORDEN EMBARQUE) / ID:695-55186703 	M 	JMX300626233436 	H 	JMX300639542841 	H
JMX300651162685 	H 	JMX300651279483 	H 	JMX300652065281 	H
MARCAS, NUMEROS Y TOTAL DE BULTOS:134
Página 	de 	255	2	PEDIMENTO
JMX300656746233 	H 	JMX300657779714 	H
`;

// Subdivision-style pedimento: master only; the identificador table that follows contains
// `EP H`-style rows that must NOT be read as house guías.
const GUIA_LIST_MASTER_ONLY = `
NO. (GUIA/ORDEN EMBARQUE)/ID: 157-09213912 M
CLAVE/COMPL. IDENTIFICADOR COMPLEMENTO 1 COMPLEMENTO 2 COMPLEMENTO 3
CR 297
EM 143
EP H
`;

describe('parseGuiaList', () => {
  it('reads master (M) and house guías (H) from the consolidado list, across page breaks', () => {
    // A 255-page consolidado fragments the list with page headers; later fragments must still
    // be collected (a real upload was missing 832 of 852 guías with prefix-only consumption).
    const out = parseGuiaList(GUIA_LIST_CONSOLIDADO);
    expect(out.masterGuide).toBe('695-55186703');
    expect(out.houseGuias).toEqual([
      'JMX300626233436', 'JMX300639542841', 'JMX300651162685', 'JMX300651279483', 'JMX300652065281',
      'JMX300656746233', 'JMX300657779714',
    ]);
  });
  it('reads a master-only list and does not leak identificador "EP H" rows as guías', () => {
    const out = parseGuiaList(GUIA_LIST_MASTER_ONLY);
    expect(out.masterGuide).toBe('157-09213912');
    expect(out.houseGuias).toEqual([]);
  });
  it('returns nulls when the section is absent', () => {
    expect(parseGuiaList('PEDIMENTO SIN LISTA DE GUIAS')).toEqual({ masterGuide: null, houseGuias: [] });
  });
});
