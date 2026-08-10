// The POD document, as a pure function (PRD-02 R28/R39, §8.5).
//
// WHY THE DOCUMENT IS BUILT HERE AND NOT IN THE ROUTE. A POD is evidence: the client signs the sheet
// the driver hands them, and six weeks later somebody has to be able to say what that sheet said.
// So the rendering is a deterministic, version-stamped function of a snapshot — same inputs, same
// bytes, every time — and the snapshot is stored in `pods.snapshot` beside the rendered file. When
// Luis finally supplies the template (Q6), `POD_LAYOUT_VERSION` moves, new PODs render the new way,
// and every historical POD still explains itself because its own basis travelled with it. Exactly
// the discipline `shared/operaciones/eta.ts` uses for the arrival estimate.
//
// NOTHING HERE READS A CLOCK OR A DATABASE. `generadoAt` is passed in, totals are computed from the
// lines given, and absent quantities stay absent. That is what makes the golden test possible and
// what keeps the document from quietly disagreeing with the ledger it was built from.

/**
 * Stamped into every snapshot. Bump when the layout changes shape — never edit a shipped layout in
 * place, because a POD is a claim about what somebody signed.
 */
export const POD_LAYOUT_VERSION = '2026-08a';

/** One guía on the truck, as the delivery sheet names it. */
export interface PodPartidaEntrada {
  guia: string | null;
  mawb: string;
  cliente: string | null;
  pedimento: string | null;
  cartonesPlaneados: number | null;
  cartonesCargados: number | null;
  piezas: number | null;
  ordenCarga: number | null;
}

/** Everything the document says about the trip. Assembled by the route from `despachos` + partidas. */
export interface PodEntrada {
  folio: string;
  despachoFolio: string;
  fechaOperacion: string;
  tipoUnidad: string;
  tipoUnidadLabel: string;
  transportista: string | null;
  placas: string | null;
  operadorNombre: string | null;
  destinoAlias: string | null;
  destinoDireccion: string | null;
  /** When the unit left the aduana and when it reached the client's site, if either is known. */
  salidaAt: string | null;
  etaCalculado: string | null;
  arriboReal: string | null;
  observaciones: string | null;
  partidas: PodPartidaEntrada[];
  generadoAt: string;
  version: number;
}

export interface PodTotales {
  guias: number;
  cartonesPlaneados: number | null;
  cartonesCargados: number | null;
  piezas: number | null;
}

export interface PodSnapshot extends PodEntrada {
  layoutVersion: string;
  totales: PodTotales;
}

/**
 * Sum a column across the lines, or `null` when NOTHING declared it.
 *
 * The distinction is the whole point and is easy to get wrong: a trip whose lines all carry `null`
 * pieces has an UNKNOWN piece count, not a piece count of zero. Printing `0` on a delivery sheet the
 * client signs would be asserting that no pieces travelled — and that same number is what R43 later
 * multiplies by the tariff. Partial data sums what is there, because a partially-declared load is
 * still a load, and the lines are printed individually right above the total.
 */
function sumaOpcional(valores: Array<number | null>): number | null {
  const presentes = valores.filter((v): v is number => v != null);
  if (!presentes.length) return null;
  return presentes.reduce((a, b) => a + b, 0);
}

/** Build the snapshot: the entry plus its totals and the layout stamp. */
export function construirPod(entrada: PodEntrada): PodSnapshot {
  const partidas = [...entrada.partidas].sort((a, b) => {
    const oa = a.ordenCarga ?? Number.MAX_SAFE_INTEGER;
    const ob = b.ordenCarga ?? Number.MAX_SAFE_INTEGER;
    if (oa !== ob) return oa - ob;
    return (a.guia ?? '').localeCompare(b.guia ?? '');
  });
  return {
    ...entrada,
    partidas,
    layoutVersion: POD_LAYOUT_VERSION,
    totales: {
      guias: partidas.length,
      cartonesPlaneados: sumaOpcional(partidas.map((p) => p.cartonesPlaneados)),
      cartonesCargados: sumaOpcional(partidas.map((p) => p.cartonesCargados)),
      piezas: sumaOpcional(partidas.map((p) => p.piezas)),
    },
  };
}

/** Column order of the load table. Exported so a test can pin it without re-deriving the layout. */
export const POD_COLUMNAS_PARTIDA = [
  'No.',
  'Guía',
  'MAWB',
  'Cliente',
  'Pedimento',
  'Cartones planeados',
  'Cartones cargados',
  'Piezas',
] as const;

const SIN_DATO = '—';

function texto(v: string | null | undefined): string {
  return v == null || v === '' ? SIN_DATO : v;
}

function numero(v: number | null | undefined): string | number {
  return v == null ? SIN_DATO : v;
}

/**
 * The document as a sheet, row by row (`XLSX.utils.aoa_to_sheet`).
 *
 * The signature block at the bottom is the reason this is an array of arrays and not a table of
 * objects: a POD is a form, not a dataset. The three lines the receiving warehouse fills in by hand
 * — name, date/hour, observations — are printed EMPTY on purpose. The system records what was signed
 * (`pods.firmado_por`, `firmado_at`) when the signed sheet comes back; pre-filling them here would
 * be this system asserting a fact only the client can produce.
 */
export function filasPod(snapshot: PodSnapshot): Array<Array<string | number | null>> {
  const filas: Array<Array<string | number | null>> = [
    ['PRUEBA DE ENTREGA (POD)'],
    ['Folio POD', snapshot.folio, '', 'Versión', snapshot.version],
    ['Despacho', snapshot.despachoFolio, '', 'Fecha de operación', snapshot.fechaOperacion],
    ['Transportista', texto(snapshot.transportista), '', 'Tipo de unidad', snapshot.tipoUnidadLabel],
    ['Placas', texto(snapshot.placas), '', 'Operador', texto(snapshot.operadorNombre)],
    ['Destino', texto(snapshot.destinoAlias), '', 'Dirección', texto(snapshot.destinoDireccion)],
    ['Salida de aduana', texto(snapshot.salidaAt), '', 'Arribo estimado', texto(snapshot.etaCalculado)],
    ['Arribo real', texto(snapshot.arriboReal), '', 'Generado', snapshot.generadoAt],
    [],
    [...POD_COLUMNAS_PARTIDA],
  ];

  snapshot.partidas.forEach((p, i) => {
    filas.push([
      p.ordenCarga ?? i + 1,
      texto(p.guia),
      p.mawb,
      texto(p.cliente),
      texto(p.pedimento),
      numero(p.cartonesPlaneados),
      numero(p.cartonesCargados),
      numero(p.piezas),
    ]);
  });

  filas.push([
    'TOTAL',
    `${snapshot.totales.guias} guía(s)`,
    '',
    '',
    '',
    numero(snapshot.totales.cartonesPlaneados),
    numero(snapshot.totales.cartonesCargados),
    numero(snapshot.totales.piezas),
  ]);

  filas.push([]);
  filas.push(['Observaciones', texto(snapshot.observaciones)]);
  filas.push([]);
  // Deliberately blank — see the doc comment.
  filas.push(['Recibí de conformidad la mercancía descrita:']);
  filas.push(['Nombre y firma', '']);
  filas.push(['Fecha y hora de recepción', '']);
  filas.push(['Observaciones del cliente', '']);
  filas.push([]);
  filas.push([`Documento generado por el Sistema de Operaciones · layout ${snapshot.layoutVersion}`]);

  return filas;
}
