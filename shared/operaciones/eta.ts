// Deterministic arrival estimate for the last leg — aduana → client delivery address (R36 / D14).
//
// WHAT DECISION D14 ACTUALLY DECIDED. Fernando proposed, and Roberto approved, that the CALCULATED
// arrival and the REAL arrival be two separate stored facts. That separation is the whole feature:
// an estimate that gets overwritten by reality is not an estimate, it is a rumour, and the number
// the client is owed an explanation for is precisely the gap between the two. `despachos` therefore
// carries `eta_calculado` and `arribo_real` side by side and neither is ever written over the other.
//
// WHY A DETERMINISTIC RULESET AND NOT A TRAFFIC API. There is no routing provider wired up (§17
// lists it as an external dependency), and the platform's second discipline is that authoritative
// values come from reproducible, version-stamped rules. So this module computes a road-time estimate
// from geometry and a time-of-day speed band, stamps `ETA_RULESET_VERSION` on the result, and — the
// part that keeps it honest — reports `metodo` and `confianza: 'baja'` plus its assumptions in
// `supuestos`, so nothing downstream can present it as an observed ETA. When a real routing provider
// is added it becomes a second `metodo` alongside this one; the stored column does not change shape.
//
// "No verificable ≠ verificado" (discipline 6) is enforced by omission: if either endpoint has no
// coordinates, this returns null. It never guesses a distance, and the caller is expected to say so
// out loud rather than store a fabricated time.

export const ETA_RULESET_VERSION = '2026-08a';

export interface PuntoGeo {
  lat: number;
  lng: number;
}

/** Time-of-day speed bands for the Valle de México corridor. */
export type BandaTrafico = 'pico_matutino' | 'pico_vespertino' | 'nocturno' | 'valle';

export interface EtaEstimada {
  /** ISO instant. The estimate proper — stored in `despachos.eta_calculado`. */
  etaCalculado: string;
  /** Straight-line kilometres between the two points. Reported so the estimate is auditable. */
  distanciaLineaKm: number;
  /** Straight-line distance × the road detour factor: what the truck is assumed to actually drive. */
  distanciaRutaKm: number;
  minutosEstimados: number;
  minutosManejo: number;
  minutosFijos: number;
  velocidadKmh: number;
  banda: BandaTrafico;
  metodo: 'estimacion_deterministica';
  rulesetVersion: string;
  confianza: 'baja';
  supuestos: string[];
}

/** Mean Earth radius, kilometres. */
const RADIO_TIERRA_KM = 6371;

/**
 * Straight line → road distance. 1.30 is the conventional circuity (detour) index for a dense urban
 * road network; it is stated as a constant here, and echoed into `supuestos`, so a reader can see
 * exactly how much of the number is geometry and how much is assumption.
 */
const FACTOR_RUTA = 1.3;

/**
 * Free-flow highway speed for a loaded unit leaving a customs point, km/h. Deliberately conservative:
 * a tracto with a sealed load does not drive like a car, and an estimate that runs early is the one
 * that gets a warehouse crew standing around waiting.
 */
const VELOCIDAD_BASE_KMH = 65;

/**
 * Fixed overhead at departure, minutes: gate formalities, the caseta, and getting onto the highway.
 * Charged once and independent of distance, which is why it is not folded into the speed.
 */
const MINUTOS_FIJOS = 20;

/**
 * Speed multipliers by band. The two peaks are the ZMVM commute; nights run faster than the daytime
 * baseline. These are operating assumptions, not measurements — which is exactly why the result
 * carries `confianza: 'baja'` and names the band it used.
 */
const FACTOR_BANDA: Record<BandaTrafico, number> = {
  pico_matutino: 0.55,
  pico_vespertino: 0.5,
  nocturno: 1.15,
  valle: 1,
};

/**
 * The hour of `instante` in Mexico City local time.
 *
 * Local time, not UTC: rush hour is a local phenomenon and a server in another zone must not shift
 * the bands by six hours. Mexico abolished DST in 2022, so this is a stable offset, but the lookup
 * goes through the IANA zone anyway rather than hardcoding -6 — hardcoding an offset is how a
 * timezone bug survives a policy change.
 */
export function horaLocalMexico(instante: Date): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Mexico_City',
    hour: 'numeric',
    hour12: false,
  });
  return Number(fmt.format(instante));
}

