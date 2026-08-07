// Cotejo — the red-flag engine (PRD-02 R5).
//
// The whole point of duplicating data between the prealerta email, the manifest, the AWB and the
// flight feed is to be able to disagree with it. Fernando derived these rules live in the 1-Aug
// meeting: "si no concuerdan estos datos con el manifiesto, tengo un red flag".
//
// Deterministic and version-stamped, like shared/risk/ruleset.ts, because a finding shown to
// Anticorrupción has to be reproducible on demand: same inputs, same discrepancies, same ruleset
// hash. Nothing here may consult an LLM.
//
// A discrepancy NEVER blocks the creation of the caso. Refusing the email would lose the shipment,
// which is the opposite of the goal — the flag is recorded, notified and fed to the contingency
// engine (PRD-02 principle P1).

export const COTEJO_RULESET_VERSION = '2026-08a';

/**
 * The nine rules. Only the flight rules are IMPLEMENTED so far; the manifest rules need the manifest
 * ingested and reconciled against the prealerta totals and are the next increment. They are listed
 * here so the vocabulary is fixed and the gap is explicit rather than forgotten.
 */
export const CODIGOS_DISCREPANCIA = {
  /** cartones del correo ≠ del manifiesto — PENDIENTE */
  PA_01: 'PA-01',
  /** piezas del correo ≠ del manifiesto — PENDIENTE */
  PA_02: 'PA-02',
  /** peso del correo ≠ del manifiesto (con tolerancia) — PENDIENTE */
  PA_03: 'PA-03',
  /** el vuelo declarado no corresponde a la ruta declarada — IMPLEMENTADA */
  PA_04: 'PA-04',
  /** el ETA declarado es inconsistente con el itinerario real — IMPLEMENTADA */
  PA_05: 'PA-05',
  /** piezas totales ≠ suma de piezas por caja del manifiesto — PENDIENTE */
  PA_06: 'PA-06',
  /** la guía máster ya existe en otra operación abierta — PENDIENTE */
  PA_07: 'PA-07',
  /** el remitente no resuelve a ningún cliente conocido — PENDIENTE */
  PA_08: 'PA-08',
  /** consignada a otra agencia aduanal, falta CSA — PENDIENTE */
  PA_09: 'PA-09',
  /** el vuelo declarado no pudo verificarse contra ninguna fuente — IMPLEMENTADA */
  PA_10: 'PA-10',
} as const;

export type CodigoDiscrepancia = (typeof CODIGOS_DISCREPANCIA)[keyof typeof CODIGOS_DISCREPANCIA];
export type SeveridadDiscrepancia = 'error' | 'advertencia' | 'informativa';

export interface Discrepancia {
  codigo: CodigoDiscrepancia;
  severidad: SeveridadDiscrepancia;
  /** Human-readable, Spanish, shown directly in the UI. */
  mensaje: string;
  /** Machine-readable evidence: what we compared and what each side said. */
  detalle?: Record<string, unknown>;
}

export interface VueloDeclarado {
  numeroVuelo: string | null;
  origenIata: string | null;
  destinoIata: string | null;
  etaPais: string | null;
}

export interface VueloObservado {
  origenIata: string | null;
  destinoIata: string | null;
  etaProgramado: string | null;
  etaEstimado: string | null;
  arriboReal: string | null;
  estado: string;
  fuente: string | null;
  /** False when the provider could only give position, not an itinerary. */
  tieneItinerario: boolean;
  /**
   * Whether a position was actually SEEN. A position-only provider returns a snapshot even when it
   * found nothing — it is recording that it looked — and without this flag that empty snapshot masks
   * PA-10, so an unidentifiable flight reads as clean. Which is the worst possible outcome: it is
   * exactly the case a human needs to be told about.
   */
  posicionVista?: boolean;
}

/** Hours of divergence between declared and real ETA before PA-05 fires. */
export const ETA_TOLERANCIA_HORAS_DEFAULT = 6;

/**
 * PA-04, PA-05 and PA-10 — everything that can be judged once a flight feed has answered.
 *
 * `observado === null` means no feed could identify the flight. That is PA-10 and it is deliberately
 * only a warning: the commonest cause is a prealerta that declares bare digits ("160") or a carrier
 * outside the IATA→ICAO table, neither of which implies wrongdoing. What it must NOT do is silently
 * pass, because then an unverifiable flight looks identical to a verified one.
 */
