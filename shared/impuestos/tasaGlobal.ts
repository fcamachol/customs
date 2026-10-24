// Resolución de la tasa global y estimado de impuesto.
//
// LA TASA NO ES UNA CONSTANTE. Viene de la tabla `tasa_vigencias` (configuración "Tasa global",
// editable sólo por Super Admin), donde cada renglón declara desde cuándo aplica, para qué tipo de
// origen y con qué porcentaje. El 33.5% que se menciona en las juntas es simplemente la tasa
// GENERAL vigente hoy; mercancía de origen TMEC paga otra, y cuando la autoridad cambia la tasa se
// agrega una vigencia nueva sin tocar el histórico.
//
// POR QUÉ IMPORTA EL HISTÓRICO: un manifiesto de agosto debe estimarse con la tasa que estaba
// vigente en agosto, no con la de hoy. Calcular con la tasa actual un documento viejo produce una
// cifra que nadie puede reproducir después, que es exactamente lo contrario de lo que este sistema
// promete.
//
// Y ESTE NÚMERO NO ES EL CÁLCULO LEGAL. El impuesto lo determina el agente aduanal; esto es un
// estimado informativo para avisarle al cliente qué esperar. Todo lo que lo muestre debe decirlo.

export type TipoOrigen = 'GENERAL' | 'TMEC';

export interface TasaVigencia {
  /** ISO YYYY-MM-DD: desde cuándo aplica este renglón. */
  startDate: string;
  originType: TipoOrigen;
  /** Porcentaje, p.ej. 33.5 — no fracción. */
  rate: number;
}

/** Países del T-MEC. Determina qué renglón de la tabla aplica. */
const PAISES_TMEC = new Set(['MX', 'US', 'CA']);

/**
 * Clasifica el origen a partir del código de país de dos letras del remitente.
 *
 * Devuelve GENERAL cuando el código falta o no se reconoce: es la tasa más alta, así que un dato
 * ausente nunca produce un estimado más barato de lo que corresponde. Subestimar el impuesto le
 * daría al cliente una expectativa que la autoridad va a desmentir.
 */
export function tipoOrigenDe(codigoPais: string | null | undefined): TipoOrigen {
  const c = (codigoPais ?? '').trim().toUpperCase();
  return PAISES_TMEC.has(c) ? 'TMEC' : 'GENERAL';
}

export interface ResolucionTasa {
  vigencia: TasaVigencia | null;
  /** Por qué no hay tasa, cuando `vigencia` es null. Nunca se cae a un valor por defecto. */
  motivo?: 'sin_tabla' | 'sin_vigencia_para_la_fecha';
}

/**
 * Busca en la tabla el renglón aplicable: el de mayor `startDate` que no sea posterior a la fecha,
 * para el tipo de origen dado.
 *
 * Si no hay ninguno, devuelve null CON MOTIVO en vez de inventar una tasa. Un estimado silencioso
 * calculado con una tasa que nadie configuró es peor que no mostrar estimado: se ve igual de
 * creíble y no lo es.
 */
export function resolverTasa(
  vigencias: TasaVigencia[] | null | undefined,
  fechaISO: string,
  origen: TipoOrigen,
): ResolucionTasa {
  if (!vigencias || vigencias.length === 0) return { vigencia: null, motivo: 'sin_tabla' };
  const fecha = fechaISO.slice(0, 10);
  const candidatas = vigencias
    .filter((v) => v.originType === origen && v.startDate.slice(0, 10) <= fecha)
    .sort((a, b) => (a.startDate < b.startDate ? 1 : -1));
  if (!candidatas.length) return { vigencia: null, motivo: 'sin_vigencia_para_la_fecha' };
  return { vigencia: candidatas[0] };
}

export interface PartidaEstimable {
  guia: string;
  valorUsd: number;
  /** Código de país de 2 letras del remitente; decide GENERAL vs TMEC. */
  codigoPaisRemitente?: string | null;
}

export interface EstimadoPartida {
  guia: string;
  valorUsd: number;
  origen: TipoOrigen;
  tasaPct: number | null;
  impuestoUsd: number | null;
  /** Presente cuando no se pudo estimar; se muestra en vez de un cero engañoso. */
  motivo?: ResolucionTasa['motivo'];
}

export interface EstimadoImpuesto {
  partidas: EstimadoPartida[];
  /** Suma de los impuestos que SÍ se pudieron estimar. */
  totalImpuestoUsd: number;
  totalValorUsd: number;
  /** Cuántas partidas quedaron sin estimar, para que el total no aparente cubrir todo. */
  sinEstimar: number;
  /** Las tasas efectivamente usadas, para poder citarlas en pantalla. */
  tasasUsadas: Array<{ origen: TipoOrigen; tasaPct: number; desde: string }>;
}

/**
 * Estima el impuesto de un conjunto de partidas.
 *
 * QUIÉN DECIDE QUÉ ENTRA: el llamador. Por decisión del 15-sep, el estimado sólo considera las
 * partidas que efectivamente van al pedimento — no toda la carga del manifiesto. Esa distinción
 * resuelve la objeción de fondo ("no puedo calcular impuestos sobre algo que no puede pasar") y es
 * la razón de que esta función reciba una lista explícita en vez de leer el manifiesto completo.
 */
export function estimarImpuesto(
  partidas: PartidaEstimable[],
  vigencias: TasaVigencia[] | null | undefined,
  fechaISO: string,
): EstimadoImpuesto {
  const usadas = new Map<string, { origen: TipoOrigen; tasaPct: number; desde: string }>();
  let totalImpuesto = 0;
  let totalValor = 0;
  let sinEstimar = 0;

  const resultado = partidas.map<EstimadoPartida>((p) => {
    const origen = tipoOrigenDe(p.codigoPaisRemitente);
    const { vigencia, motivo } = resolverTasa(vigencias, fechaISO, origen);
    totalValor += p.valorUsd;
    if (!vigencia) {
      sinEstimar += 1;
      return { guia: p.guia, valorUsd: p.valorUsd, origen, tasaPct: null, impuestoUsd: null, motivo };
    }
    const impuesto = Math.round(p.valorUsd * (vigencia.rate / 100) * 100) / 100;
    totalImpuesto += impuesto;
    usadas.set(`${origen}|${vigencia.startDate}`, {
      origen, tasaPct: vigencia.rate, desde: vigencia.startDate.slice(0, 10),
    });
    return { guia: p.guia, valorUsd: p.valorUsd, origen, tasaPct: vigencia.rate, impuestoUsd: impuesto };
  });

  return {
    partidas: resultado,
    totalImpuestoUsd: Math.round(totalImpuesto * 100) / 100,
    totalValorUsd: Math.round(totalValor * 100) / 100,
    sinEstimar,
    tasasUsadas: [...usadas.values()],
  };
}
