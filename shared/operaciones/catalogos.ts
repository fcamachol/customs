// Static vocabularies for despacho and transport (PRD-02 §8.6, R21–R29).
//
// Same contract as shared/operaciones/estados.ts: these arrays are the single source of truth for
// the app layer, and the DB CHECK constraints in server/migrations/1700004900000_* and
// 1700005000000_despachos.ts spell the same values out inline (migrations stay dependency-free by
// house convention). The `despachoCatalogosMatchMigration` test pins the pairing so a drift fails in
// CI instead of at runtime in production.

/**
 * The unit-type glossary (R23 / decision D8).
 *
 * Alfonso asked for the WHOLE glossary even though in practice it is almost always a tracto. That is
 * not completeness for its own sake: the glossary is what makes decision D7 mechanically enforceable.
 * You cannot ask "which transportista?" until you have said "which unit type?", and a menu that only
 * offered `tracto` would quietly push every small load onto a full trailer — the exact cost the
 * ordering was chosen to avoid.
 *
 * `t3_5` is spelled with an underscore because it is an identifier, not a label; the label carries
 * the tonnage the operator actually says out loud.
 */
export const TIPOS_UNIDAD = [
  { id: 'tracto', label: 'Tracto' },
  { id: 'torton', label: 'Tortón' },
  { id: 'rabon', label: 'Rabón' },
  { id: 't3_5', label: '3.5 toneladas' },
  { id: 'silverado', label: 'Silverado' },
  { id: 'cargo_van', label: 'Cargo van' },
] as const;

export type TipoUnidad = (typeof TIPOS_UNIDAD)[number]['id'];

/** The ids alone, in glossary order — what the CHECK constraints and the zod enums are built from. */
export const TIPOS_UNIDAD_IDS = TIPOS_UNIDAD.map((t) => t.id) as readonly TipoUnidad[];

export function etiquetaTipoUnidad(id: string): string {
  return TIPOS_UNIDAD.find((t) => t.id === id)?.label ?? id;
}

/**
 * The despacho lifecycle (R21) — the finite state machine that replaces the Excel status formula.
 *
 * Luis asked to reuse the spreadsheet's formula; Fernando's answer was that there is no spreadsheet,
 * only "tell me what you want to happen" (§2.6). This array is that answer. Ten states in physical
 * order plus two that are not on the line: `cancelado` (terminal, reachable from anywhere) and
 * `en_espera` (the pause — a contingency stopped this trip before it committed to a load).
 *
 * The order matters and is load-bearing: `ORDEN_ESTADO_DESPACHO` below is derived from it.
 */
export const ESTADOS_DESPACHO = [
  'planeado',
  'solicitado',
  'confirmado',
  'en_patio',
  'en_aduana',
  'cargando',
  'cargado',
  'modulado',
  'en_transito',
  'entregado',
  'cancelado',
  'en_espera',
] as const;
export type EstadoDespacho = (typeof ESTADOS_DESPACHO)[number];

/**
 * The happy path, in the order a real trip walks it. `cancelado` and `en_espera` are deliberately
 * absent: they are not positions on the line, they are ways of leaving it.
 */
export const ORDEN_ESTADO_DESPACHO = [
  'planeado',
  'solicitado',
  'confirmado',
  'en_patio',
  'en_aduana',
  'cargando',
  'cargado',
  'modulado',
  'en_transito',
  'entregado',
] as const;

const INDICE_DESPACHO = new Map<EstadoDespacho, number>(
  ORDEN_ESTADO_DESPACHO.map((e, i) => [e as EstadoDespacho, i]),
);

/** Position on the happy path, or -1 for the two off-line states. */
function idx(estado: EstadoDespacho): number {
  return INDICE_DESPACHO.get(estado) ?? -1;
}