export function cotejarVuelo(
  declarado: VueloDeclarado,
  observado: VueloObservado | null,
  opts: { etaToleranciaHoras?: number } = {},
): Discrepancia[] {
  const out: Discrepancia[] = [];
  const tol = opts.etaToleranciaHoras ?? ETA_TOLERANCIA_HORAS_DEFAULT;

  // Nothing came back at all, OR something came back that observed nothing: no itinerary and no
  // position means the flight was not identified, whatever shape the response had.
  const nadaObservado = !observado || (!observado.tieneItinerario && !observado.posicionVista);
  if (nadaObservado) {
    out.push({
      codigo: CODIGOS_DISCREPANCIA.PA_10,
      severidad: 'advertencia',
      mensaje: 'El vuelo declarado no pudo verificarse contra ninguna fuente externa.',
      detalle: {
        numeroVueloDeclarado: declarado.numeroVuelo,
        fuente: observado?.fuente ?? null,
      },
    });
    return out;
  }

  // PA-04 — route consistency. Only assert a mismatch when BOTH sides actually stated a value;
  // a missing value is an unknown, not a contradiction.
  const pairs: Array<[string, string | null, string | null]> = [
    ['origen', declarado.origenIata, observado.origenIata],
    ['destino', declarado.destinoIata, observado.destinoIata],
  ];
  for (const [lado, dec, obs] of pairs) {
    if (dec && obs && dec.toUpperCase() !== obs.toUpperCase()) {
      out.push({
        codigo: CODIGOS_DISCREPANCIA.PA_04,
        severidad: 'error',
        mensaje: `El ${lado} del vuelo real (${obs}) no coincide con el declarado (${dec}).`,
        detalle: { lado, declarado: dec, observado: obs, fuente: observado.fuente },
      });
    }
  }

  // PA-05 — ETA consistency. Compare against the best real figure available, preferring an actual
  // arrival, then an estimate, then the published schedule.
  const realEta = observado.arriboReal ?? observado.etaEstimado ?? observado.etaProgramado;
  if (declarado.etaPais && realEta) {
    const decMs = Date.parse(declarado.etaPais);
    const realMs = Date.parse(realEta);
    if (Number.isFinite(decMs) && Number.isFinite(realMs)) {
      const diffH = Math.abs(realMs - decMs) / 3_600_000;
      if (diffH > tol) {
        out.push({
          codigo: CODIGOS_DISCREPANCIA.PA_05,
          severidad: 'advertencia',
          mensaje:
            `El ETA declarado difiere ${diffH.toFixed(1)} h del itinerario real ` +
            `(tolerancia ${tol} h).`,
          detalle: {
            declarado: declarado.etaPais,
            observado: realEta,
            diferenciaHoras: Number(diffH.toFixed(2)),
            base: observado.arriboReal ? 'arribo_real' : observado.etaEstimado ? 'eta_estimado' : 'eta_programado',
          },
        });
      }
    }
  } else if (declarado.etaPais && !observado.tieneItinerario) {
    // Position-only providers (ADS-B) cannot answer this. Say so instead of implying the ETA checked
    // out — the distinction between "verified" and "unverifiable" is the entire value of the cotejo.
    out.push({
      codigo: CODIGOS_DISCREPANCIA.PA_05,
      severidad: 'informativa',
      mensaje:
        'El ETA declarado no pudo compararse: la fuente de vuelo sólo aporta posición, no itinerario.',
      detalle: { declarado: declarado.etaPais, fuente: observado.fuente },
    });
  }

  return out;
}

/** Convenience for the UI: does this set contain anything that should read as a hard red flag? */
export function tieneError(ds: Discrepancia[]): boolean {
  return ds.some((d) => d.severidad === 'error');
}

// ---------------------------------------------------------------------------
// Manifest rules — PA-01, PA-02, PA-03.
//
// These are the red flags Fernando derived live in the meeting: "si no concuerdan estos datos con el
// manifiesto, tengo un red flag". The email states totals; the manifest states the detail; they must
// agree.
// ---------------------------------------------------------------------------

/** Default weight tolerance, as a fraction. Weights legitimately drift with rounding and units. */
export const PESO_TOLERANCIA_PCT_DEFAULT = 0.005;

export interface TotalesDeclarados {
  cartones: number | null;
  piezas: number | null;
  pesoKg: number | null;
}

export interface TotalesManifiesto {
  /** Null when the manifest offers no basis for a carton count — then PA-01 is not evaluable. */
  cartones: number | null;
  piezas: number;
  pesoKg: number;
  lineas: number;
}

/**
 * PA-01 (cartones), PA-02 (piezas), PA-03 (peso).
 *
 * Counts are compared exactly — a discrepancy of one carton is a real discrepancy. Weight gets a
 * proportional tolerance because kilos legitimately drift with rounding and unit conversion, whereas
 * a piece count does not.
 *
 * Anything the email did not declare, or the manifest cannot supply, is reported as NOT EVALUABLE
 * rather than passed over. That matters here more than anywhere else in the system: a silent pass on
 * PA-02 is indistinguishable from a verified match, and the whole point of the exercise is that the
 * authority can tell those two apart.
 *
 * ON PA-06 — deliberately not implemented. The rule was "piezas totales ≠ suma de piezas por caja".
 * In the data model we actually have, the manifest's piece total IS the sum of its line quantities, so
 * the check would compare a number against itself and always pass — a rule that can never fail is
 * worse than an absent one, because it looks like coverage. It becomes real only if the manifiesto
 * turns out to carry its own declared total as a separate field, which the outstanding sample (Q1)
 * will settle.
 */
