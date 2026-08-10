// Pricing a delivered guía, as a pure function (PRD-02 §8.10, R43–R46, D17/D18).
//
// WHY THE ARITHMETIC LIVES OUTSIDE THE ROUTE. Every number this module produces is a number somebody
// will be asked to justify — to the client, and to an authority that came asking specifically
// because the industry computes it in Excel. So the rules that turn "this guía carried 2,914 pieces"
// into "this line costs $145.70" are deterministic, version-stamped and testable without a database,
// exactly like the cotejo and the replan engine. No LLM, no clock, no query.
//
// THE SHAPE MIRRORS THE CARRIER SIDE ON PURPOSE (see migration 1700005300000). What a trip costs is
// resolved from `transportista_tarifas`; what a delivery earns is resolved from `client_tarifas`,
// and both snapshot the amount onto the row that used it.

/**
 * Bumped when a pricing rule changes. Stored on the invoice so a line computed under an old rule can
 * still be re-derived — the same contract as `COTEJO_RULESET_VERSION`.
 */
export const FACTURACION_RULESET_VERSION = '2026-08a';

/**
 * The units a client rate can multiply. Mirrors the CHECK in migration 1700005300000_facturacion.ts
 * (migrations stay dependency-free by house convention); a parity test pins the two together.
 */
export const UNIDADES_TARIFA = ['pieza', 'guia', 'kg', 'carton', 'despacho'] as const;
export type UnidadTarifa = (typeof UNIDADES_TARIFA)[number];

/** A rate as stored. Dates are `YYYY-MM-DD`; `precio` is a number by the time it gets here. */
export interface TarifaCliente {
  id: string;
  concepto: string;
  unidad: UnidadTarifa;
  precio: number;
  moneda: string;
  vigenciaDesde: string | null;
  vigenciaHasta: string | null;
  activo: boolean;
}

/** What a guía declares. Any of these may be absent — that is the normal case, not an error. */
export interface CantidadesGuia {
  piezas: number | null;
  cartones: number | null;
  pesoKg: number | null;
}

/** Is this rate in force on `fecha` (YYYY-MM-DD)? Open-ended in either direction is still in force. */
export function tarifaVigenteEn(t: TarifaCliente, fecha: string): boolean {
  if (!t.activo) return false;
  if (t.vigenciaDesde && fecha < t.vigenciaDesde) return false;
  if (t.vigenciaHasta && fecha > t.vigenciaHasta) return false;
  return true;
}

export interface ResolucionTarifa {
  tarifa: TarifaCliente | null;
  /**
   * True when more than one rate applied and the tie was broken by rule rather than by the data
   * saying so. Surfaced, never hidden: two overlapping active rates for the same concept is a
   * catalog error somebody has to fix, and silently picking one is how a client gets billed at a
   * price nobody agreed to (discipline 6).
   */
  ambigua: boolean;
  /** Every rate that applied, in the resolution order, so the choice can be re-derived. */
  candidatas: TarifaCliente[];
}

/**
 * Which rate applies to this client on this date.
 *
 * THE TIEBREAK IS "MOST RECENTLY AGREED WINS", not "cheapest". The carrier side breaks ties by the
 * lowest rate because a cheaper truck is unambiguously better for us; the revenue side must not,
 * because picking the lowest of two candidate prices would systematically undercharge, and
 * undercharging is one of the two findings R45 exists to raise. A bounded window beats an open-ended
 * standing rate for the same reason a destination-specific carrier rate beats the general one: a
 * window is somebody saying "this price, for this period", and falling back past it would ignore the
 * more specific agreement.
 */
export function resolverTarifaCliente(
  tarifas: TarifaCliente[],
  args: { unidad?: UnidadTarifa; concepto?: string; fecha: string },
): ResolucionTarifa {
  const candidatas = tarifas
    .filter((t) => tarifaVigenteEn(t, args.fecha))
    .filter((t) => (args.unidad ? t.unidad === args.unidad : true))
    .filter((t) => (args.concepto ? t.concepto === args.concepto : true))
    .sort((a, b) => {
      const acotadaA = a.vigenciaDesde != null || a.vigenciaHasta != null;
      const acotadaB = b.vigenciaDesde != null || b.vigenciaHasta != null;
      if (acotadaA !== acotadaB) return acotadaA ? -1 : 1;
      const desdeA = a.vigenciaDesde ?? '';
      const desdeB = b.vigenciaDesde ?? '';
      if (desdeA !== desdeB) return desdeA > desdeB ? -1 : 1;
      // Last resort so the order is total and the same inputs always resolve to the same row.
      return a.id.localeCompare(b.id);
    });

  return {
    tarifa: candidatas[0] ?? null,
    ambigua: candidatas.length > 1,
    candidatas,
  };
}