export function bandaDeTrafico(instante: Date): BandaTrafico {
  const h = horaLocalMexico(instante);
  if (h >= 6 && h < 10) return 'pico_matutino';
  if (h >= 17 && h < 21) return 'pico_vespertino';
  if (h >= 22 || h < 5) return 'nocturno';
  return 'valle';
}

/** Great-circle distance in kilometres. */
export function distanciaHaversineKm(a: PuntoGeo, b: PuntoGeo): number {
  const rad = (g: number): number => (g * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * RADIO_TIERRA_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

function redondear(n: number, decimales: number): number {
  const f = 10 ** decimales;
  return Math.round(n * f) / f;
}

function esCoordenadaValida(p: PuntoGeo | null | undefined): p is PuntoGeo {
  return (
    !!p &&
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lng) &&
    Math.abs(p.lat) <= 90 &&
    Math.abs(p.lng) <= 180 &&
    // (0,0) is the null island every un-migrated coordinate column defaults to. Treated as missing
    // rather than as a point in the Gulf of Guinea.
    !(p.lat === 0 && p.lng === 0)
  );
}

/**
 * Estimate the arrival at the delivery address.
 *
 * Returns null — never a fallback number — when either endpoint lacks usable coordinates. The band
 * is taken from the DEPARTURE time, not from the midpoint of the trip: the leg is a couple of hours
 * at most and the traffic the unit meets is the traffic it left into, and a band that shifted
 * mid-calculation would make the result depend on itself.
 */
export function estimarArribo(input: {
  salida: Date;
  origen: PuntoGeo | null | undefined;
  destino: PuntoGeo | null | undefined;
}): EtaEstimada | null {
  const { salida, origen, destino } = input;
  if (!esCoordenadaValida(origen) || !esCoordenadaValida(destino)) return null;
  if (Number.isNaN(salida.getTime())) return null;

  const distanciaLineaKm = distanciaHaversineKm(origen, destino);
  const distanciaRutaKm = distanciaLineaKm * FACTOR_RUTA;
  const banda = bandaDeTrafico(salida);
  const velocidadKmh = VELOCIDAD_BASE_KMH * FACTOR_BANDA[banda];
  const minutosManejo = (distanciaRutaKm / velocidadKmh) * 60;
  const minutosEstimados = Math.round(minutosManejo + MINUTOS_FIJOS);

  return {
    etaCalculado: new Date(salida.getTime() + minutosEstimados * 60_000).toISOString(),
    distanciaLineaKm: redondear(distanciaLineaKm, 2),
    distanciaRutaKm: redondear(distanciaRutaKm, 2),
    minutosEstimados,
    minutosManejo: Math.round(minutosManejo),
    minutosFijos: MINUTOS_FIJOS,
    velocidadKmh: redondear(velocidadKmh, 2),
    banda,
    metodo: 'estimacion_deterministica',
    rulesetVersion: ETA_RULESET_VERSION,
    confianza: 'baja',
    supuestos: [
      `Distancia en línea recta × factor de ruta ${FACTOR_RUTA}; no se consultó un proveedor de ruteo.`,
      `Velocidad base ${VELOCIDAD_BASE_KMH} km/h ajustada por banda horaria '${banda}' (×${FACTOR_BANDA[banda]}).`,
      `${MINUTOS_FIJOS} min fijos de salida (formalidades, caseta, incorporación).`,
      'Sin datos de tráfico en vivo ni de clima: es una estimación, no un arribo observado.',
    ],
  };
}

/**
 * The comparison D14 exists to make: calculated against real.
 *
 * Positive `desviacionMin` means the unit arrived LATE. Returns null when either side is missing,
 * because "on time" is not the answer to "we never estimated it".
 */
export function desviacionArriboMin(
  etaCalculado: Date | string | null | undefined,
  arriboReal: Date | string | null | undefined,
): number | null {
  if (!etaCalculado || !arriboReal) return null;
  const eta = etaCalculado instanceof Date ? etaCalculado : new Date(etaCalculado);
  const real = arriboReal instanceof Date ? arriboReal : new Date(arriboReal);
  if (Number.isNaN(eta.getTime()) || Number.isNaN(real.getTime())) return null;
  return Math.round((real.getTime() - eta.getTime()) / 60_000);
}