/**
 * Guard for the despacho FSM. Same shape and same discipline as `canAdvanceEtapa`: forward only,
 * repeats are a no-op the caller should skip rather than a transition.
 *
 * THE TWO OFF-LINE STATES, and why each rule is what it is:
 *
 * `cancelado` is reachable from any non-terminal state and is terminal itself. A trip can die at any
 * point, and a cancelled trip that could be un-cancelled would let somebody quietly resurrect a
 * charge nobody re-approved.
 *
 * `en_espera` may only be entered BEFORE `cargando`. Once cargo is physically moving onto the unit
 * the trip is committed: the transportista is on the clock and the flete is owed whether or not the
 * load finishes, so "on hold" would be a fiction that hides a cost. A contingency discovered mid-load
 * is a `cancelado` (somebody pays) or it runs to `cargado` — never a pause.
 *
 * RESUMING is the interesting case, and the reason for `reanudandoDesdeEspera`. `en_espera` does not
 * remember where the trip stopped, and adding a column for it would be a second, mutable copy of a
 * fact the append-only ledger already holds. So the caller resolves the pause point from the last
 * DESPACHO_ESTADO event and passes it as `desde` with the flag set; `>=` rather than `>` because
 * un-pausing back to exactly where it stopped is the ordinary case (the truck waited, then carried
 * on). Passing `desde = 'en_espera'` is a caller bug and returns false rather than guessing.
 */
export function canAdvanceEstadoDespacho(
  desde: EstadoDespacho,
  hacia: EstadoDespacho,
  opts: { reanudandoDesdeEspera?: boolean } = {},
): boolean {
  if (desde === 'entregado' || desde === 'cancelado') return false;
  if (hacia === 'cancelado') return true;
  if (hacia === 'en_espera') {
    return desde !== 'en_espera' && idx(desde) >= 0 && idx(desde) < idx('cargando');
  }
  // Precondition violated: the caller must resolve the pause point first (see the doc comment).
  if (desde === 'en_espera') return false;
  if (opts.reanudandoDesdeEspera) return idx(hacia) >= idx(desde);
  if (desde === hacia) return false;
  return idx(hacia) > idx(desde);
}

/** States in which a despacho is still live — what the board and the plan count as "in play". */
export function esEstadoDespachoAbierto(estado: EstadoDespacho): boolean {
  return estado !== 'entregado' && estado !== 'cancelado';
}

/**
 * Signature lifecycle of a transportista convenio (R25 / decision D9).
 *
 * Fernando's commitment was that these are issued digitally signed, with no paper. There is no
 * Mexican PSC integration yet (§17), so the model records WHO signed with WHAT provider and under
 * what reference, and refuses to imply more: an unsigned convenio is `borrador` or `enviado`, never
 * silently treated as in force.
 */
export const ESTADOS_FIRMA_CONVENIO = ['borrador', 'enviado', 'firmado', 'vencido'] as const;
export type EstadoFirmaConvenio = (typeof ESTADOS_FIRMA_CONVENIO)[number];

/** Transportista lifecycle. `suspendido` is reversible, `baja` is the end of the relationship. */
export const ESTADOS_TRANSPORTISTA = ['activo', 'suspendido', 'baja'] as const;
export type EstadoTransportista = (typeof ESTADOS_TRANSPORTISTA)[number];

/**
 * Customs points this operation dispatches FROM, with their published coordinates.
 *
 * Used only as the origin of the deterministic arrival estimate (R36/D14, shared/operaciones/eta.ts).
 * Kept as a tiny explicit table rather than a general airport database because these are the two
 * points the operation actually uses — HKG→NLU is the live route (§8) and MEX is the fallback — and
 * an estimate is honest only when the reader can see exactly which fixed point it started from.
 * A destination the catalog does not know produces NO estimate; it never falls back to a guess.
 */
export const ADUANAS_ORIGEN = [
  { iata: 'NLU', nombre: 'AIFA — Felipe Ángeles', lat: 19.7411, lng: -99.0183 },
  { iata: 'MEX', nombre: 'AICM — Benito Juárez', lat: 19.4361, lng: -99.0719 },
] as const;

export function aduanaOrigen(iata: string | null | undefined): (typeof ADUANAS_ORIGEN)[number] | null {
  if (!iata) return null;
  const up = iata.trim().toUpperCase();
  return ADUANAS_ORIGEN.find((a) => a.iata === up) ?? null;
}
