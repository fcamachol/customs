import { describe, expect, it } from 'vitest';
import { extractFromText } from './index';

// Layout A (subdivision pedimento): covered guías come from partida observations; the
// (GUIA/ORDEN EMBARQUE) list has only the master. Observations wrap across lines.
const SUBDIVISION_STYLE = `
NO. (GUIA/ORDEN EMBARQUE)/ID: 157-09213912 M
CLAVE/COMPL. IDENTIFICADOR COMPLEMENTO 1 COMPLEMENTO 2 COMPLEMENTO 3
OBSERVACIONES A NIVEL PARTIDA
GUIA 6051325623510 VALOR 182.200 USD NOMBRE ARTURO MENDOZA ESPINOSA
RFC-CURP MEEA751207KC4
OBSERVACIONES A NIVEL PARTIDA
GUIA 6051325142556 VALOR 81.830 USD NOMBRE MARTIN CERVANTES COYOTE
RFC-CURP CECM421111HD9
`;

// Layout B (consolidado): no GUIA/VALOR observations at all; covered guías come from the
// `<value> <M|H>` list and the master guide from its M entry.
const CONSOLIDADO_STYLE = `
NUMERO (GUIA/ORDEN EMBARQUE) / ID:695-55186703 	M 	JMX300626233436 	H 	JMX300639542841 	H
JMX300651162685 	H
MARCAS, NUMEROS Y TOTAL DE BULTOS:134
OBSERVACIONES A NIVEL PARTIDA
JMX300626233436 CONSIGNATARIO: AZRIEL ORDONEZ OOVA930117R12
`;

describe('extractFromText — covered guías across layouts', () => {
  it('derives coveredGuias from observation lines when the list has no houses', () => {
    const out = extractFromText(SUBDIVISION_STYLE);
    expect(out.coveredGuias).toEqual(['6051325623510', '6051325142556']);
    expect(out.subdivision.masterGuide).toBe('157-09213912');
  });
  it('derives coveredGuias from the M/H guía list when observations have no GUIA lines', () => {
    const out = extractFromText(CONSOLIDADO_STYLE);
    expect(out.coveredGuias).toEqual(['JMX300626233436', 'JMX300639542841', 'JMX300651162685']);
    expect(out.subdivision.masterGuide).toBe('695-55186703');
  });
});
