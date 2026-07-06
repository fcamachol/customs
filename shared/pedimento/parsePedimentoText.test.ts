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
DESTINO/ORIGEN: TIPO CAMBIO: PESO BRUTO: ADUANA E/S:
9 20.45680 808.000 850
PARTIDAS
99010001	001 00 0 1 6 1.000 6 CHN CHN
TRAJE
OBSERVACIONES A NIVEL PARTIDA
GUIA JMX101245831553 VALOR 60.110 USD NOMBRE MAURICIO TORRES MONTEJO RFC-CURP TOMM020922D40
99010001	002 00 0 1 6 1.000 6 CHN CHN
COJIN
OBSERVACIONES A NIVEL PARTIDA
GUIA JMX101255006278 VALOR 12.000 USD NOMBRE ANA LOPEZ RUIZ RFC-CURP PERJ800101AA8
FECHAS
04/04/2025
05/04/2025
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
      patente: '1653',      // SAMPLE now has numero + header values, so patente is extracted
      tipoCambio: 20.4568,  // and tipoCambio is extracted
      agencyRfc: null,
      entryDate: '2025-04-04',  // SAMPLE now has FECHAS block with dates
      paymentDate: '2025-04-05',
    });
  });
  it('extracts patente from the numero and tipoCambio from the value cluster', () => {
    const out = parsePedimentoText(SAMPLE);
    expect(out.header.patente).toBe('1653');     // group 3 of "25 85 1653 5001684"
    expect(out.header.tipoCambio).toBe(20.4568); // Number("20.45680")
  });
  it('extracts entry and payment dates (first=entrada, second=pago) as ISO', () => {
    const out = parsePedimentoText(SAMPLE);
    expect(out.header.entryDate).toBe('2025-04-04');
    expect(out.header.paymentDate).toBe('2025-04-05');
  });
  it('extracts clave de aduana de entrada from the ADUANA E/S value cluster', () => {
    const out = parsePedimentoText(SAMPLE);
    expect(out.header.customsEntryCode).toBe('850'); // last token of "9 20.45680 808.000 850"
  });
});

// pdf-parse reorders the page positionally, so the despacho code, the agente name and the partida
// IVA row appear out of visual order — this fixture mirrors that real layout (captured from
// 3010110.pdf, with a synthetic taxed partida IVA row added).
const SAMPLE_HEADER = `
CLAVE DE LA SECCION ADUANERA
DE DESPACHO:
AEROPUERTO INTERNACIONAL FELIPE
ÁNGELES, SANTA LUCÍA, ZUMPANGO,
ESTADO DE MÉXICO.
850
DESTINO/ORIGEN: TIPO CAMBIO: PESO BRUTO: ADUANA E/S:
9 17.10420 209.000 460
TASAS A NIVEL PEDIMENTO
23 IVA/PRV 1 16.000
CON. TASA T.T. F.P. IMPORTE
IGI 0.00000 1 0 0
IVA 33.50000 1 0 1234
NOMBRE O RAZ. SOC.: LAURA AMPARO GARCIA DE LA PEÑA
RFC: GAPL750107JEA
`;

describe('parsePedimentoText — extended capture-prefill fields', () => {
  it('extracts clave de aduana de despacho (customsClearanceCode) after the despacho address', () => {
    const out = parsePedimentoText(SAMPLE_HEADER);
    expect(out.header.customsClearanceCode).toBe('850');
  });
  it('extracts the entry aduana independently of the despacho code', () => {
    const out = parsePedimentoText(SAMPLE_HEADER);
    expect(out.header.customsEntryCode).toBe('460'); // last token of the value cluster
  });
  it('extracts the agente aduanal name (preserving accents/case)', () => {
    const out = parsePedimentoText(SAMPLE_HEADER);
    expect(out.header.agenteAduanal).toBe('LAURA AMPARO GARCIA DE LA PEÑA');
  });
  it('reads tasaImportacion from the partida IVA row, not the pedimento-level IVA/PRV', () => {
    const out = parsePedimentoText(SAMPLE_HEADER);
    expect(out.header.tasaImportacion).toBe('33.5'); // partida "IVA 33.50000", not "IVA/PRV ... 16.000"
  });
  it('leaves tasaImportacion null for an exempt pedimento (IGI 0, no partida IVA row)', () => {
    // SAMPLE has no partida IVA row — sub-$50 courier exempt case (e.g. 3010110.pdf).
    const out = parsePedimentoText(SAMPLE);
    expect(out.header.tasaImportacion).toBeNull();
  });
});

