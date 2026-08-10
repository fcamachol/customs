// Lead-time formulas — the dashboard the client's spreadsheet had a tab for (PRD-02 §14 point 7).
//
// THE POINT OF THIS FILE IS THAT IT INVENTS NOTHING. The "Dashboard" sheet of Luis's Excel computed
// warehouse time, dispatch time, transit time and total lead time from cells somebody typed in by
// hand. Every timestamp those formulas need is already captured here as an immutable, append-only
// fact with a distinct `ocurrido_at` — the flight's real arrival from AeroAPI, the warehouse release
// the tramitador pressed, the loading window, the modulación, the departure, the observed arrival at
// the client's site, the signature on the POD. So the dashboard is not new data collection; it is a
// VIEW over facts the system already refuses to let anyone edit. That is the entire difference
// between this and the spreadsheet, and it is why the formulas live in one pure, tested function
// rather than being written three times in three queries.
//
// EVERY INTERVAL IS `null` WHEN EITHER END IS MISSING — NEVER ZERO. A shipment whose POD is not
// signed yet has an UNKNOWN lead time, not a lead time of zero, and averaging zeros into a KPI is
// how a dashboard starts lying to the people who run the operation.
//
// NEGATIVE INTERVALS ARE RETURNED AS-IS, NOT CLAMPED. A negative transit means the two timestamps
// disagree — a mistyped deferred capture, a device clock, or a fact recorded out of order. Clamping
// it to zero would erase the only evidence that something needs fixing; the report shows it and
// somebody explains it.

/** Bump when a formula changes, so a stored report can still be re-derived. */
export const LEAD_TIME_RULESET_VERSION = '2026-08a';

/** Instants, as `Date`, `string` or `null` — whatever the row handed us. */
export type Instante = Date | string | null | undefined;

export interface LeadTimeEntrada {
  // --- operación (the physical chain before a truck is involved)
  /** Real landing, from the flight feed (R8/R9). */
  arriboVueloAt: Instante;
  /** The warehouse released the cargo — the fact nobody phones in (R11). */
  disponibleAt: Instante;
  /** Semáforo, and the exit from a red (R34/R35). */
  modulacionAt: Instante;
  salidaRojoAt: Instante;
  // --- despacho (the trip)
  citaAt: Instante;
  ingresoPatioAt: Instante;
  ingresoAduanaAt: Instante;
  inicioCargaAt: Instante;
  finCargaAt: Instante;
  /** The unit left the aduana. */
  salidaAt: Instante;
  etaCalculado: Instante;
  arriboReal: Instante;
  // --- entrega
  /** The client signed (R39). The only timestamp here produced outside this organisation. */
  podFirmadoAt: Instante;
}

export interface LeadTimes {
  /** Warehouse time: landing → the warehouse released the cargo. The 2h–7h gap the meeting measured. */
  almacenMin: number | null;
  /** Dispatch time: released → the unit left the aduana. Covers patio, aduana, loading and semáforo. */
  despachoMin: number | null;
  /** Transit time: left the aduana → arrived at the client's site. */
  transitoMin: number | null;
  /** Arrival → signature. A truck at the gate is not a delivery; this is how long the gate took. */
  entregaMin: number | null;
  /** LM, last mile: left the aduana → signature. `transitoMin + entregaMin`, computed end-to-end. */
  ultimaMillaMin: number | null;
  /** LT, total lead time: landing → signature. The number the client asks for. */
  leadTimeMin: number | null;
  // --- sub-metrics already earned by facts we capture
  /** R30 — cité 10:00, entró 10:05. Negative means the unit was early. */
  demoraCitaMin: number | null;
  /** Patio regulador → aduana. */
  patioAduanaMin: number | null;
  /** R31/R32 — the loading window. */
  cargaMin: number | null;
  /** R35 — time held in reconocimiento aduanero. */
  tiempoEnRojoMin: number | null;
  /** D14 — estimate against observation. Positive means late. */
  desviacionArriboMin: number | null;
  rulesetVersion: string;
}

function aFecha(v: Instante): Date | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Minutes between two instants, or `null` when either is missing. Rounded, because the inputs are
 * minute-scale operational facts and a fractional minute would be false precision.
 */
export function minutosEntre(desde: Instante, hasta: Instante): number | null {
  const a = aFecha(desde);
  const b = aFecha(hasta);
  if (!a || !b) return null;
  return Math.round((b.getTime() - a.getTime()) / 60000);
}