/**
 * How many units this guía is billed for, or `null` when the declaration cannot answer.
 *
 * `null` IS THE IMPORTANT RETURN VALUE. A guía with no declared piece count cannot be priced per
 * piece, and the honest output is a line the biller has to complete — not a zero, which would bill
 * the client nothing and read afterwards as a delivery that carried nothing. R43's chain is only
 * worth anything if every link refuses to guess.
 */
export function cantidadFacturable(unidad: UnidadTarifa, c: CantidadesGuia): number | null {
  switch (unidad) {
    case 'pieza':
      return c.piezas ?? null;
    case 'carton':
      return c.cartones ?? null;
    case 'kg':
      return c.pesoKg ?? null;
    // One guía is one guía, and one trip is one trip: the quantity is the line's existence.
    case 'guia':
    case 'despacho':
      return 1;
    default:
      return null;
  }
}

/**
 * Money, to the centavo.
 *
 * Rounded half-up on the CENT rather than left as a float, because `0.05 * 2914` is
 * 145.70000000000002 in IEEE-754 and an invoice total that disagrees with the sum of its own lines
 * by 2e-14 is a question nobody should have to answer. The rounding happens per line so the stored
 * `importe` is exactly what the client is asked to pay, and the invoice total is the sum of the
 * stored lines — never a re-multiplication that could land somewhere else.
 */
export function redondearImporte(valor: number): number {
  return Math.round((valor + Number.EPSILON) * 100) / 100;
}

export function calcularImporte(cantidad: number, precioUnitario: number): number {
  return redondearImporte(cantidad * precioUnitario);
}

/**
 * R45 — the control that reads in both directions.
 *
 * Fernando's framing in the meeting: charging MORE than the contracted rate is abuse of the client;
 * charging LESS is a possible arrangement with them. Both are findings, so this returns the signed
 * difference and never an absolute one. `null` when there was no contracted rate to compare against
 * — which is itself the finding, and is reported as such rather than as "within tariff".
 */
export function desviacionTarifa(
  precioUnitario: number,
  precioContratado: number | null,
): number | null {
  if (precioContratado == null) return null;
  return redondearImporte(precioUnitario - precioContratado);
}

export interface LineaPropuesta {
  concepto: string;
  unidad: UnidadTarifa;
  cantidad: number | null;
  precioUnitario: number | null;
  precioContratado: number | null;
  importe: number | null;
  moneda: string | null;
  clientTarifaId: string | null;
  /** Why this line cannot be billed as-is, in Spanish, or `null` when it can. */
  advertencia: string | null;
}

/**
 * Price one guía: resolve the rate, take the quantity it multiplies, and compute the line.
 *
 * A line that cannot be computed comes back with nulls and an `advertencia` rather than being
 * dropped. A dropped line is a delivery that quietly never gets invoiced, which is the failure mode
 * that made the authority ask for this in the first place.
 */
export function proponerLinea(args: {
  tarifas: TarifaCliente[];
  cantidades: CantidadesGuia;
  fecha: string;
  unidad?: UnidadTarifa;
  concepto?: string;
}): LineaPropuesta {
  const { tarifa, ambigua } = resolverTarifaCliente(args.tarifas, {
    unidad: args.unidad,
    concepto: args.concepto,
    fecha: args.fecha,
  });

  if (!tarifa) {
    return {
      concepto: args.concepto ?? 'Servicio de despacho',
      unidad: args.unidad ?? 'pieza',
      cantidad: null,
      precioUnitario: null,
      precioContratado: null,
      importe: null,
      moneda: null,
      clientTarifaId: null,
      advertencia:
        'El cliente no tiene tarifa vigente para esta fecha: no hay precio contratado con el que cobrar.',
    };
  }

  const cantidad = cantidadFacturable(tarifa.unidad, args.cantidades);
  if (cantidad == null) {
    return {
      concepto: tarifa.concepto,
      unidad: tarifa.unidad,
      cantidad: null,
      precioUnitario: tarifa.precio,
      precioContratado: tarifa.precio,
      importe: null,
      moneda: tarifa.moneda,
      clientTarifaId: tarifa.id,
      advertencia: `La guía no declara la cantidad que cobra la tarifa (${tarifa.unidad}): no se factura una cantidad inventada.`,
    };
  }

  return {
    concepto: tarifa.concepto,
    unidad: tarifa.unidad,
    cantidad,
    precioUnitario: tarifa.precio,
    precioContratado: tarifa.precio,
    importe: calcularImporte(cantidad, tarifa.precio),
    moneda: tarifa.moneda,
    clientTarifaId: tarifa.id,
    advertencia: ambigua
      ? 'Hay más de una tarifa vigente que aplica; se tomó la más recientemente pactada. Revisa el catálogo de tarifas del cliente.'
      : null,
  };
}