export function cotejarManifiesto(
  declarado: TotalesDeclarados,
  manifiesto: TotalesManifiesto | null,
  opts: { pesoToleranciaPct?: number } = {},
): Discrepancia[] {
  const out: Discrepancia[] = [];
  if (!manifiesto) {
    out.push({
      codigo: CODIGOS_DISCREPANCIA.PA_01,
      severidad: 'advertencia',
      mensaje: 'No se pudo cotejar contra el manifiesto: no hay manifiesto asociado a la operación.',
    });
    return out;
  }

  const exact: Array<[CodigoDiscrepancia, string, number | null, number | null]> = [
    [CODIGOS_DISCREPANCIA.PA_01, 'cartones', declarado.cartones, manifiesto.cartones],
    [CODIGOS_DISCREPANCIA.PA_02, 'piezas', declarado.piezas, manifiesto.piezas],
  ];
  for (const [codigo, campo, dec, man] of exact) {
    if (dec === null || dec === undefined) {
      out.push({
        codigo,
        severidad: 'informativa',
        mensaje: `No evaluable: la prealerta no declaró ${campo}.`,
        detalle: { campo, manifiesto: man },
      });
      continue;
    }
    if (man === null || man === undefined) {
      out.push({
        codigo,
        severidad: 'informativa',
        mensaje: `No evaluable: el manifiesto no aporta ${campo}.`,
        detalle: { campo, declarado: dec },
      });
      continue;
    }
    if (dec !== man) {
      out.push({
        codigo,
        severidad: 'error',
        mensaje: `Los ${campo} de la prealerta (${dec}) no coinciden con el manifiesto (${man}).`,
        detalle: { campo, declarado: dec, manifiesto: man, diferencia: man - dec },
      });
    }
  }

  const tol = opts.pesoToleranciaPct ?? PESO_TOLERANCIA_PCT_DEFAULT;
  if (declarado.pesoKg === null || declarado.pesoKg === undefined) {
    out.push({
      codigo: CODIGOS_DISCREPANCIA.PA_03,
      severidad: 'informativa',
      mensaje: 'No evaluable: la prealerta no declaró peso.',
      detalle: { manifiesto: manifiesto.pesoKg },
    });
  } else if (manifiesto.pesoKg <= 0) {
    out.push({
      codigo: CODIGOS_DISCREPANCIA.PA_03,
      severidad: 'informativa',
      mensaje: 'No evaluable: el manifiesto no aporta peso.',
      detalle: { declarado: declarado.pesoKg },
    });
  } else {
    // Relative to the larger side, so the tolerance cannot be gamed by declaring a tiny weight.
    const base = Math.max(Math.abs(declarado.pesoKg), Math.abs(manifiesto.pesoKg));
    const diff = Math.abs(manifiesto.pesoKg - declarado.pesoKg);
    if (diff / base > tol) {
      out.push({
        codigo: CODIGOS_DISCREPANCIA.PA_03,
        severidad: 'error',
        mensaje:
          `El peso de la prealerta (${declarado.pesoKg} kg) difiere del manifiesto ` +
          `(${manifiesto.pesoKg} kg) en ${(100 * diff / base).toFixed(2)} %, ` +
          `sobre una tolerancia de ${(100 * tol).toFixed(2)} %.`,
        detalle: {
          declarado: declarado.pesoKg,
          manifiesto: manifiesto.pesoKg,
          diferenciaKg: Number(diff.toFixed(3)),
          desviacionPct: Number((100 * diff / base).toFixed(4)),
          toleranciaPct: 100 * tol,
        },
      });
    }
  }

  return out;
}

/** Codes owned by the manifest rules, so a re-run replaces rather than accumulates them. */
export const CODIGOS_MANIFIESTO: readonly CodigoDiscrepancia[] = [
  CODIGOS_DISCREPANCIA.PA_01,
  CODIGOS_DISCREPANCIA.PA_02,
  CODIGOS_DISCREPANCIA.PA_03,
];

/** Codes owned by the flight rules. */
export const CODIGOS_VUELO: readonly CodigoDiscrepancia[] = [
  CODIGOS_DISCREPANCIA.PA_04,
  CODIGOS_DISCREPANCIA.PA_05,
  CODIGOS_DISCREPANCIA.PA_10,
];

/**
 * Merge a rule family's fresh findings into the stored set.
 *
 * Each family owns its codes and REPLACES them, leaving other families untouched. Without this, every
 * poll would append another copy of the same finding and the caso would slowly fill with duplicates;
 * and a naive full replacement would let the flight refresh erase the manifest findings.
 */
export function mergeDiscrepancias(
  existing: Discrepancia[] | null | undefined,
  nuevos: Discrepancia[],
  codigosPropios: readonly CodigoDiscrepancia[],
): Discrepancia[] {
  const own = new Set<string>(codigosPropios);
  const kept = (existing ?? []).filter((d) => !own.has(d.codigo));
  return [...kept, ...nuevos];
}