export function calcularLeadTimes(e: LeadTimeEntrada): LeadTimes {
  return {
    almacenMin: minutosEntre(e.arriboVueloAt, e.disponibleAt),
    despachoMin: minutosEntre(e.disponibleAt, e.salidaAt),
    transitoMin: minutosEntre(e.salidaAt, e.arriboReal),
    entregaMin: minutosEntre(e.arriboReal, e.podFirmadoAt),
    // End-to-end rather than the sum of its parts: adding two nullable legs would report `null` for
    // a trip whose arrival was never pressed but whose POD was signed, and the last mile IS known in
    // that case. The parts and the whole are shown side by side and any gap between them is a fact.
    ultimaMillaMin: minutosEntre(e.salidaAt, e.podFirmadoAt),
    leadTimeMin: minutosEntre(e.arriboVueloAt, e.podFirmadoAt),
    demoraCitaMin: minutosEntre(e.citaAt, e.ingresoPatioAt),
    patioAduanaMin: minutosEntre(e.ingresoPatioAt, e.ingresoAduanaAt),
    cargaMin: minutosEntre(e.inicioCargaAt, e.finCargaAt),
    tiempoEnRojoMin: minutosEntre(e.modulacionAt, e.salidaRojoAt),
    desviacionArriboMin: minutosEntre(e.etaCalculado, e.arriboReal),
    rulesetVersion: LEAD_TIME_RULESET_VERSION,
  };
}

/** The interval metrics, in the order the dashboard reads them. */
export const METRICAS_LEAD_TIME = [
  { id: 'almacenMin', label: 'Tiempo en almacén (min)' },
  { id: 'despachoMin', label: 'Tiempo de despacho (min)' },
  { id: 'transitoMin', label: 'Tiempo de tránsito (min)' },
  { id: 'entregaMin', label: 'Tiempo en entrega (min)' },
  { id: 'ultimaMillaMin', label: 'Última milla LM (min)' },
  { id: 'leadTimeMin', label: 'Lead time total LT (min)' },
  { id: 'demoraCitaMin', label: 'Demora contra cita (min)' },
  { id: 'patioAduanaMin', label: 'Patio → aduana (min)' },
  { id: 'cargaMin', label: 'Tiempo de carga (min)' },
  { id: 'tiempoEnRojoMin', label: 'Tiempo en rojo (min)' },
  { id: 'desviacionArriboMin', label: 'Desviación de arribo (min)' },
] as const;

export type MetricaLeadTime = (typeof METRICAS_LEAD_TIME)[number]['id'];

export interface ResumenMetrica {
  /** How many rows could answer this metric at all. The denominator, stated rather than implied. */
  muestras: number;
  promedioMin: number | null;
  medianaMin: number | null;
  minimoMin: number | null;
  maximoMin: number | null;
}

/**
 * Aggregate one metric across rows.
 *
 * `muestras` travels with every average because the two numbers mean nothing apart: "average
 * warehouse time 214 min" over three of ninety shipments is not a KPI, it is a sample somebody
 * should be told the size of. Rows that cannot answer the metric are excluded from the denominator,
 * never counted as zero — the same rule as the intervals themselves.
 */
export function resumirMetrica(valores: Array<number | null>): ResumenMetrica {
  const xs = valores.filter((v): v is number => v != null).sort((a, b) => a - b);
  if (!xs.length) {
    return { muestras: 0, promedioMin: null, medianaMin: null, minimoMin: null, maximoMin: null };
  }
  const suma = xs.reduce((a, b) => a + b, 0);
  const medio = Math.floor(xs.length / 2);
  return {
    muestras: xs.length,
    promedioMin: Math.round(suma / xs.length),
    medianaMin: xs.length % 2 ? xs[medio] : Math.round((xs[medio - 1] + xs[medio]) / 2),
    minimoMin: xs[0],
    maximoMin: xs[xs.length - 1],
  };
}

/** Every metric summarised over the same set of rows. */
export function resumirLeadTimes(filas: LeadTimes[]): Record<MetricaLeadTime, ResumenMetrica> {
  const out = {} as Record<MetricaLeadTime, ResumenMetrica>;
  for (const m of METRICAS_LEAD_TIME) {
    out[m.id] = resumirMetrica(filas.map((f) => f[m.id]));
  }
  return out;
}