// Verbatim excerpt of pdf-parse output from a real T1 mensajería consolidado (~850 partidas,
// 695-55186703). pdf-parse linearizes this layout differently from SAMPLE_HEADER, with three
// traps: the partida tasa PRECEDES the literal "IVA" (…33.5000000000→IVA→10.00000, where
// 10.00000 is the CANTIDAD column duplicated, not a tasa); a PRV fee "330.00000" and the
// pedimento-level "16.00000 IVA/PRV" both appear before the real tipo de cambio (17.98420,
// emitted inside the ADUANA E/S cluster); and "NOMBRE O RAZ. SOC:" is followed by the patente
// on its own line before the razón social.
const SAMPLE_CONSOLIDADO = `
NUM. PEDIMENTO: 	T. OPER 	CVE. PEDIMENTO: 	REGIMEN: 	IMD
DESTINO: 	TIPO CAMBIO:
CODIGO DE ACEPTACION: 	CLAVE DE LA SECCION ADUANERA
240
FECHAS
CODIGO DE BARRAS
CONTRIB. 	CVE.T.TASA 	TASA
PAGO 	13/01/2026
PRV 	2 	330.00000
16.00000	IVA/PRV 	1
CUADRO DE LIQUIDACION
TASAS A NIVEL PEDIMENTO
ENTRADA 	13/01/2026
DE DESPACHO:
VAL. SEGUROS 	FLETES	SEGUROS 	EMBALAJES
CURP:
851780	VALOR ADUANA:
851780	PRECIO PAGADO/VALOR COMERCIAL:	7
PESO BRUTO: 	ADUANA E/S:	17.98420
VALOR DOLARES: 	47,362.42
EFECTIVO	IVA 	0 	285338
26 24 3482 6001719 	IMP 	T1 	CERTIFICACIONES
9 	240	2,891.000
7
AGENTE ADUANAL, AGENCIA ADUANAL, APODERADO ADUANAL O DE ALMACEN
AUTORIZACION:
NOMBRE O RAZ. SOC:
3482
GESTORES ADUANALES DEL NORESTE Y CIA
CARLOS FRANCISCO CRUZ LARA CULC611020FT4
Clave en el RFC:
99010001 	00 	0 	6 	6 	10.000 	6 	CHN 	CHN 	491	0	1 	1	33.5000000000	IVA	10.00000
BRAZALETEPANTALONSUDADERACAMISETABLUSA DE MUJERTRAJE DE MUJERVESTIDO D 	0	1	IGI 	0.0000000000
OBSERVACIONES A NIVEL PARTIDA
GUIA JMX300626233436 VALOR 55.000 USD NOMBRE JUAN PEREZ LOPEZ RFC-CURP PELJ900101AA1
FECHAS
13/01/2026
13/01/2026
`;

describe('parsePedimentoText — real consolidado layout (values precede their labels)', () => {
  it('reads tasaImportacion from the number preceding the partida IVA label, not the CANTIDAD after it', () => {
    const out = parsePedimentoText(SAMPLE_CONSOLIDADO);
    expect(out.header.tasaImportacion).toBe('33.5');
  });
  it('skips the patente line when reading the agente aduanal razón social', () => {
    const out = parsePedimentoText(SAMPLE_CONSOLIDADO);
    expect(out.header.agenteAduanal).toBe('GESTORES ADUANALES DEL NORESTE Y CIA');
  });
  it('anchors tipoCambio to the ADUANA E/S cluster, not the first ≥4-decimal token (a PRV fee)', () => {
    const out = parsePedimentoText(SAMPLE_CONSOLIDADO);
    expect(out.header.tipoCambio).toBe(17.9842);
  });
  it('reads the entrada aduana from the destino/aduana/peso cluster after CERTIFICACIONES', () => {
    // The consolidado scatters the "DESTINO ... ADUANA E/S" value cluster: the tipo de cambio
    // lands next to the labels, while "9 240 2,891.000" (destino, aduana E/S, peso bruto) follows
    // the numero-pedimento/CERTIFICACIONES line — so the tipo-cambio-anchored cluster regex misses.
    const out = parsePedimentoText(SAMPLE_CONSOLIDADO);
    expect(out.header.customsEntryCode).toBe('240');
  });
  it('reads the despacho code from the fragmented "CLAVE DE LA SECCION ADUANERA" label', () => {
    // pdf-parse splits the visual label "CLAVE DE LA SECCION ADUANERA DE DESPACHO:" into two
    // distant fragments; the code (240) follows the first fragment, while "DE DESPACHO:" is
    // followed by unrelated columns (first digit run = 851780, the valor aduana).
    const out = parsePedimentoText(SAMPLE_CONSOLIDADO);
    expect(out.header.customsClearanceCode).toBe('240');
  });
  it('still extracts numero/patente/clave from the consolidado header', () => {
    const out = parsePedimentoText(SAMPLE_CONSOLIDADO);
    expect(out.header.numeroPedimento).toBe('262434826001719');
    expect(out.header.patente).toBe('3482');
    expect(out.header.clave).toBe('T1');
  });
});
